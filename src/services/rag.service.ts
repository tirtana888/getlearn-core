import { GoogleGenAI } from '@google/genai';
import { ContentType } from '@prisma/client';
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
   * Extract text from multimodal source_uri (PDF or Video) via Gemini
   */
  async extractTextFromSource(type: ContentType, sourceUri: string): Promise<string> {
    if (type === ContentType.scorm) {
      // SCORM package parsing is handled on the LMS connector side (e.g. Nusadaya LMS fork).
      // getlearn-core does not scrape SCORM packages directly; connectors must supply raw_text.
      throw new Error('SCORM content extraction is handled on the LMS connector side. Please provide raw_text directly.');
    }

    if (type === ContentType.text) {
      return '';
    }

    if (!sourceUri || !sourceUri.trim()) {
      throw new Error('Source URI is empty or invalid.');
    }

    if (!this.ai) {
      throw new Error('GEMINI_API_KEY is not configured on the server. Multimodal extraction requires Gemini.');
    }

    if (type === ContentType.pdf) {
      return this.extractFromPdf(sourceUri);
    }

    if (type === ContentType.video) {
      return this.extractFromVideo(sourceUri);
    }

    throw new Error(`Unsupported content type for extraction: ${type}`);
  }

  private async extractFromPdf(sourceUri: string): Promise<string> {
    // 1. Fetch PDF binary from sourceUri
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000); // 60s timeout
    let res: Response;
    try {
      res = await fetch(sourceUri, { signal: controller.signal });
    } catch (err: any) {
      if (err.name === 'AbortError') {
        throw new Error(`Network timeout fetching PDF from ${sourceUri} (exceeded 60s)`);
      }
      throw new Error(`Failed to fetch PDF from ${sourceUri}: ${err.message}`);
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      throw new Error(`HTTP error ${res.status} ${res.statusText} fetching PDF from ${sourceUri}`);
    }

    const blob = await res.blob();
    if (blob.size === 0) {
      throw new Error(`Fetched PDF from ${sourceUri} is empty (0 bytes)`);
    }

    // 2. Upload to Gemini Files API
    let uploadedFile = await this.ai!.files.upload({
      file: blob,
      config: {
        mimeType: 'application/pdf',
      },
    });

    try {
      // Poll if processing
      let attempts = 0;
      while (uploadedFile.state === 'PROCESSING' && attempts < 30) {
        await new Promise((r) => setTimeout(r, 1500));
        uploadedFile = await this.ai!.files.get({ name: uploadedFile.name! });
        attempts++;
      }

      if (uploadedFile.state === 'FAILED') {
        const msg = (uploadedFile as any).error?.message || 'unknown error';
        throw new Error(`Gemini File processing failed for PDF: ${msg}`);
      }

      // 3. Generate structured text extraction
      const response = await this.ai!.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [
          {
            fileData: {
              fileUri: uploadedFile.uri,
              mimeType: uploadedFile.mimeType || 'application/pdf',
            },
          },
          {
            text: 'Ekstrak seluruh konten teks dari dokumen ini secara lengkap dan akurat. Pertahankan struktur dokumen termasuk judul, subjudul, paragraf, daftar, dan tabel. Jangan membuat ringkasan, ekstrak teks aslinya secara utuh untuk materi pembelajaran.',
          },
        ],
      });

      const extracted = response.text?.trim() || '';
      if (!extracted) {
        throw new Error('Gemini extracted empty text from PDF document');
      }
      return extracted;
    } finally {
      // Clean up uploaded file on Gemini
      if (uploadedFile?.name) {
        this.ai!.files.delete({ name: uploadedFile.name }).catch(() => {});
      }
    }
  }

  private async extractFromVideo(sourceUri: string): Promise<string> {
    const isYouTube = /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)/i.test(sourceUri);

    if (isYouTube) {
      // Public YouTube videos are natively supported by Gemini via fileData.fileUri without downloading
      const response = await this.ai!.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [
          {
            fileData: {
              fileUri: sourceUri,
            },
          },
          {
            text: 'Transkripsikan dan ekstrak seluruh isi materi penjelasan, konsep penting, rumus, dan instruksi dari video pembelajaran ini secara detail, mendalam, dan terstruktur.',
          },
        ],
      });

      const extracted = response.text?.trim() || '';
      if (!extracted) {
        throw new Error('Gemini extracted empty text from YouTube video');
      }
      return extracted;
    }

    // Direct / self-hosted video: fetch and upload to Gemini Files API
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000); // 120s timeout
    let res: Response;
    try {
      res = await fetch(sourceUri, { signal: controller.signal });
    } catch (err: any) {
      if (err.name === 'AbortError') {
        throw new Error(`Network timeout fetching video from ${sourceUri} (exceeded 120s)`);
      }
      throw new Error(`Failed to fetch video from ${sourceUri}: ${err.message}`);
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      throw new Error(`HTTP error ${res.status} ${res.statusText} fetching video from ${sourceUri}`);
    }

    const blob = await res.blob();
    const mimeType = res.headers.get('content-type') || 'video/mp4';

    let uploadedFile = await this.ai!.files.upload({
      file: blob,
      config: { mimeType },
    });

    try {
      let attempts = 0;
      while (uploadedFile.state === 'PROCESSING' && attempts < 40) {
        await new Promise((r) => setTimeout(r, 2000));
        uploadedFile = await this.ai!.files.get({ name: uploadedFile.name! });
        attempts++;
      }

      if (uploadedFile.state === 'FAILED') {
        const msg = (uploadedFile as any).error?.message || 'unknown error';
        throw new Error(`Gemini File processing failed for video: ${msg}`);
      }

      const response = await this.ai!.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [
          {
            fileData: {
              fileUri: uploadedFile.uri,
              mimeType: uploadedFile.mimeType || mimeType,
            },
          },
          {
            text: 'Transkripsikan dan ekstrak seluruh isi materi penjelasan, konsep penting, dan instruksi dari video pembelajaran ini secara terstruktur.',
          },
        ],
      });

      const extracted = response.text?.trim() || '';
      if (!extracted) {
        throw new Error('Gemini extracted empty text from video file');
      }
      return extracted;
    } finally {
      if (uploadedFile?.name) {
        this.ai!.files.delete({ name: uploadedFile.name }).catch(() => {});
      }
    }
  }

  /**
   * Helper to generate a normalized 768-dim vector from text hash
   */
  private createDeterministicVector(text: string, dimensions = 768): number[] {
    const vec = new Array(dimensions).fill(0);
    const tokens = text.toLowerCase().match(/\w+/g) || [];

    for (const token of tokens) {
      // Whole word feature (higher weight)
      let wh = 0;
      for (let i = 0; i < token.length; i++) {
        wh = (wh * 31 + token.charCodeAt(i)) % dimensions;
      }
      vec[Math.abs(wh)] += 5;

      // Character trigrams (subword feature)
      for (let i = 0; i <= token.length - 3; i++) {
        let th = 0;
        for (let j = i; j < i + 3; j++) {
          th = (th * 37 + token.charCodeAt(j)) % dimensions;
        }
        vec[Math.abs(th)] += 2;
      }
    }

    // Normalize to unit length for cosine similarity
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1;
    return vec.map((v) => parseFloat((v / norm).toFixed(6)));
  }
}

export const ragService = new RagService();
