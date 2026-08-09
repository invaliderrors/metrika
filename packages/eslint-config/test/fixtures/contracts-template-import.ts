export async function load(): Promise<unknown> {
  return import(`node:crypto`);
}
