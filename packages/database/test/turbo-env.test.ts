import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every environment variable `prisma.config.ts` resolves must be declared to
 * turbo for every task that runs a Prisma subcommand.
 *
 * This test exists because its absence cost four of five CI jobs. Prisma 6
 * resolved the datasource url lazily in the engine, so `generate` never touched
 * `DATABASE_ADMIN_URL` and nothing had to declare it. Prisma 7 resolves
 * `env('DATABASE_ADMIN_URL')` when `prisma.config.ts` LOADS, which every
 * subcommand does — so the variable became a turbo-visible input for the first
 * time, and turbo runs in STRICT env mode, which strips whatever is not
 * declared.
 *
 * It passed on every developer machine and failed on all four CI jobs that
 * build. The asymmetry is `--env-file-if-exists=.env` in the `db:*` scripts: it
 * loads the root `.env` INSIDE the child process, downstream of turbo's
 * filtering, so a machine with a `.env` cannot observe the bug at all. CI has no
 * `.env`. `pnpm verify` was green throughout.
 *
 * A static check is the right shape for that: it does not need a `.env` to be
 * absent, it does not need CI, and it fails at the moment someone adds an
 * `env()` call that nothing declares — which is when it is cheap to fix.
 */
describe('turbo declares what prisma.config.ts resolves', () => {
  const repoRoot = path.resolve(import.meta.dirname, '../../..');
  const packageRoot = path.resolve(import.meta.dirname, '..');

  /**
   * Tasks that run a Prisma subcommand, and so load `prisma.config.ts`.
   *
   * `build` is in this list and the reason is easy to miss: `packages/database`'s
   * build script is `pnpm db:generate && tsc -b`, which runs generate INLINE, in
   * the `build` task's own filtered environment. `dependsOn: ["db:generate"]`
   * does not cover that — MEASURED, with the variable declared on `db:generate`
   * alone and no root `.env`, `turbo run db:generate` succeeds and `pnpm build`
   * still fails at `@metrika/database#build`.
   */
  const TASKS_RUNNING_PRISMA = ['db:generate', 'build'] as const;

  /**
   * Strips `//` line comments and `/* *\/` blocks from JSONC without breaking
   * on the `//` inside a string — `turbo.json`'s own `$schema` value is
   * `https://turbo.build/schema.json`, which a naive regex mangles into invalid
   * JSON. Scans character by character and tracks whether it is inside a string.
   */
  function stripJsonComments(source: string): string {
    let out = '';
    let inString = false;
    let inLineComment = false;
    let inBlockComment = false;

    for (let i = 0; i < source.length; i += 1) {
      const char = source[i] ?? '';
      const next = source[i + 1] ?? '';

      if (inLineComment) {
        if (char === '\n') {
          inLineComment = false;
          out += char;
        }
        continue;
      }
      if (inBlockComment) {
        if (char === '*' && next === '/') {
          inBlockComment = false;
          i += 1;
        }
        continue;
      }
      if (inString) {
        // A backslash escapes the next character, including a quote.
        if (char === '\\') {
          out += char + next;
          i += 1;
          continue;
        }
        if (char === '"') inString = false;
        out += char;
        continue;
      }
      if (char === '"') {
        inString = true;
        out += char;
        continue;
      }
      if (char === '/' && next === '/') {
        inLineComment = true;
        continue;
      }
      if (char === '/' && next === '*') {
        inBlockComment = true;
        i += 1;
        continue;
      }
      out += char;
    }

    return out;
  }

  interface TurboTask {
    readonly env?: readonly string[];
    readonly passThroughEnv?: readonly string[];
  }
  interface TurboConfig {
    readonly globalEnv?: readonly string[];
    readonly globalPassThroughEnv?: readonly string[];
    readonly tasks: Readonly<Record<string, TurboTask>>;
  }

  function readTurboConfig(): TurboConfig {
    const raw = readFileSync(path.join(repoRoot, 'turbo.json'), 'utf8');
    return JSON.parse(stripJsonComments(raw)) as TurboConfig;
  }

  function requiredEnvNames(): string[] {
    const source = readFileSync(path.join(packageRoot, 'prisma.config.ts'), 'utf8');
    return [...source.matchAll(/env\(\s*['"]([A-Z0-9_]+)['"]\s*\)/g)].map(
      (match) => match[1] ?? '',
    );
  }

  it('finds the env() calls it is meant to police', () => {
    // The positive control. Every assertion below is a loop over this list, so
    // a regex that silently stopped matching — a rename, a template literal, a
    // helper wrapping `env()` — would turn the whole suite into a vacuous pass.
    // This is the one assertion that cannot be satisfied by measuring nothing.
    const required = requiredEnvNames();
    expect(required).toContain('DATABASE_ADMIN_URL');
    expect(required.length).toBeGreaterThan(0);
  });

  it('parses turbo.json despite its comments', () => {
    // Also a control: if `stripJsonComments` ever broke, `readTurboConfig()`
    // would throw inside the tests below and read as a failure of the rule
    // rather than of the parser. This says which one it is.
    const config = readTurboConfig();
    expect(config.tasks).toBeTypeOf('object');
    expect(Object.keys(config.tasks)).toEqual(expect.arrayContaining([...TASKS_RUNNING_PRISMA]));
  });

  it.each(TASKS_RUNNING_PRISMA)('declares every required variable for %s', (taskName) => {
    const config = readTurboConfig();
    const task = config.tasks[taskName];
    expect(task, `turbo.json has no "${taskName}" task`).toBeDefined();

    const declared = new Set<string>([
      ...(config.globalEnv ?? []),
      ...(config.globalPassThroughEnv ?? []),
      ...(task?.env ?? []),
      ...(task?.passThroughEnv ?? []),
    ]);

    for (const name of requiredEnvNames()) {
      expect(
        declared.has(name),
        `prisma.config.ts resolves env('${name}'), but turbo's "${taskName}" task declares ` +
          `neither env nor passThroughEnv for it. Turbo runs in strict env mode and will strip ` +
          `it, so this task fails on any machine without a root .env — which is every CI job. ` +
          `Add it to passThroughEnv (not env: the value does not change the task's output).`,
      ).toBe(true);
    }
  });
});
