import type { MongoClient, ServerDescriptionChangedEvent } from 'mongodb';

export const REPLICA_SET_NEEDED = 'Mongo runs on its own, not as a replica set: Koala follows records as they change through change streams, which need one. Start mongod with --replSet rs0, as docker-compose.mongo.yml and the instance chart do.';

const ALREADY_INITIALIZED = 23;

interface Hello { setName?: string; isWritablePrimary?: boolean; isreplicaset?: boolean }
interface CommandLine { parsed?: { replication?: { replSetName?: string; replSet?: string }; net?: { port?: number } } }

export function replicaSetConfig(commandLine: CommandLine): { _id: string; members: Array<{ _id: number; host: string }> } {
  const name = commandLine.parsed?.replication?.replSetName ?? commandLine.parsed?.replication?.replSet;
  if (!name) throw new Error(REPLICA_SET_NEEDED);
  return { _id: name, members: [{ _id: 0, host: `127.0.0.1:${commandLine.parsed?.net?.port ?? 27017}` }] };
}

const member = (hello: Hello): boolean => Boolean(hello.setName || hello.isreplicaset);

export async function replicaSetProblem(client: MongoClient): Promise<string | undefined> {
  return member(await client.db('admin').command({ hello: 1 }) as Hello) ? undefined : REPLICA_SET_NEEDED;
}

function becomesPrimary(client: MongoClient): { promise: Promise<void>; stop: () => void } {
  let listener: ((event: ServerDescriptionChangedEvent) => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    listener = (event) => { if (event.newDescription.type === 'RSPrimary') resolve(); };
    client.on('serverDescriptionChanged', listener);
  });
  return { promise, stop: () => { if (listener) client.off('serverDescriptionChanged', listener); } };
}

export async function ensureReplicaSet(client: MongoClient): Promise<void> {
  const admin = client.db('admin');
  const primary = becomesPrimary(client);
  try {
    const hello = await admin.command({ hello: 1 }) as Hello;
    if (hello.setName && hello.isWritablePrimary) return;
    if (!member(hello)) throw new Error(REPLICA_SET_NEEDED);
    if (!hello.setName) {
      const config = replicaSetConfig(await admin.command({ getCmdLineOpts: 1 }) as CommandLine);
      try {
        await admin.command({ replSetInitiate: config });
      } catch (err) {
        if ((err as { code?: number }).code !== ALREADY_INITIALIZED) throw err;
      }
    }
    await primary.promise;
  } finally {
    primary.stop();
  }
}
