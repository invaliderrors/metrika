// From '../src/temporal.js', not '../src/index.js': the Temporal harness is
// deliberately absent from the package barrel so that importing
// `@metrika/testing` does not load @temporalio/client. See src/index.ts.
import { createTemporalGlobalSetup } from '../src/temporal.js';

// A second globalSetup file beside test/global-setup.ts, not a replacement.
// Vitest runs every entry in the `globalSetup` array once per RUN, before it
// forks any worker, which is what gives the whole suite ONE Temporal server.
export default createTemporalGlobalSetup();
