export interface MongoTarget {
  uri: string;
  dbName: string;
  e2e: boolean;
}

export const databaseOf = (uri: string): string => {
  const name = uri.replace(/^mongodb(\+srv)?:\/\/[^/]+\/?/, '').split('?')[0]?.trim();
  return name || 'provisioning';
};

export function mongoTarget(env: Readonly<Record<string, string | undefined>>): MongoTarget {
  const base = env.MONGO_URI?.trim();
  if (!base) throw new Error('MONGO_URI is not set: it is the Mongo this process keeps its records in');
  if (!/^mongodb(\+srv)?:\/\//.test(base)) throw new Error('MONGO_URI is not a mongodb:// address');
  const e2e = env.IS_E2E === 'true';
  if (e2e) return { uri: env.MONGO_TEST_URI || base.replace('/provisioning', '/provisioning_test'), dbName: 'provisioning_test', e2e };
  return { uri: base, dbName: databaseOf(base), e2e };
}
