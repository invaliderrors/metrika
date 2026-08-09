import { CURRENCY_REGISTRY, Money } from '@metrika/contracts';

/**
 * `Money` itself deliberately does not check `exponent` against the registry —
 * ADR-0014 keeps the wire type able to carry a historical exponent, so an old
 * quote stays readable after the registry changes. That freedom must not extend
 * to INBOUND data: a request that declares COP at exponent 2 is either a
 * client bug or an attempt to move the decimal point, and either way it must
 * not reach the pricing kernel.
 *
 * Use this schema for every request body field; keep plain `Money` for stored
 * and returned values.
 *
 * `.superRefine`, not `.refine`. Zod 4 removed `.refine`'s function-params
 * overload: the signature is now
 * `refine(check, params?: string | core.$ZodCustomParams)` and
 * `$ZodCustomParams` is an OBJECT (`{ path?, error?, … }`), so passing a
 * `(value) => ({ … })` callback is a TS2345. A per-value message therefore has
 * to come from `ctx.addIssue`. (`message` is also deprecated in Zod 4 in favour
 * of `error` — inside `addIssue` it is still the field name, which is why it
 * appears below.) Verified against the installed zod@4.4.3 with TS 6.0.3: this
 * form compiles, and `issues[0].path` is `['exponent']`.
 */
export const MoneyRequest = Money.superRefine((value, ctx) => {
  const expected = CURRENCY_REGISTRY[value.currency].exponent;
  if (value.exponent !== expected) {
    ctx.addIssue({
      code: 'custom',
      path: ['exponent'],
      message: `${value.currency} uses exponent ${String(expected)}, not ${String(value.exponent)}`,
    });
  }
});
