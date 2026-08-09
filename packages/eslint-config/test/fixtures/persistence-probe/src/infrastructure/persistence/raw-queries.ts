interface RawClient {
  $queryRawUnsafe(query: string): Promise<unknown>;
  $executeRawUnsafe(query: string): Promise<number>;
}

export async function lookup(client: RawClient, name: string): Promise<unknown> {
  return client.$queryRawUnsafe(`SELECT * FROM "RlsProbe" WHERE label = '${name}'`);
}

export async function purge(client: RawClient, name: string): Promise<number> {
  return client.$executeRawUnsafe(`DELETE FROM "RlsProbe" WHERE label = '${name}'`);
}
