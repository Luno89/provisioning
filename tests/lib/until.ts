import { Hopeless, waiting, waitUntil, type Found, type Waiting } from '@koala/provision';

export { Hopeless, waiting };

export const until = <T extends Found>(what: string, look: () => Promise<T | Waiting>, ended?: () => Promise<string | undefined | false | void>): Promise<T> =>
  waitUntil(what, look, ended, { waiting: (waited, last) => { console.log(`    still waiting for ${waited}${last ? ` (${last})` : ''}`); } });
