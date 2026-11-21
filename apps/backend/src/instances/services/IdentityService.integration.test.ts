import { emptiedEachTime } from '../../platform/lib/test-database.js';
import { signingInAtRoot } from '../testing/identity-service-behaviour.js';

const fresh = await emptiedEachTime();

signingInAtRoot(() => fresh());
