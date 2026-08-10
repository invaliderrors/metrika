import type { ComponentProps } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';

import { cn } from '@/lib/cn';

/**
 * Copied in by `shadcn add button` and then RETARGETED AT THIS APP'S TOKENS.
 *
 * The registry writes its variants against its own palette — `bg-primary`,
 * `text-secondary-foreground`, `bg-destructive`, `border-border`,
 * `ring-ring` — none of which exist here, because `globals.css` declares one
 * colour system and it is not shadcn's. Every class below is `brand`, `surface`,
 * `muted` or `danger` for that reason. If this file is ever regenerated, expect
 * the generator's names back and rename them again; do not add the generator's
 * palette to `globals.css` to make them resolve. See the comment there.
 *
 * `import type { ComponentProps }` rather than the generated
 * `import * as React`: the namespace was used only in type position, and
 * `@typescript-eslint/consistent-type-imports` is an error in this workspace.
 *
 * DELIBERATELY IMPORTED BY NOTHING, and worth saying out loud so it is not
 * mistaken for a leftover and deleted. It is vendored UI waiting for the first
 * screen that needs a button (Phase 1); shadcn is copy-in rather than a
 * dependency precisely so a component can sit here, reviewed and retargeted,
 * before it has a caller. `page.tsx` rendered it while the shell was a
 * placeholder and stopped when the shell became real.
 *
 * What that does and does not cost, measured rather than assumed:
 *
 *   - It is still type-checked (`tsconfig.json` includes `src/**`) and still
 *     gated by `test/shadcn-palette.test.ts`, which scans `src/components/**`
 *     by TEXT and does not care what imports what. So the retargeting above
 *     cannot silently regress.
 *   - It does NOT prop up any token in the emitted stylesheet. That is the
 *     obvious worry, since Tailwind scans the text of `src/` rather than the
 *     import graph, and `tailwind-build.test.ts` asserts `--color-brand:` is
 *     declared. MEASURED by deleting this file outright and rebuilding: the
 *     sheet still carries `--color-brand:`, `--radius-card:` and a
 *     `rounded-card` utility, because `layout.tsx`'s skip link uses
 *     `focus:bg-brand` and `focus:rounded-card`. Both tokens have a live
 *     consumer that is not this file.
 *   - Nothing exercises its variants in a real browser. `outline`, `secondary`,
 *     `ghost` and the `asChild` Slot path are compiled and linted but never
 *     rendered. The first screen to use one is where that gets fixed.
 */
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-card border border-transparent text-sm font-medium whitespace-nowrap transition-colors outline-none select-none focus-visible:ring-2 focus-visible:ring-brand/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-danger [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-brand text-brand-foreground hover:bg-brand/90',
        outline: 'border-muted-foreground/30 hover:bg-muted hover:text-surface-foreground',
        secondary: 'bg-muted text-surface-foreground hover:bg-muted/80',
        ghost: 'hover:bg-muted hover:text-surface-foreground',
        danger: 'bg-danger text-brand-foreground hover:bg-danger/90',
        link: 'text-brand underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-8 px-3 text-xs',
        default: 'h-9 px-4',
        lg: 'h-10 px-6',
        icon: 'size-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

function Button({
  className,
  variant = 'default',
  size = 'default',
  asChild = false,
  ...props
}: ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : 'button';

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
