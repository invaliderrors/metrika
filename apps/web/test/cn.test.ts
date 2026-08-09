import { describe, expect, it } from 'vitest';
import { cn } from '@/lib/cn';

/**
 * `cn` is two functions composed, and only one of them is observable from the
 * outside without these assertions.
 *
 * MEASURED: replacing `twMerge(clsx(inputs))` with a bare `clsx(inputs)` changes
 * no emitted CSS, no rendered markup and no other assertion in this package —
 * both spellings put a class attribute on the element, and the browser silently
 * decides the winner by stylesheet order instead. The whole reason `cn` exists
 * rather than `clsx` alone is that Tailwind's conflicting utilities have no
 * meaningful source order, so "the caller's value wins" has to be resolved
 * before the string reaches the DOM.
 *
 * Imported through `@/lib/cn` rather than a relative path deliberately: it makes
 * this file the fixture for the `@` alias agreeing across `tsconfig.json` and
 * `vitest.config.ts`.
 */
describe('cn', () => {
  it('lets a caller override a component default of the same Tailwind property', () => {
    // The failure this prevents: `'p-4 p-2'`, where the winner depends on which
    // rule the stylesheet happens to emit last.
    expect(cn('p-4', 'p-2')).toBe('p-2');
  });

  it('resolves conflicts across every position, not just adjacent pairs', () => {
    expect(cn('rounded-card px-4 py-2', 'px-8')).toBe('rounded-card py-2 px-8');
  });

  it('keeps utilities that do not conflict', () => {
    expect(cn('bg-brand', 'text-brand-foreground')).toBe('bg-brand text-brand-foreground');
  });

  it('resolves the conditional forms clsx accepts', () => {
    expect(cn('bg-brand', false, undefined, null, ['p-4', { 'p-2': true, 'p-8': false }])).toBe(
      'bg-brand p-2',
    );
  });

  it('returns an empty string for no input, rather than throwing or returning undefined', () => {
    expect(cn()).toBe('');
  });
});
