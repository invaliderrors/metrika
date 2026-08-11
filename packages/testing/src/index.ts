// The Temporal harness is deliberately ABSENT from this barrel. It is reachable
// only as `@metrika/testing/temporal`, so that packages/database and apps/api —
// which import this entry point and never dial a workflow server — do not load
// `@temporalio/*` to get a Postgres container.
//
// MEASURED from packages/database, counting `require.cache` after each import,
// because the obvious version of this claim is wrong:
//
//   after `@metrika/testing`           grpc-js=65 temporalio=0  protobufjs=41  total=704
//   after `@metrika/testing/temporal`  grpc-js=65 temporalio=77 protobufjs=42  total=829
//
// So the split saves the 77 `@temporalio/*` modules and ~125 modules overall.
// It does NOT save `@grpc/grpc-js` or `protobufjs`: both already arrive with
// `testcontainers` → `dockerode`, exactly as pnpm-workspace.yaml's `allowBuilds`
// comment says. Worth stating precisely, because "keeps gRPC out of the graph"
// would be a satisfying reason that measurement does not support.
//
// `TEMPORAL_IMAGE` stays below regardless: `./images.js` is a dependency-free
// leaf, and it is what packages/database's pin test reads.
export { assertDockerAvailable, DockerUnavailableError } from './docker.js';
export { POSTGRES_IMAGE, TEMPORAL_IMAGE } from './images.js';
export { createDatabaseGlobalSetup } from './global-setup.js';
export {
  ADMIN_URL_VAR,
  APPLICATION_URL_VAR,
  startDatabase,
  stopDatabase,
  withDatabase,
  type DatabaseHandle,
  type DisposableClient,
  type StartDatabaseOptions,
  type WithDatabaseOptions,
} from './database.js';
