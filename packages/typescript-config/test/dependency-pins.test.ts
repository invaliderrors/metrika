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
 *
 * THE PYTHON HALF lives here too, in the second `describe` below, rather than
 * as a `pytest` sibling inside `apps/workers`. Three reasons, in order of
 * weight:
 *
 *   1. It is one invariant, not two. "A range is how a version nobody reviewed
 *      enters a lockfile" is a property of this repository, not of a language,
 *      and splitting it across two suites is how the two halves drift into
 *      saying different things.
 *   2. A `pytest` gate runs only when the Python toolchain resolves. The
 *      failure mode this gate exists for — a dependency that installs and then
 *      silently does less — is exactly the situation in which the Python side
 *      may not be running at all, and a gate that disappears with its subject
 *      is not a backstop.
 *   3. `pyproject.toml` is read with a small reader for the same reason
 *      `pnpm-workspace.yaml` is (see `workspaceGlobs` below): a TOML dependency
 *      in this package buys one file read. The reader's limits are named where
 *      it is defined, and the two non-vacuity tests below fail loudly if it
 *      ever stops finding anything.
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

/* ─────────────────────────── the Python half ─────────────────────────────── */

/**
 * Directories the `pyproject.toml` walk does not enter. `.venv` is the one that
 * matters — every installed package under it carries its own `pyproject.toml`,
 * and walking into one would grade third-party manifests this repository does
 * not own. The rest are build output and tool caches.
 */
const PY_SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.turbo',
  '.venv',
  'dist',
  '.next',
  'coverage',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  'test-results',
  'playwright-report',
]);

/**
 * Every `pyproject.toml` in the repository, found by walking rather than by
 * reading `[tool.uv.workspace] members`.
 *
 * Deliberate: the uv workspace root at `apps/workers/pyproject.toml` declares
 * `members = ["packages/*", "geometry", "slicer"]`, and a member added outside
 * that list — or a `pyproject.toml` somewhere else entirely — would be invisible
 * to a members-driven walk while still being installed by whoever runs `uv sync`
 * in its directory. A walk cannot be narrowed by an edit somewhere else.
 */
function pyprojectPaths(dir: string = repoRoot, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (PY_SKIPPED_DIRECTORIES.has(entry.name)) continue;
      pyprojectPaths(path.join(dir, entry.name), found);
    } else if (entry.name === 'pyproject.toml') {
      found.push(path.join(dir, entry.name));
    }
  }
  return found;
}

/**
 * One line of TOML with its string literals lifted out and its comment dropped.
 *
 * Lifting the strings first is what makes the bracket counting below safe:
 * `"boto3-stubs[s3]==1.43.67"` carries brackets of its own, and counting them
 * as array delimiters would end the array early and silently stop checking
 * everything after it.
 *
 * KNOWN LIMITS, and they are the reason the two non-vacuity tests exist: this
 * understands single-line basic and literal strings only. A `\"` escape or a
 * `"""` multi-line string in a dependency array would confuse it. Neither
 * appears in a PEP 508 requirement, and if one ever does, the count assertions
 * below fall over rather than quietly reading nothing.
 */
function stripStrings(line: string): { code: string; strings: string[] } {
  const strings: string[] = [];
  let code = '';
  let quote: string | null = null;
  let literal = '';

  for (const char of line) {
    if (quote === null) {
      if (char === '"' || char === "'") {
        quote = char;
        literal = '';
      } else if (char === '#') {
        break;
      } else {
        code += char;
      }
    } else if (char === quote) {
      strings.push(literal);
      quote = null;
    } else {
      literal += char;
    }
  }
  return { code, strings };
}

/**
 * The tables whose string arrays are install instructions. Named explicitly
 * rather than "any array of strings", so that `[tool.ruff.lint] select` and
 * `[project] classifiers` are not graded as if they were dependencies.
 *
 * `[project] requires-python` is deliberately absent: it is the interpreter
 * range, not a dependency, and `==3.12.*` is the correct shape for it
 * (ADR-0027). The patch is pinned by `.python-version`.
 */
function isPythonDependencyArray(table: string, key: string): boolean {
  if (table === 'project' && key === 'dependencies') return true;
  if (table === 'project.optional-dependencies') return true;
  if (table === 'dependency-groups') return true;
  // uv's pre-PEP-735 spelling. Nothing uses it today; a migration back to it
  // must not fall out of this gate.
  if (table === 'tool.uv' && key === 'dev-dependencies') return true;
  return false;
}

interface PythonRequirement {
  readonly manifest: string;
  readonly table: string;
  readonly key: string;
  readonly requirement: string;
}

function pythonRequirements(): PythonRequirement[] {
  const found: PythonRequirement[] = [];

  for (const file of pyprojectPaths()) {
    const manifest = path.relative(repoRoot, file);
    let table = '';
    let arrayKey: string | null = null;
    let depth = 0;

    for (const rawLine of readFileSync(file, 'utf8').split('\n')) {
      const { code, strings } = stripStrings(rawLine);
      const trimmed = code.trim();

      if (arrayKey === null) {
        const header = /^\[{1,2}([^[\]]+)\]{1,2}$/.exec(trimmed);
        if (header?.[1] !== undefined) {
          table = header[1].trim();
          continue;
        }
        // The key is allowed to be empty: a quoted key (`"tests/**" = [...]`)
        // has already been lifted out by `stripStrings`, and such an array
        // still has to be tracked so its closing bracket is not mistaken for
        // something else.
        const opened = /^([A-Za-z0-9_.-]*)\s*=\s*\[(.*)$/.exec(trimmed);
        if (opened?.[1] === undefined || opened[2] === undefined) continue;
        arrayKey = opened[1];
        depth = 1 + count(opened[2], '[') - count(opened[2], ']');
      } else {
        depth += count(code, '[') - count(code, ']');
      }

      if (isPythonDependencyArray(table, arrayKey)) {
        for (const requirement of strings) {
          found.push({ manifest, table, key: arrayKey, requirement });
        }
      }
      if (depth <= 0) arrayKey = null;
    }
  }
  return found;
}

function count(haystack: string, character: string): number {
  return haystack.split(character).length - 1;
}

/**
 * `name==X.Y[.Z[.W]]`, with an optional extras group. No `>=`, no `~=`, no
 * `!=`, no wildcard, no comma-joined range, no environment marker, and no bare
 * name — a requirement with no version at all is the widest range there is.
 */
const PY_EXACT = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9,._-]+\])?==\d+(?:\.\d+){1,3}$/;

describe('python dependency pins', () => {
  it('finds the uv workspace root, so a broken walker cannot make this vacuous', () => {
    const found = pyprojectPaths().map((file) => path.relative(repoRoot, file));

    expect(found).toContain('apps/workers/pyproject.toml');
  });

  it('reads the dependency arrays it claims to read', () => {
    const requirements = pythonRequirements();
    // Split on the first operator, extras bracket or marker rather than on
    // `==` specifically: this test asserts that the reader FOUND these, and it
    // must keep saying that while the test below is the one that fails on a
    // range. Two gates failing for one cause reads as two problems.
    const names = requirements.map(({ requirement }) => requirement.split(/[=<>!~[;\s]/)[0]);

    // Two dev dependencies that exist to make this assertion fail if the reader
    // ever stops finding array contents. Named, not counted by shape: a count
    // alone passes on the wrong array.
    expect(names).toContain('ruff');
    expect(names).toContain('mypy');
    expect(requirements.length).toBeGreaterThanOrEqual(4);
  });

  it('pins every python dependency exactly — no >=, ~=, wildcard or bare name', () => {
    const offenders = pythonRequirements()
      .filter(({ requirement }) => !PY_EXACT.test(requirement))
      .map(
        ({ manifest, table, key, requirement }) =>
          `${manifest} → [${table}] ${key}: ${requirement}`,
      );

    expect(
      offenders,
      'pin these exactly; uv writes >= ranges by default, and a floor is a version nobody reviewed',
    ).toEqual([]);
  });
});
