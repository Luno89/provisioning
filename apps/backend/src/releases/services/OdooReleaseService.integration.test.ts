import { emptiedEachTime } from '../../platform/lib/test-database.js';
import { odooReleaseServiceBehaviour } from '../testing/odoo-release-service-behaviour.js';

const fresh = await emptiedEachTime();

odooReleaseServiceBehaviour(() => fresh());
