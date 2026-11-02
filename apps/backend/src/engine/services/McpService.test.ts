import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { mcpServiceBehaviour } from '../testing/mcp-service-behaviour.js';

mcpServiceBehaviour(async () => memoryDatabase());
