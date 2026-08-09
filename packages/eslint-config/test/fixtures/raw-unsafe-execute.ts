interface RawClient {
  $executeRawUnsafe(query: string): Promise<number>;
}

export async function purge(client: RawClient, name: string): Promise<number> {
  return client.$executeRawUnsafe(`DELETE FROM "RlsProbe" WHERE label = '${name}'`);
}
