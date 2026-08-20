/**
 * Semantic Memory RAG Service for Harness V2.
 *
 * Implements two-tier memory with vector embedding retrieval using local TEI / Qdrant services.
 */
import axios from 'axios';

export interface MemoryFact {
  id: string;
  scope: 'global' | 'project' | 'task';
  projectId?: string;
  category: string;
  title: string;
  text: string;
  embedding?: number[];
  createdAt: string;
}

export class SemanticRag {
  private teiEndpoint: string;
  private qdrantEndpoint: string;

  constructor(
    teiEndpoint: string = process.env.TEI_ENDPOINT || 'http://localhost:8080',
    qdrantEndpoint: string = process.env.QDRANT_ENDPOINT || 'http://localhost:6333',
  ) {
    this.teiEndpoint = teiEndpoint;
    this.qdrantEndpoint = qdrantEndpoint;
  }

  /**
   * Generates a vector embedding for a text query using TEI.
   */
  async getEmbedding(text: string): Promise<number[] | null> {
    try {
      const res = await axios.post(`${this.teiEndpoint}/embed`, { inputs: text }, { timeout: 3000 });
      if (Array.isArray(res.data) && Array.isArray(res.data[0])) {
        return res.data[0];
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Retrieves the top-K semantically relevant memory facts for a task.
   */
  async retrieveRelevantFacts(taskPrompt: string, availableMemories: MemoryFact[], limit: number = 3): Promise<MemoryFact[]> {
    if (!availableMemories.length) return [];

    const queryEmbedding = await this.getEmbedding(taskPrompt);

    // If vector service is available and embeddings exist, score via cosine similarity
    if (queryEmbedding) {
      const scored = availableMemories.map((mem) => ({
        mem,
        score: mem.embedding ? this.cosineSimilarity(queryEmbedding, mem.embedding) : 0,
      }));

      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, limit).map((s) => s.mem);
    }

    // Fallback: Lexical keyword overlap scoring
    const queryTokens = new Set(taskPrompt.toLowerCase().split(/\W+/).filter(Boolean));
    const scored = availableMemories.map((mem) => {
      const memTokens = `${mem.title} ${mem.text}`.toLowerCase().split(/\W+/).filter(Boolean);
      let matchCount = 0;
      for (const t of memTokens) {
        if (queryTokens.has(t)) matchCount++;
      }
      return { mem, score: matchCount };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => s.mem);
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      const ai = a[i] ?? 0;
      const bi = b[i] ?? 0;
      dot += ai * bi;
      normA += ai * ai;
      normB += bi * bi;
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}
