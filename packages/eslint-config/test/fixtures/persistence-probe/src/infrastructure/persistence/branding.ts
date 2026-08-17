export function brandUnsafe<T>(value: string): T {
  return value as unknown as T;
}
