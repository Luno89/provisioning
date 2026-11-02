import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { llmCredentialsBehaviour } from '../testing/llm-credentials-behaviour.js';

llmCredentialsBehaviour(async () => memoryDatabase());
