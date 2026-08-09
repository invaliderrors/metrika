import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import reactConfig from './eslint.react.config.js';
import nextConfig from './eslint.next.config.js';

async function run(config: unknown, code: string, filename: string): Promise<string[]> {
  const eslint = new ESLint({ overrideConfigFile: true, overrideConfig: config as never });
  const [result] = await eslint.lintText(code, { filePath: filename });
  return (result?.messages ?? []).map((m) => m.ruleId ?? '(fatal)');
}

// `async` on both, though neither awaits: `@typescript-eslint/promise-function-async`
// is an error in this repo's own profile and these return a Promise.
const lint = async (code: string, filename: string) => run(reactConfig, code, filename);
const lintWithNext = async (code: string, filename: string) => run(nextConfig, code, filename);

describe('the react profile', () => {
  it('rejects a conditional hook call', async () => {
    const rules = await lint(
      `export function C({ on }: { on: boolean }) {
         if (on) { const [v] = React.useState(0); return <p>{v}</p>; }
         return null;
       }`,
      'src/C.tsx',
    );
    expect(rules).toContain('react-hooks/rules-of-hooks');
  });

  it('rejects an image without alt text', async () => {
    const rules = await lint(`export const C = () => <img src="/a.png" />;`, 'src/C.tsx');
    expect(rules).toContain('jsx-a11y/alt-text');
  });

  it('does not require React to be in scope — the automatic runtime is on', async () => {
    const rules = await lint(`export const C = () => <p>ok</p>;`, 'src/C.tsx');
    expect(rules).not.toContain('react/react-in-jsx-scope');
  });

  it('accepts a correct component', async () => {
    const rules = await lint(
      `export const C = ({ label }: { label: string }) => <button type="button">{label}</button>;`,
      'src/C.tsx',
    );
    expect(rules).toEqual([]);
  });
});

/**
 * ADR-0021 obligation 3. `eslint-config-next` depends on eslint-plugin-react,
 * whose peer range excludes ESLint 10 and which has not published in 16
 * months; its `settings.react.version: 'detect'` path calls
 * `context.getFilename()`, removed in ESLint 10. The `next` profile overrides
 * that setting, and this block is what proves the override left the rules
 * REPORTING rather than merely stopping the crash.
 *
 * The distinction is not hypothetical here. Plan 0A shipped a config where
 * TypeScript resolved outside typescript-eslint's peer range and every
 * type-aware rule silently stopped running, with no error and a green build.
 * A test asserting the config loads would have passed throughout.
 */
describe('the next profile, against ADR-0021 obligation 3', () => {
  it('does not exit non-zero merely by loading', async () => {
    await expect(lintWithNext(`export const C = () => <p>ok</p>;`, 'src/C.tsx')).resolves.toEqual(
      [],
    );
  });

  it('still reports react/display-name — the rule whose detect path crashes', async () => {
    // Named specifically: this is the rule that throws under ESLint 10 without
    // the settings override, so it is the one whose silence would mean the
    // workaround masked the problem instead of fixing it.
    //
    // A `memo()` wrapper, not a component declared inside another component.
    // Measured against eslint-plugin-react@7.37.5: the inner-component form
    // reports `react-hooks/static-components` and NOT `react/display-name`,
    // because the inner component is bound to a named variable and the rule
    // infers a display name from it. An anonymous argument to `memo` has no
    // name to infer, which is the case the rule exists for.
    const rules = await lintWithNext(
      `import { memo } from 'react';
       export const C = memo(() => <p>x</p>);`,
      'src/C.tsx',
    );
    expect(rules).toContain('react/display-name');
  });

  it('still reports react/jsx-key', async () => {
    const rules = await lintWithNext(
      `export const C = () => <>{[1, 2].map((n) => <li>{n}</li>)}</>;`,
      'src/C.tsx',
    );
    expect(rules).toContain('react/jsx-key');
  });
});
