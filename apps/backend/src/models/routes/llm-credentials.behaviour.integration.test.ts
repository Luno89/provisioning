import { emptiedEachTime } from '../../platform/lib/test-database.js';
import { llmCredentialsBehaviour } from '../testing/llm-credentials-behaviour.js';

llmCredentialsBehaviour(await emptiedEachTime());
