import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * shadcn's class merge helper. `clsx` resolves conditionals; `twMerge` then
 * resolves Tailwind conflicts by precedence, so a caller's `p-2` beats a
 * component's default `p-4` instead of the pair both landing in the class
 * attribute and the winner being decided by stylesheet order.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
