import { emptiedEachTime } from '../../platform/lib/test-database.js';
import { mcpServiceBehaviour } from '../testing/mcp-service-behaviour.js';

mcpServiceBehaviour(await emptiedEachTime());
