import { z } from 'zod';

/**
 * Helper for producing branded Zod schemas.
 * Brand makes a primitive type nominally distinct at the type level —
 * passing a `ProjectId` where a `ModelId` belongs is a compile error.
 */
export const brandedUuid = <B extends string>(brand: B) => z.string().uuid().brand<B>();

export const brandedString = <B extends string>(brand: B) => z.string().brand<B>();

/**
 * Phantom type helper used where Zod inference is not available (e.g. class fields).
 * Prefer the Zod schemas above for runtime validation.
 */
export type Brand<T, K extends string> = T & { readonly __brand: K };
