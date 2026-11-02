import { emptiedEachTime } from '../../platform/lib/test-database.js';
import { clientImportBehaviour } from '../testing/client-import-behaviour.js';

const fresh = await emptiedEachTime();

clientImportBehaviour(fresh);
