import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // ADR-0021 obligation 2. Next 16's `next dev` otherwise writes `AGENTS.md`
  // and an 11-byte `CLAUDE.md` containing `@AGENTS.md` into this directory on
  // every start, announced as "Generated AGENTS.md and CLAUDE.md for AI
  // agents". This repository's CLAUDE.md is hand-authored and its rules say not
  // to leave the tree dirty, so a dev server that generates one is
  // unacceptable. `next build` does not do it, which is exactly why this needs
  // to be written down rather than discovered.
  agentRules: false,
  // `pnpm verify` must fail on a type error rather than letting `next build`
  // skip its own check. This is Next's default today; it is stated so a future
  // `ignoreBuildErrors: true` is a visible edit.
  //
  // There is deliberately no sibling `eslint: { ignoreDuringBuilds: false }`.
  // MEASURED: `NextConfig` in next@16.3.0 has no `eslint` key at all — the
  // string does not appear in `dist/server/config-shared.d.ts` — and writing
  // one fails `tsc` with TS2353. Next 16 removed `next lint` and build-time
  // ESLint; linting is `pnpm lint` / CI's `pnpm lint -- --max-warnings=0`,
  // which is the gate that actually runs. Do not re-add the key from a Next 15
  // example: it will not compile, and if a future major restores it as an
  // untyped passthrough it would read as a control that nothing enforces.
  typescript: { ignoreBuildErrors: false },
};

export default config;
