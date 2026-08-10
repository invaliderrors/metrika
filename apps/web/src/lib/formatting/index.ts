/**
 * The one place a number becomes a string for a human to read.
 *
 * Components import from here, never from `Intl` directly. `Intl.NumberFormat`
 * handed a float is how a COP amount renders as "$3,500.00" instead of
 * "$350.000", and that is not a bug you can fix once it is spread across forty
 * components.
 */
export * from './money';
export * from './units';
