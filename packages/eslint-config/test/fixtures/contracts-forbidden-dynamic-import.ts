export async function hash(input: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(input).digest('hex');
}
