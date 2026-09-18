import { GoogleGenAI } from '@google/genai';
import { prisma } from '../lib/prisma.js';

export class RagService {
  private ai: GoogleGenAI | null = null;

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey) {
      this.ai = new GoogleGenAI({ apiKey });
    }
  }

  /**
   * Split text into semantic chunks with overlap
   */
  splitIntoChunks(text: string, chunkSize = 400, overlap = 50): string[] {
    const cleaned = text.trim();
    if (!cleaned) return [];
    if (cleaned.length <= chunkSize) return [cleaned];

    const chunks: string[] = [];
    let start = 0;

    while (start < cleaned.length) {
      let end = start + chunkSize;
      if (end < cleaned.length) {
        // Try to break at a sentence or word boundary
        const lastPeriod = cleaned.lastIndexOf('.', end);
        const lastSpace = cleaned.lastIndexOf(' ', end);
        if (lastPeriod > start + chunkSize * 0.6) {
          end = lastPeriod + 1;
        } else if (lastSpace > start + chunkSize * 0.6) {
          end = lastSpace;
        }
      } else {
        end = cleaned.length;
      }

      const chunk = cleaned.slice(start, end).trim();
      if (chunk) chunks.push(chunk);

      start = end - overlap;
      if (start >= cleaned.length - overlap) break;
    }

    return chunks;
  }

  /**
   * Generate 768-dimensional embedding vector
   */
  async generateEmbedding(text: string): Promise<number[]> {
    if (this.ai) {
      try {
        const response = await this.ai.models.embedContent({
          model: 'text-embedding-004',
          contents: text,
        });

        const values = (response as any).embeddings?.[0]?.values || (response as any).embedding?.values;
        if (values && values.length > 0) {
          return values;
        }
      } catch (err) {
        console.warn('Gemini embedding API call failed, using deterministic fallback:', err);
      }
    }

    // Deterministic 768-dim normalized embedding fallback
    return this.createDeterministicVector(text, 768);
  }

  /**
   * Ingest and replace all chunks for a ContentItem
   */
  async chunkAndEmbedContentItem(
    tenantId: string,
    contentItemId: string,
    rawText: string
  ): Promise<number> {
    // 1. Delete previous chunks for this item
    await prisma.$executeRawUnsafe(
      `DELETE FROM content_chunks WHERE tenant_id = $1 AND content_item_id = $2`,
      tenantId,
      contentItemId
    );

    // 2. Chunk text
    const chunks = this.splitIntoChunks(rawText);
    if (!chunks.length) return 0;

    // 3. Generate embeddings and save
    for (let i = 0; i < chunks.length; i++) {
      const chunkText = chunks[i];
      const vector = await this.generateEmbedding(chunkText);
      const vectorStr = `[${vector.join(',')}]`;

      await prisma.$executeRawUnsafe(
        `INSERT INTO content_chunks (id, tenant_id, content_item_id, chunk_index, chunk_text, embedding, created_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::vector, NOW())`,
        tenantId,
        contentItemId,
        i,
        chunkText,
        vectorStr
      );
    }

    return chunks.length;
  }

  /**
   * Semantic search using pgvector cosine distance
   */
  async searchSimilarChunks(
    tenantId: string,
    queryText: string,
    limit = 5
  ): Promise<
    Array<{
      id: string;
      contentItemId: string;
      chunkIndex: number;
      chunkText: string;
      similarity: number;
    }>
  > {
    const queryVector = await this.generateEmbedding(queryText);
    const vectorStr = `[${queryVector.join(',')}]`;

    const results: any = await prisma.$queryRawUnsafe(
      `SELECT id, content_item_id, chunk_index, chunk_text,
              ROUND((1 - (embedding <=> $1::vector))::numeric, 4) AS similarity
       FROM content_chunks
       WHERE tenant_id = $2 AND embedding IS NOT NULL
       ORDER BY embedding <=> $1::vector ASC
       LIMIT $3`,
      vectorStr,
      tenantId,
      limit
    );

    return results.map((r: any) => ({
      id: r.id,
      contentItemId: r.content_item_id,
      chunkIndex: r.chunk_index,
      chunkText: r.chunk_text,
      similarity: parseFloat(r.similarity),
    }));
  }

  /**
   * Helper to generate a normalized 768-dim vector from text hash
   */
  private createDeterministicVector(text: string, dimensions = 768): number[] {
    const vec = new Array(dimensions).fill(0);
    let hash = 0;

    for (let i = 0; i < text.length; i++) {
      hash = (hash << 5) - hash + text.charCodeAt(i);
      hash |= 0;
      const idx = Math.abs(hash) % dimensions;
      vec[idx] += 1;
    }

    // Normalize to unit length
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1;
    return vec.map((v) => parseFloat((v / norm).toFixed(6)));
  }
}

export const ragService = new RagService();
