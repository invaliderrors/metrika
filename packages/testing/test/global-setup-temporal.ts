import { createTemporalGlobalSetup } from '../src/index.js';

// A second globalSetup file beside test/global-setup.ts, not a replacement.
// Vitest runs every entry in the `globalSetup` array once per RUN, before it
// forks any worker, which is what gives the whole suite ONE Temporal server.
export default createTemporalGlobalSetup();
