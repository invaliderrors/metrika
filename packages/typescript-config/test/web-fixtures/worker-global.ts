export async function digest(input: string): Promise<ArrayBuffer> {
  return globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
}
