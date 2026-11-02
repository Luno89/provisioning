import { emptiedEachTime } from '../../platform/lib/test-database.js';
import { fileServiceBehaviour } from '../testing/file-service-behaviour.js';

const fresh = await emptiedEachTime();

fileServiceBehaviour(fresh);
