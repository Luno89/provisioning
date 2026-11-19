import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { odooReleaseServiceBehaviour } from '../testing/odoo-release-service-behaviour.js';

odooReleaseServiceBehaviour(async () => memoryDatabase());
