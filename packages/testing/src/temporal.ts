import { Connection } from '@temporalio/client';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  GenericContainer,
  Network,
  Wait,
  type StartedNetwork,
  type StartedTestContainer,
} from 'testcontainers';
import { assertDockerAvailable } from './docker.js';
import { POSTGRES_IMAGE, TEMPORAL_IMAGE } from './images.js';

export interface TemporalHandle {
  /**
   * `host:port`, dialable from THIS process — what a `Connection` connects to.
   * A mapped port, so it differs between runs; never hard-code 7233.
   */
  readonly address: string;
  /** The namespace `auto-setup` provisions on first boot. */
  readonly namespace: string;
}

/** The Temporal frontend's port INSIDE the container. Never the host's. */
const FRONTEND_PORT = 7233;

/** What `auto-setup` registers unless `DEFAULT_NAMESPACE` says otherwise. */
const NAMESPACE = 'default';

/**
 * Network aliases on the harness's own bridge network. `POSTGRES_ALIAS` is
 * load-bearing — it is the literal value of `POSTGRES_SEEDS`, which is how
 * `auto-setup` finds its datastore. `TEMPORAL_ALIAS` is not dialled by
 * anything here (the wait strategy uses loopback, for the reason recorded on
 * `BIND_ON_IP` below); it is set so `docker network inspect` names the
 * container something a human recognises during a debugging session.
 */
const TEMPORAL_ALIAS = 'temporal';
const POSTGRES_ALIAS = 'postgres';

/**
 * The same credentials `infra/docker/docker-compose.yml` gives Temporal, so
 * the two environments differ in as few places as possible. The owner role,
 * not `metrika_app`: `auto-setup` CREATEs its own `temporal` and
 * `temporal_visibility` databases and owns their schema, which a NOSUPERUSER
 * NOBYPASSRLS role deliberately cannot do.
 *
 * `BOOTSTRAP_DATABASE` is only the database the Postgres image itself creates
 * so the server has something to accept a connection to; nothing in this
 * harness stores anything in it.
 */
const OWNER = 'metrika';
const OWNER_PASSWORD = 'metrika';
const BOOTSTRAP_DATABASE = 'metrika_test';

/** Written by the globalSetup, read by every worker it forks. */
export const TEMPORAL_ADDRESS_VAR = 'METRIKA_TEST_TEMPORAL_ADDRESS';

let network: StartedNetwork | undefined;
let postgres: StartedPostgreSqlContainer | undefined;
let temporal: StartedTestContainer | undefined;
let handle: TemporalHandle | undefined;
/** Set only while a start is in flight; see `startTemporal`'s concurrency guard. */
let inFlight: Promise<TemporalHandle> | undefined;

/**
 * Generous, because this container is not just a process start: it waits for
 * Postgres, creates two databases, applies both schemas, boots four services
 * and then registers the namespace and the search attributes.
 */
const STARTUP_TIMEOUT_MS = 180_000;

/**
 * Bounded, and that is the whole point. `Connection.connect`'s default is 10s
 * anyway; it is written out because the failure this value prevents — a
 * harness that HANGS against a dead address instead of failing — reads as
 * infrastructure trouble rather than as a bug, and a reader needs to see that
 * the bound is deliberate.
 */
const CONNECT_TIMEOUT_MS = 10_000;
const RPC_DEADLINE_MS = 10_000;

function publishedHandle(): TemporalHandle | undefined {
  const address = process.env[TEMPORAL_ADDRESS_VAR];
  if (address === undefined) return undefined;
  return { address, namespace: NAMESPACE };
}

/**
 * Confirms `address` is a Temporal server this process can actually talk to,
 * before `startTemporal` hands it to anyone — not just that `.start()` exited
 * without throwing.
 *
 * Deliberately NOT the `assertTcpReachable` dial that `database.ts` uses, and
 * the difference is measured rather than stylistic: **a TCP dial to a
 * published Docker port succeeds immediately, before anything is listening
 * inside the container at all.** Measured on the compose service this harness
 * mirrors — `127.0.0.1:7233` accepted a connection the instant
 * `docker compose up -d` returned, while `netstat -ltn` inside the container
 * showed **zero** sockets on `:7233` — because docker-proxy binds the host
 * port at container creation and holds the connection open. A dial here would
 * therefore be unconditionally green and would prove nothing.
 *
 * So this makes two real RPCs instead:
 *
 * 1. `Connection.connect` itself, which calls `GetSystemInfo` — that is a
 *    round trip through the gRPC frontend, so it cannot be satisfied by a
 *    proxy accepting a socket.
 * 2. `DescribeNamespace` for `default`, which is the part `auto-setup`
 *    provisions LAST. Between the frontend accepting connections and the
 *    namespace existing there is a window in which every client call fails
 *    with `NamespaceNotFound`, and a harness that returns inside that window
 *    hands out an address whose first real use fails.
 *
 * `interceptors: []` removes the SDK's default retry interceptor. Retrying is
 * right for an application and wrong for a probe: it converts "this address is
 * dead" from a fast, legible error into a slow one, and the mutation this
 * harness is checked against — point it at a dead port — must fail rather than
 * hang.
 *
 * Failures are re-thrown wrapped, because grpc-js's own message is
 * `Failed to connect before the deadline` and nothing else: no address, no
 * mention of Temporal, no mention of this package. That lands in a caller's
 * console three layers from here with nothing to grep for. `database.ts`'s
 * `assertTcpReachable` already names `${host}:${port}` in its timeout; this is
 * the same courtesy, with `cause` preserved so the gRPC status is still there
 * for anyone who wants it.
 */
async function assertTemporalReachable(address: string): Promise<void> {
  let connection: Connection;
  try {
    connection = await Connection.connect({
      address,
      connectTimeout: CONNECT_TIMEOUT_MS,
      interceptors: [],
    });
  } catch (error: unknown) {
    throw new Error(
      `startTemporal: no Temporal server answered at ${address} within ` +
        `${String(CONNECT_TIMEOUT_MS)}ms (the container started, but the address ` +
        `it published is not serving)`,
      { cause: error },
    );
  }

  try {
    await connection.withDeadline(Date.now() + RPC_DEADLINE_MS, async () => {
      await connection.workflowService.describeNamespace({ namespace: NAMESPACE });
    });
  } catch (error: unknown) {
    throw new Error(
      `startTemporal: connected to ${address}, but namespace "${NAMESPACE}" is ` +
        `not usable — auto-setup registers it last, so this is the wait strategy ` +
        `having returned too early`,
      { cause: error },
    );
  } finally {
    await connection.close();
  }
}

/**
 * Returns the server the Vitest `globalSetup` already started, if there is
 * one; otherwise starts its own.
 *
 * Same two-path shape, and same reasons, as `startDatabase` — read the long
 * comment there. In short: `globalSetup` is what gives a whole RUN one
 * container, because `fileParallelism: false` serialises files without merging
 * their module registries, so module state alone yields one container per
 * file. The env-var branch is what makes a developer running a single file
 * through an editor plugin work anyway, without ever starting a second server
 * when a published one exists.
 */
export async function startTemporal(): Promise<TemporalHandle> {
  if (handle !== undefined) return handle;

  const published = publishedHandle();
  if (published !== undefined) {
    handle = published;
    return handle;
  }

  // Concurrency guard, for the same reason `startDatabase` has one: two
  // callers racing the first, container-less call would otherwise each start
  // their own stack, and the loser's network and two containers would be
  // orphaned with nothing left to stop them. `??=` evaluates its right-hand
  // side only on the first call to reach this line, and JS is synchronous
  // until the first `await`, so every other caller in the race sees `inFlight`
  // already set.
  inFlight ??= startContainers();
  try {
    handle = await inFlight;
  } finally {
    inFlight = undefined;
  }
  return handle;
}

async function startContainers(): Promise<TemporalHandle> {
  await assertDockerAvailable();

  // A dedicated network, not the default bridge: `auto-setup` reaches Postgres
  // by name (`POSTGRES_SEEDS`), and only a user-defined network gives
  // containers embedded DNS for each other's aliases.
  network = await new Network().start();

  // `auto-setup` supports exactly four datastores — mysql8, postgres12,
  // postgres12_pgx and cassandra (read out of the image's own
  // /etc/temporal/auto-setup.sh). There is no sqlite or in-memory option, so
  // a Postgres is not an optional extra here: it is the only way to get a
  // server at all.
  postgres = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withNetwork(network)
    .withNetworkAliases(POSTGRES_ALIAS)
    .withUsername(OWNER)
    .withPassword(OWNER_PASSWORD)
    .withDatabase(BOOTSTRAP_DATABASE)
    .start();

  temporal = await new GenericContainer(TEMPORAL_IMAGE)
    .withNetwork(network)
    .withNetworkAliases(TEMPORAL_ALIAS)
    .withEnvironment({
      DB: 'postgres12',
      // FIVE variables, not four. `DB_PORT` defaults to **3306** — MySQL's
      // port — and omitting it does not fail: auto-setup.sh loops
      // `until nc -z "${POSTGRES_SEEDS}" 3306`, so the container sits `Up`
      // logging "Waiting for PostgreSQL" until this harness's startup timeout
      // expires, three minutes later, with a message about a wait strategy
      // rather than about a port. See ADR-0027.
      DB_PORT: '5432',
      POSTGRES_SEEDS: POSTGRES_ALIAS,
      POSTGRES_USER: OWNER,
      POSTGRES_PWD: OWNER_PASSWORD,
      // A sixth, and without it this harness does not work at all — this is
      // the one thing it needs that a naive port of the compose service would
      // not have. MEASURED, 45 seconds of `connection refused` against a
      // server that was up the whole time:
      //
      // testcontainers, when a container has network ALIASES, deliberately
      // leaves `HostConfig.NetworkMode` unset and connects the custom network
      // afterwards (generic-container.js: `NetworkMode = aliases.length > 0 ?
      // undefined : networkMode`). The container is therefore on TWO networks
      // — the default bridge and ours. `entrypoint.sh` derives `BIND_ON_IP`
      // from `getent hosts $(hostname)`, which returns the FIRST address, so
      // temporal-server binds only the default-bridge interface (172.17.x)
      // while the `temporal` alias resolves to the custom network (172.19.x).
      // The server is healthy and unreachable at the only name it has.
      //
      // `0.0.0.0` makes it bind every interface, which makes the loopback
      // probe below correct no matter how many networks it ends up on.
      // `entrypoint.sh` special-cases this value and sets
      // TEMPORAL_BROADCAST_ADDRESS to a real address, so ring membership on
      // the single node still works.
      BIND_ON_IP: '0.0.0.0',
    })
    .withExposedPorts(FRONTEND_PORT)
    // Byte-for-byte the check `infra/docker/docker-compose.yml`'s healthcheck
    // runs, for the same reason: testcontainers' default,
    // `Wait.forListeningPorts()`, is satisfied by a bound socket, and this
    // image binds its ports before the `default` namespace exists. MEASURED,
    // two consecutive execs on a cold container: the first returned
    // `Namespace default is not found`, the second succeeded. A port-based
    // strategy returns inside that window and hands out an address whose first
    // real use fails.
    .withWaitStrategy(
      Wait.forSuccessfulCommand(
        `temporal operator namespace describe --namespace ${NAMESPACE} ` +
          `--address 127.0.0.1:${String(FRONTEND_PORT)}`,
      ),
    )
    .withStartupTimeout(STARTUP_TIMEOUT_MS)
    .start();

  const address = `${temporal.getHost()}:${String(temporal.getMappedPort(FRONTEND_PORT))}`;

  // The wait strategy proved the server is usable from INSIDE the container.
  // It says nothing about the mapped port in `address`, which is the only
  // thing any caller will ever use — a wrong port here would surface three
  // layers away as a mystery connection error in a test that has nothing to
  // do with the real cause.
  await assertTemporalReachable(address);

  return { address, namespace: NAMESPACE };
}

/**
 * Stops what **this module registry started**, and nothing else. When the
 * address came from the globalSetup's environment variable, all three handles
 * here are `undefined` and this is a documented no-op — which is what makes a
 * per-file `afterAll(stopTemporal)` safe on the shared server instead of
 * pulling it out from under the next file.
 *
 * Ordered: Temporal, then Postgres, then the network. A network cannot be
 * removed while a container is still attached to it.
 */
export async function stopTemporal(): Promise<void> {
  if (temporal !== undefined) {
    await temporal.stop();
    temporal = undefined;
  }
  if (postgres !== undefined) {
    await postgres.stop();
    postgres = undefined;
  }
  if (network !== undefined) {
    await network.stop();
    network = undefined;
  }
  handle = undefined;
}

/**
 * Builds the default export of a Vitest `globalSetup` file, the Temporal
 * counterpart to `createDatabaseGlobalSetup`.
 *
 * It lives HERE rather than beside its twin in `global-setup.ts`, and that is
 * about module loading rather than tidiness. `global-setup.ts` is reachable
 * from this package's root entry point, so a factory there would drag
 * `./temporal.js` — and therefore all of `@temporalio/*` — into every
 * `import '@metrika/testing'` in the repository. `packages/database` and
 * `apps/api` both do that, and neither has any use for a workflow server.
 * Keeping the whole Temporal surface behind the `@metrika/testing/temporal`
 * subpath means they do not pay for it; src/index.ts records what that is
 * measured to be worth, and what it is NOT (grpc-js arrives with
 * testcontainers either way).
 *
 * A SEPARATE globalSetup file from the database one, for a second reason:
 * Vitest's `globalSetup` takes an array, so a package that needs both lists
 * both, and a package that needs only a database never starts three containers
 * to get one.
 *
 * Everything `createDatabaseGlobalSetup`'s comment says about why a container's
 * lifecycle has to live in globalSetup applies here unchanged.
 */
export function createTemporalGlobalSetup(): () => Promise<() => Promise<void>> {
  return async function setup(): Promise<() => Promise<void>> {
    const started = await startTemporal();
    process.env[TEMPORAL_ADDRESS_VAR] = started.address;

    return async function teardown(): Promise<void> {
      // Reflect.deleteProperty, not `delete`: TEMPORAL_ADDRESS_VAR is a
      // computed key and a dynamic `delete` trips
      // @typescript-eslint/no-dynamic-delete. Same reasoning as
      // global-setup.ts.
      Reflect.deleteProperty(process.env, TEMPORAL_ADDRESS_VAR);
      await stopTemporal();
    };
  };
}
