import { Hopeless, waitUntil } from '@koala/provision';

export { Hopeless };

export const until = <T>(what: string, look: () => Promise<T | undefined | false | null>, ended?: () => Promise<string | undefined | false | void>): Promise<T> =>
  waitUntil(what, look, ended, { waiting: (waited, last) => { console.log(`    still waiting for ${waited}${last ? ` (${last})` : ''}`); } });
