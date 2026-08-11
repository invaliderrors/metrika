# ADR-0028 — `temporalio/auto-setup` needs a sixth environment variable, so ADR-0027's count is wrong

**Status:** Accepted · **Date:** 2026-08-11 · **Corrects** a body assertion made
twice in [ADR-0027](./0027-python-toolchain.md): that the Temporal service
"needs **five** environment variables, not four". It needs six. Everything else
ADR-0027 decides — the `1.29.7` pin, the Postgres backend, `DB_PORT=5432` and
why omitting it is worse than the Cassandra default it replaces — stands
unchanged and was re-measured while writing this.

## Context

This is a correction rather than an addendum, and the distinction is why it is a
new file. ADR-0027 does not carry an incomplete list that a later document may
extend; it makes a **complete-count claim**, in bold, twice — at its "The
Temporal image tag" section and again in "What did not work", where it records
having already corrected itself once from four to five. A sixth entry falsifies
the count. Editing the two sentences in place would rewrite an assertion a
reviewer accepted, which this repository disallows even while the ADR is
unmerged, and it would erase the more interesting fact: that the count was
wrong for a **second** reason, of a different kind from the first.

`DB_PORT` was missed because it has a wrong default. `BIND_ON_IP` was missed
because ADR-0027's spike ran `docker run` on a single network, and the variable
only matters when a container is on more than one.

### What the variable does, at the source

`/etc/temporal/entrypoint.sh:5`, read out of the pinned image:

```bash
: "${BIND_ON_IP:=$(getent hosts "$(hostname)" | awk '{print $1;}')}"
```

`getent hosts` returns the container's addresses and `awk '{print $1}'` takes
the **first** one. `dockerize` then threads that value into five separate
`bindOnIP` fields in `/etc/temporal/config/config_template.yaml` (lines 279,
287, 295, 301, 307 — frontend, matching, history, worker and internal-frontend)
plus a `$publicIp` used for the membership broadcast address at line 353. So the
server binds exactly one interface, chosen for it, and neither `0.0.0.0` nor
loopback is ever among them unless this variable says so.

Note the shape of the default: `:=` fires on **unset or null**, so
`BIND_ON_IP: ''` reproduces the default path exactly. That is the cleaner
mutation for anyone re-testing this — it exercises the same code path as
deleting the key while leaving the key visible in the file.

### Why compose does not expose it and the test harness does

In `infra/docker/docker-compose.yml` the container sits on one network, so "the
first address" is the only address and a `127.0.0.1` healthcheck is the only
thing that breaks. Measured: `netstat -ltn` inside the container showed a single
`172.18.0.6:7233`, and a loopback probe failed forever against a server that was
serving perfectly — an `unhealthy` service and a red `pnpm infra:up`, but an
obvious one.

`packages/testing`'s harness is where it turns expensive. Testcontainers, when a
container is given network **aliases**, deliberately leaves
`HostConfig.NetworkMode` unset and connects the custom network afterwards —
`generic-container.js`: `NetworkMode = aliases.length > 0 ? undefined :
networkMode`. The container is therefore on **two** networks: the default bridge
and the harness's own. "First address" is the bridge one, so temporal-server
listened on `172.17.0.4:7233` while its `temporal` alias resolved to
`172.19.0.3`. Measured: **45 seconds** of `connection refused` dialling the only
name the container had, against a server that was up the entire time, with
correct logs and a zero exit code from every step that produced it.

That is the failure mode ADR-0027 is written against — something that installs,
starts, logs success, and silently does less than it appears to — landing on the
one variable ADR-0027 did not have the topology to see.

## Decision

**The `temporal` service takes six environment variables**, and both
`infra/docker/docker-compose.yml` and `packages/testing/src/temporal.ts` set all
six:

| Variable         | Value         | Why                                                               |
| ---------------- | ------------- | ----------------------------------------------------------------- |
| `DB`             | `postgres12`  | ADR-0027                                                          |
| `DB_PORT`        | `5432`        | ADR-0027 — defaults to 3306, MySQL's port                         |
| `POSTGRES_SEEDS` | `postgres`    | ADR-0027 — the network alias, not localhost                       |
| `POSTGRES_USER`  | `metrika`     | ADR-0027 — the owner role; auto-setup CREATEs two databases       |
| `POSTGRES_PWD`   | `metrika`     | ADR-0027                                                          |
| **`BIND_ON_IP`** | **`0.0.0.0`** | **this ADR** — otherwise the server binds one arbitrary interface |

`0.0.0.0` rather than a computed address: `entrypoint.sh` special-cases exactly
that value and sets `TEMPORAL_BROADCAST_ADDRESS` from `getent` itself, so ring
membership on the single node keeps a real address while the listeners bind
everything. Verified end to end on both sides. Nothing new crosses the container
boundary — compose still publishes only `127.0.0.1:7233:7233`, and the harness
still publishes only an ephemeral mapped port.

**Both places probe `127.0.0.1:7233`.** With every interface bound, loopback is
correct regardless of how many networks the container ends up on, which is what
keeps the compose healthcheck and the harness's wait strategy the same string.

### Two pins ADR-0027 does not govern

**`temporalio/ui:2.53.2`.** ADR-0027 pins `auto-setup` and is silent on the UI,
which is a second image with its own release cadence. `2.53.2` is the newest
published tag and it currently resolves to the **same digest as `:latest`**,
having been published about seven hours before it was pinned here — so it is a
sound pin (a real version tag will not move) with effectively **zero soak**. It
was verified against server 1.29.7 rather than assumed: `GET /` returns 200 and
`GET /api/v1/namespaces` returns 200 with `temporal-system` and `default` in the
body, which is the UI genuinely proxying gRPC rather than serving assets. If it
misbehaves, `2.53.1` (2026-08-05) is the step back. Recorded in
[`IMAGE_PINS.md`](../../infra/docker/IMAGE_PINS.md) with its Image ID.

**`auto-setup` for the test harness, not `temporalio/temporal`.** The harness
starts a Postgres container purely as Temporal's datastore, because auto-setup's
own `/etc/temporal/auto-setup.sh` accepts exactly `mysql8`, `postgres12`,
`postgres12_pgx` and `cassandra`. That is a property of the **image**, not of the
problem: `temporalio/temporal` runs `server start-dev` over SQLite in a single
container with no datastore at all. This is a trade, taken deliberately — see
Alternatives — and not an impossibility, which is how the first version of the
Task 5 report described it.

## Alternatives

- **Edit ADR-0027's two sentences to say six.** Rejected. They are a
  complete-count claim a reviewer accepted, not an open list, and ADR-0027's own
  value comes largely from recording where it was wrong rather than quietly
  folding corrections in. Rewriting it would delete the second correction while
  celebrating the first.
- **Leave `BIND_ON_IP` at its default and dial the container's alias instead.**
  This works in compose and was the first version of the healthcheck. Rejected
  because it does not work in the harness at all — the alias resolves to the
  network the server did not bind — so the two environments would have needed
  different probes for a difference neither file could explain locally.
- **Drop `withNetworkAliases` in the harness so the container has one network.**
  Would also fix it, by removing the second interface rather than binding both.
  Rejected: `POSTGRES_SEEDS` is a network alias by construction, so the harness
  needs aliases anyway, and relying on testcontainers' internal
  `NetworkMode`-vs-`aliases` branch is depending on an implementation detail
  that a minor release may change. Binding every interface does not care.
- **`temporalio/temporal` (`server start-dev`, SQLite) for the harness.** One
  container instead of three, no Postgres, and measurably faster. Rejected for
  now because it puts the test harness on a _different server topology_ from
  `docker-compose.yml` — a different image, a different persistence engine, and
  a different provisioning path for the `default` namespace. The whole point of
  pinning one image in two places is that a green harness says something about
  the stack a developer actually runs. Revisit if harness start time becomes a
  real cost; it is ~2.5s today.
- **A `start_period` alone on the compose healthcheck.** Rejected as
  insufficient on its own — see `docker-compose.yml`, which pairs it with
  `start_interval` so docker actually polls inside the ~1s window this check
  exists to catch.

## Consequences

**Accepted:** ADR-0027's five-variable claim is wrong wherever it is quoted, and
the two documents must be read together — `docs/LOCAL_DEVELOPMENT.md` now points
at both rather than at ADR-0027 alone, which is the specific way this would have
bitten: a developer hits the loopback-healthcheck failure, follows the pointer,
and finds a list omitting the only variable that fixes it. The count is now six
in three places (both compose and harness sources, and this table), and nothing
mechanically enforces that they agree.

**Gained:** the mechanism is recorded from the image's own source rather than
from a symptom, so the next person does not have to re-derive it from a
`connection refused`. And the reason the two environments differ is written
down: it is not compose being lenient, it is testcontainers attaching a second
network that the entrypoint's "first address" heuristic then picks.
