import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const repoRoot = path.resolve(import.meta.dirname, '../../..');

/**
 * Every dependency in every workspace manifest is pinned to an exact version.
 *
 * `CONTRIBUTING.md` says "Pin infrastructure and tool versions exactly", and
 * `docs/TYPESCRIPT_AND_TOOLING.md` gives the reason for each individual pin —
 * TypeScript at 6.0.3 because 7.x falls outside `typescript-eslint`'s peer range
 * and would silently disable every type-aware rule, Prettier exactly because a
 * patch release that changes output turns an unrelated pull request into a
 * thousand-line diff. Until now the policy was prose. Nothing failed when a
 * caret appeared.
 *
 * It appeared. `shadcn init` added four dependencies to `apps/web` at ranges
 * (`^0.7.1`, `^1.6.7`, `^1.30.0`, `^4.16.2`) in a single non-interactive
 * command, and the only thing that caught them was a human reading the diff.
 * Any generator, any `pnpm add` without `-E`, and any dependency bot does the
 * same. A range is how a version nobody reviewed enters a lockfile.
 *
 * WHY THIS PACKAGE. The invariant belongs to no single app, so it went where it
 * is cheapest and least surprising: `@metrika/typescript-config` is the package
 * `docs/TYPESCRIPT_AND_TOOLING.md` documents, it has no workspace dependencies
 * (so a repo-wide gate here cannot create the cycle its own eslint.config.js
 * warns about), and it already hosts an invariant that is not about its own
 * code — `lint-parity.test.ts` asserts the repo-wide `process.env` ban.
 * `packages/eslint-config` was the other candidate and would be equally
 * defensible; the choice is a judgement call, not a derivation.
 */

const Manifest = z.object({
  name: z.string().optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
  optionalDependencies: z.record(z.string(), z.string()).optional(),
});

/**
 * `peerDependencies` is deliberately absent. A peer range is a statement about
 * what a CONSUMER may install, and narrowing one to a single version would be
 * wrong rather than strict. No workspace package declares any today; if one
 * does, this comment is why it is not checked.
 */
const CHECKED_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

/** Plain semver, with no range operator of any kind. */
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * The workspace globs, read from `pnpm-workspace.yaml` rather than hardcoded, so
 * that adding a third root (`tools/*`, say) cannot silently leave a whole
 * directory unchecked.
 *
 * A five-line reader instead of a YAML dependency: it consumes the indented
 * `- 'entry'` lines under `packages:` and stops at the next top-level key. Any
 * glob shape other than `dir/*` throws below rather than being skipped — the
 * failure mode of a glob expander that quietly matches nothing is exactly the
 * silent-success shape this repository keeps meeting.
 */
function workspaceGlobs(): string[] {
  const lines = readFileSync(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf8').split('\n');
  const start = lines.findIndex((line) => line.trimEnd() === 'packages:');
  if (start === -1) throw new Error('pnpm-workspace.yaml declares no `packages:` key');

  const globs: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line)) break;
    const entry = /^\s*-\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line);
    if (entry?.[1] !== undefined) globs.push(entry[1]);
  }
  return globs;
}

/** Absolute paths of every `package.json` in the workspace, root included. */
function manifestPaths(): string[] {
  const found = [path.join(repoRoot, 'package.json')];

  for (const glob of workspaceGlobs()) {
    if (!glob.endsWith('/*')) {
      throw new Error(
        `Unsupported workspace glob ${glob}. This test only expands 'dir/*'; ` +
          'teach it the new shape rather than letting it match nothing.',
      );
    }
    const dir = path.join(repoRoot, glob.slice(0, -2));
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = path.join(dir, entry.name, 'package.json');
      if (existsSync(manifest)) found.push(manifest);
    }
  }
  return found;
}

function readManifest(file: string): z.infer<typeof Manifest> {
  const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
  return Manifest.parse(raw);
}

interface Specifier {
  readonly manifest: string;
  readonly field: string;
  readonly name: string;
  readonly range: string;
}

function allSpecifiers(): Specifier[] {
  return manifestPaths().flatMap((file) => {
    const manifest = readManifest(file);
    const relative = path.relative(repoRoot, file);
    return CHECKED_FIELDS.flatMap((field) =>
      Object.entries(manifest[field] ?? {}).map(([name, range]) => ({
        manifest: relative,
        field,
        name,
        range,
      })),
    );
  });
}

describe('workspace dependency pins', () => {
  it('finds every workspace manifest, so a broken walker cannot make this vacuous', () => {
    const found = manifestPaths().map((file) => path.relative(repoRoot, file));

    expect(found).toContain('package.json');
    expect(found).toContain('apps/web/package.json');
    expect(found).toContain('apps/api/package.json');
    expect(found).toContain('packages/typescript-config/package.json');
    expect(found.length).toBeGreaterThanOrEqual(8);
  });

  it('reads a non-trivial number of specifiers', () => {
    expect(allSpecifiers().length).toBeGreaterThan(50);
  });

  it('pins every dependency exactly — no caret, tilde, range, star or tag', () => {
    const offenders = allSpecifiers()
      // `workspace:*` is how pnpm links a sibling package and is the only
      // sanctioned non-version specifier. `catalog:` is pnpm's shared-version
      // mechanism, allowed for when this workspace adopts one — the version it
      // resolves to still lives in `pnpm-workspace.yaml`, in one reviewed place.
      .filter(({ range }) => !range.startsWith('workspace:') && !range.startsWith('catalog:'))
      .filter(({ range }) => !EXACT.test(range))
      .map(({ manifest, field, name, range }) => `${manifest} → ${field}.${name}: "${range}"`);

    expect(offenders, 'pin these exactly; a range is a version nobody reviewed').toEqual([]);
  });
});
