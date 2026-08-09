interface RawClient {
  $queryRawUnsafe(query: string): Promise<unknown>;
}

export async function lookup(client: RawClient, name: string): Promise<unknown> {
  return client.$queryRawUnsafe(`SELECT * FROM "RlsProbe" WHERE label = '${name}'`);
}
