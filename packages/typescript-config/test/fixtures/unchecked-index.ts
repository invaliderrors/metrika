export function first(items: readonly string[]): string {
  const value = items[0];
  return value.toUpperCase(); // noUncheckedIndexedAccess: value is string | undefined
}
