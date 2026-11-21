import { dependencyFetch } from '@koala/engine-core/http';
import { reachingMemoryIndex, type DependencyReporter, type MemoryIndexReach } from '../lib/dependencies.js';
import type { MemoryIndex } from '../lib/settings.js';

const unreported: DependencyReporter = { failed: (_dependency, error) => error, answered: () => undefined };

export const unreportedReach = (index: MemoryIndex): MemoryIndexReach => reachingMemoryIndex(index, unreported, dependencyFetch);

export const QUICKWIT = 'http://quickwit.test:7280';
export const QDRANT = 'http://qdrant.test:6333';
export const TEI = 'http://tei.test';

export const intercepted: MemoryIndex = { index: { base: QUICKWIT }, vectors: { base: QDRANT, apiKey: 'k' }, embeddings: { base: TEI } };

export const quickwitAt = (base: string): MemoryIndexReach['index'] => unreportedReach({ ...intercepted, index: { base } }).index;
export const qdrantAt = (base: string): MemoryIndexReach['vectors'] => unreportedReach({ ...intercepted, vectors: { base, apiKey: 'k' } }).vectors;
