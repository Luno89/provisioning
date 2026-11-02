import { emptiedEachTime } from '../../platform/lib/test-database.js';
import { vpsCatalogBehaviour } from '../testing/vps-catalog-behaviour.js';

vpsCatalogBehaviour(await emptiedEachTime());
