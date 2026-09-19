import { GoogleGenAI } from '@google/genai';
import { ContentType } from '@prisma/client';
import JSZip from 'jszip';
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
          model: 'gemini-embedding-001',
          contents: text,
          config: { outputDimensionality: 768 },
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
    // Pre-flight check: verify tenant token balance before executing embeddings
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { tokenBalance: true },
    });
    if (tenant && tenant.tokenBalance <= 0) {
      const err: any = new Error('Tenant token balance is exhausted. Please top up credits to index content.');
      err.code = 'TOKEN_BALANCE_EXHAUSTED';
      err.statusCode = 402;
      throw err;
    }

    // 1. Delete previous chunks for this item
    await prisma.$executeRawUnsafe(
      `DELETE FROM content_chunks WHERE tenant_id = $1 AND content_item_id = $2`,
      tenantId,
      contentItemId
    );

    // 2. Chunk text
    const chunks = this.splitIntoChunks(rawText);
    if (!chunks.length) return 0;

    let totalEmbeddingTokens = 0;

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

      // Conservative fixed estimation: @google/genai embedContent (Developer API) does not return usageMetadata.
      // Standard token estimate for text-embedding-004 is ~1 token per 4 characters.
      const estChunkTokens = Math.max(1, Math.ceil(chunkText.length / 4));
      totalEmbeddingTokens += estChunkTokens;
    }

    // Deduct tokens from tenant balance for successfully embedded chunks
    if (totalEmbeddingTokens > 0) {
      await prisma.tenant.update({
        where: { id: tenantId },
        data: { tokenBalance: { decrement: totalEmbeddingTokens } },
      });
    }

    return chunks.length;
  }

  /**
   * Returns true if Gemini embedding model is configured and active
   */
  hasGeminiEmbeddings(): boolean {
    return this.ai !== null;
  }

  /**
   * Semantic search using pgvector cosine distance
   */
  async searchSimilarChunks(
    tenantId: string,
    queryText: string,
    limit = 5,
    minSimilarity?: number,
    contentItemIds?: string[]
  ): Promise<
    Array<{
      id: string;
      contentItemId: string;
      chunkIndex: number;
      chunkText: string;
      similarity: number;
    }>
  > {
    // Pre-flight check: verify tenant token balance before query vectorization
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { tokenBalance: true },
    });
    if (tenant && tenant.tokenBalance <= 0) {
      const err: any = new Error('Tenant token balance is exhausted. Please top up credits to search content.');
      err.code = 'TOKEN_BALANCE_EXHAUSTED';
      err.statusCode = 402;
      throw err;
    }

    const queryVector = await this.generateEmbedding(queryText);

    // Conservative fixed estimation: query text embedding (~1 token per 4 characters)
    const estQueryTokens = Math.max(1, Math.ceil(queryText.length / 4));
    await prisma.tenant.update({
      where: { id: tenantId },
      data: { tokenBalance: { decrement: estQueryTokens } },
    });

    const vectorStr = `[${queryVector.join(',')}]`;

    // Optional restriction to specific content items (e.g. the lessons a chat session is scoped to).
    const scoped = Array.isArray(contentItemIds) && contentItemIds.length > 0;
    const results: any = await prisma.$queryRawUnsafe(
      `SELECT id, content_item_id, chunk_index, chunk_text,
              ROUND((1 - (embedding <=> $1::vector))::numeric, 4) AS similarity
       FROM content_chunks
       WHERE tenant_id = $2 AND embedding IS NOT NULL
       ${scoped ? 'AND content_item_id = ANY($4::text[])' : ''}
       ORDER BY embedding <=> $1::vector ASC
       LIMIT $3`,
      vectorStr,
      tenantId,
      limit,
      ...(scoped ? [contentItemIds] : [])
    );

    const mapped = results.map((r: any) => ({
      id: r.id,
      contentItemId: r.content_item_id,
      chunkIndex: r.chunk_index,
      chunkText: r.chunk_text,
      similarity: parseFloat(r.similarity),
    }));

    if (typeof minSimilarity === 'number') {
      return mapped.filter((r: any) => r.similarity >= minSimilarity);
    }

    return mapped;
  }

  /**
   * Extract text from multimodal source_uri (PDF or Video) via Gemini
   */
  async extractTextFromSource(
    type: ContentType,
    sourceUri: string,
    tenantId?: string
  ): Promise<string> {
    if (type === ContentType.text) {
      return '';
    }

    if (!sourceUri || !sourceUri.trim()) {
      throw new Error('Source URI is empty or invalid.');
    }

    if (type === ContentType.scorm) {
      // Mechanical HTML extraction — no Gemini call, no token cost, works even without GEMINI_API_KEY.
      return this.extractFromScorm(sourceUri);
    }

    if (!this.ai) {
      throw new Error('GEMINI_API_KEY is not configured on the server. Multimodal extraction requires Gemini.');
    }

    if (tenantId) {
      const tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { tokenBalance: true },
      });
      if (tenant && tenant.tokenBalance <= 0) {
        const err: any = new Error('Tenant token balance is exhausted. Please top up credits to extract content.');
        err.code = 'TOKEN_BALANCE_EXHAUSTED';
        err.statusCode = 402;
        throw err;
      }
    }

    if (type === ContentType.pdf) {
      return this.extractFromPdf(sourceUri, tenantId);
    }

    if (type === ContentType.video) {
      return this.extractFromVideo(sourceUri, tenantId);
    }

    throw new Error(`Unsupported content type for extraction: ${type}`);
  }

  private async extractFromPdf(sourceUri: string, tenantId?: string): Promise<string> {
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

      // Deduct actual tokens from usageMetadata if available; otherwise conservative estimate
      if (tenantId) {
        const tokensUsed = response.usageMetadata?.totalTokenCount 
          ?? Math.max(1, Math.ceil(extracted.length / 4));
        await prisma.tenant.update({
          where: { id: tenantId },
          data: { tokenBalance: { decrement: tokensUsed } },
        });
      }

      return extracted;
    } finally {
      // Clean up uploaded file on Gemini
      if (uploadedFile?.name) {
        this.ai!.files.delete({ name: uploadedFile.name }).catch(() => {});
      }
    }
  }

  private async extractFromVideo(sourceUri: string, tenantId?: string): Promise<string> {
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

      if (tenantId) {
        const tokensUsed = response.usageMetadata?.totalTokenCount 
          ?? Math.max(1, Math.ceil(extracted.length / 4));
        await prisma.tenant.update({
          where: { id: tenantId },
          data: { tokenBalance: { decrement: tokensUsed } },
        });
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

      if (tenantId) {
        const tokensUsed = response.usageMetadata?.totalTokenCount 
          ?? Math.max(1, Math.ceil(extracted.length / 4));
        await prisma.tenant.update({
          where: { id: tenantId },
          data: { tokenBalance: { decrement: tokensUsed } },
        });
      }

      return extracted;
    } finally {
      if (uploadedFile?.name) {
        this.ai!.files.delete({ name: uploadedFile.name }).catch(() => {});
      }
    }
  }

  /** SCORM extraction for a package behind authentication (e.g. a private Frappe file). */
  async extractScormFromUrl(url: string, headers?: Record<string, string>): Promise<string> {
    return this.extractFromScorm(url, headers);
  }

  /**
   * Extract text from a SCORM package. source_uri may point to either:
   *  - a downloadable .zip of the whole package (most SCORM exports, incl. Easygenerator), or
   *  - a single launch HTML page (if the connector only exposes the unzipped entry point).
   * Which one it is gets detected by sniffing the fetched bytes for the ZIP magic number,
   * not by file extension.
   */
  private async extractFromScorm(sourceUri: string, headers?: Record<string, string>): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000); // 120s: real packages run to tens of MB
    let res: Response;
    try {
      res = await fetch(sourceUri, { signal: controller.signal, headers });
    } catch (err: any) {
      if (err.name === 'AbortError') {
        throw new Error(`Network timeout fetching SCORM package from ${sourceUri} (exceeded 120s)`);
      }
      throw new Error(`Failed to fetch SCORM package from ${sourceUri}: ${err.message}`);
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      throw new Error(`HTTP error ${res.status} ${res.statusText} fetching SCORM package from ${sourceUri}`);
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) {
      throw new Error(`Fetched SCORM source from ${sourceUri} is empty (0 bytes)`);
    }

    const isZip = buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;

    if (!isZip) {
      // Not a zip - treat as a single launch page. Only covers that one page's text,
      // which is usually incomplete for a multi-slide SCORM package.
      const text = this.stripHtml(buf.toString('utf-8'));
      if (!text) {
        throw new Error(
          `SCORM source_uri did not return a zip package or extractable HTML text: ${sourceUri}`
        );
      }
      return text;
    }

    const zip = await JSZip.loadAsync(buf);
    const htmlPaths = Object.keys(zip.files)
      .filter((path) => !zip.files[path].dir)
      .filter((path) => /\.(html?|xhtml)$/i.test(path))
      // Skip SCORM runtime/API scaffold pages, not actual lesson content
      .filter((path) => !/api[_-]?wrapper|scorm[_-]?api|imsmanifest/i.test(path))
      .sort();

    if (!htmlPaths.length) {
      throw new Error(`SCORM package at ${sourceUri} contains no HTML content files to extract`);
    }

    const pageTexts: string[] = [];
    for (const path of htmlPaths) {
      const raw = await zip.files[path].async('string');
      const text = this.stripHtml(raw);
      if (text) pageTexts.push(text);
    }

    const combined = pageTexts.join('\n\n---\n\n');
    if (!combined) {
      throw new Error(`SCORM package at ${sourceUri} had HTML files but no visible text after stripping markup`);
    }
    return combined;
  }

  /**
   * Crude but dependency-free HTML-to-text: drops script/style/comments, strips tags,
   * unescapes common entities, and collapses whitespace.
   */
  private stripHtml(html: string): string {
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
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
