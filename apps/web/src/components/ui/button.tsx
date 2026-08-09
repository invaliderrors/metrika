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
