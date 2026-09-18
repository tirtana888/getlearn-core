import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authMiddleware } from '../../middlewares/auth.middleware.js';
import { ragService } from '../../services/rag.service.js';
import { ContentType, IndexingStatus } from '@prisma/client';

const ContentItemInputSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['text', 'video', 'pdf', 'scorm']),
  source_uri: z.string().optional().nullable(),
  raw_text: z.string().optional().nullable(),
  objective_ids: z.array(z.string()).default([]),
});

const SearchQuerySchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(20).default(5),
});

export async function contentItemRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  // POST /v1/content-items
  app.post('/v1/content-items', async (req, reply) => {
    const parseResult = ContentItemInputSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: {
          code: 'INVALID_PAYLOAD',
          message: 'Validation failed',
          details: parseResult.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`),
        },
      });
    }

    const { id, type, source_uri, raw_text, objective_ids } = parseResult.data;

    const hasRawText = Boolean(raw_text && raw_text.trim());
    const hasSourceUri = Boolean(source_uri && source_uri.trim());

    // Determine initial indexing status:
    // - If raw_text is supplied: completed immediately (or skipped if empty text)
    // - If type is pdf/video and source_uri is supplied without raw_text: pending (background multimodal extraction)
    // - If scorm: skipped (SCORM package extraction is handled by the LMS connector side)
    // - Otherwise: skipped
    let initialStatus: IndexingStatus;
    if (hasRawText) {
      initialStatus = IndexingStatus.completed;
    } else if (hasSourceUri && (type === 'pdf' || type === 'video')) {
      initialStatus = IndexingStatus.pending;
    } else {
      initialStatus = IndexingStatus.skipped;
    }

    const contentItem = await prisma.contentItem.upsert({
      where: {
        tenantId_id: {
          tenantId: req.tenantId,
          id,
        },
      },
      update: {
        type: type as ContentType,
        sourceUri: source_uri ?? null,
        rawText: raw_text ?? null,
        objectiveIds: objective_ids,
        indexingStatus: initialStatus,
        indexingError: null,
      },
      create: {
        id,
        tenantId: req.tenantId,
        type: type as ContentType,
        sourceUri: source_uri ?? null,
        rawText: raw_text ?? null,
        objectiveIds: objective_ids,
        indexingStatus: initialStatus,
        indexingError: null,
      },
    });

    // Pre-flight check: reject immediately with HTTP 402 if tenant balance is depleted
    if ((hasRawText || initialStatus === IndexingStatus.pending) && req.tenant.tokenBalance <= 0) {
      return reply.status(402).send({
        error: {
          code: 'TOKEN_BALANCE_EXHAUSTED',
          message: 'Tenant token balance is exhausted. Please top up credits to index content.',
        },
      });
    }

    // Case 1: raw_text is directly provided (synchronous chunk & embed)
    if (hasRawText) {
      try {
        const chunksCount = await ragService.chunkAndEmbedContentItem(req.tenantId, contentItem.id, raw_text!);
        return reply.status(200).send({
          id: contentItem.id,
          type: contentItem.type,
          source_uri: contentItem.sourceUri,
          objective_ids: contentItem.objectiveIds,
          tenant_id: contentItem.tenantId,
          indexing_status: IndexingStatus.completed,
          indexing_error: null,
          chunks_indexed: chunksCount,
        });
      } catch (err: any) {
        if (err.code === 'TOKEN_BALANCE_EXHAUSTED' || err.statusCode === 402) {
          return reply.status(402).send({
            error: {
              code: 'TOKEN_BALANCE_EXHAUSTED',
              message: err.message || 'Tenant token balance is exhausted.',
            },
          });
        }
        throw err;
      }
    }

    // Case 2: Multimodal extraction required (type pdf/video with source_uri)
    if (initialStatus === IndexingStatus.pending) {
      const tenantId = req.tenantId;
      const itemId = contentItem.id;
      const itemType = type as ContentType;
      const source = source_uri!;

      // Fire-and-forget in-process background worker
      (async () => {
        try {
          app.log.info(`[ContentItem Indexing] Starting Gemini extraction for item '${itemId}' (${itemType}) from '${source}'`);
          const extractedText = await ragService.extractTextFromSource(itemType, source, tenantId);

          // Save extracted text to rawText
          await prisma.contentItem.update({
            where: { tenantId_id: { tenantId, id: itemId } },
            data: { rawText: extractedText },
          });

          // Chunk and embed into pgvector
          const chunksCount = await ragService.chunkAndEmbedContentItem(tenantId, itemId, extractedText);

          // Mark completed
          await prisma.contentItem.update({
            where: { tenantId_id: { tenantId, id: itemId } },
            data: {
              indexingStatus: IndexingStatus.completed,
              indexingError: null,
            },
          });

          app.log.info(`[ContentItem Indexing] Successfully completed indexing for '${itemId}': ${chunksCount} chunks created.`);
        } catch (err: any) {
          const errorMsg = err?.message || String(err);
          app.log.error(`[ContentItem Indexing] Extraction failed for '${itemId}': ${errorMsg}`);
          await prisma.contentItem
            .update({
              where: { tenantId_id: { tenantId, id: itemId } },
              data: {
                indexingStatus: IndexingStatus.failed,
                indexingError: errorMsg,
              },
            })
            .catch((dbErr) => {
              app.log.error(`[ContentItem Indexing] Failed to update error status for '${itemId}': ${dbErr}`);
            });
        }
      })();

      // Return immediate response (non-blocking)
      return reply.status(200).send({
        id: contentItem.id,
        type: contentItem.type,
        source_uri: contentItem.sourceUri,
        objective_ids: contentItem.objectiveIds,
        tenant_id: contentItem.tenantId,
        indexing_status: IndexingStatus.pending,
        indexing_error: null,
        chunks_indexed: 0,
      });
    }

    // Case 3: Skipped (e.g. text without content, or scorm awaiting raw_text from connector)
    return reply.status(200).send({
      id: contentItem.id,
      type: contentItem.type,
      source_uri: contentItem.sourceUri,
      objective_ids: contentItem.objectiveIds,
      tenant_id: contentItem.tenantId,
      indexing_status: IndexingStatus.skipped,
      indexing_error: null,
      chunks_indexed: 0,
    });
  });

  // GET /v1/content-items/:id (Polling & Item Details)
  app.get('/v1/content-items/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const item = await prisma.contentItem.findUnique({
      where: {
        tenantId_id: {
          tenantId: req.tenantId,
          id,
        },
      },
      include: {
        _count: {
          select: { chunks: true },
        },
      },
    });

    if (!item) {
      return reply.status(404).send({
        error: {
          code: 'CONTENT_ITEM_NOT_FOUND',
          message: `ContentItem '${id}' not found for this tenant.`,
        },
      });
    }

    return reply.status(200).send({
      id: item.id,
      tenant_id: item.tenantId,
      type: item.type,
      source_uri: item.sourceUri,
      objective_ids: item.objectiveIds,
      indexing_status: item.indexingStatus,
      indexing_error: item.indexingError,
      chunks_indexed: item._count.chunks,
      created_at: item.createdAt.toISOString(),
      updated_at: item.updatedAt.toISOString(),
    });
  });

  // GET /v1/content-items (List all content items for tenant)
  app.get('/v1/content-items', async (req) => {
    const items = await prisma.contentItem.findMany({
      where: { tenantId: req.tenantId },
      include: {
        _count: {
          select: { chunks: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return {
      content_items: items.map((item) => ({
        id: item.id,
        tenant_id: item.tenantId,
        type: item.type,
        source_uri: item.sourceUri,
        objective_ids: item.objectiveIds,
        indexing_status: item.indexingStatus,
        indexing_error: item.indexingError,
        chunks_indexed: item._count.chunks,
        created_at: item.createdAt.toISOString(),
        updated_at: item.updatedAt.toISOString(),
      })),
    };
  });

  // POST /v1/content-items/search (pgvector semantic retrieval)
  app.post('/v1/content-items/search', async (req, reply) => {
    const parseResult = SearchQuerySchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: {
          code: 'INVALID_PAYLOAD',
          message: 'Validation failed',
          details: parseResult.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`),
        },
      });
    }

    const { query, limit } = parseResult.data;

    // Pre-flight check: reject immediately with HTTP 402 if tenant balance is depleted
    if (req.tenant.tokenBalance <= 0) {
      return reply.status(402).send({
        error: {
          code: 'TOKEN_BALANCE_EXHAUSTED',
          message: 'Tenant token balance is exhausted. Please top up credits to search content.',
        },
      });
    }

    try {
      const results = await ragService.searchSimilarChunks(req.tenantId, query, limit);

      return reply.status(200).send({
        query,
        results: results.map((r) => ({
          chunk_id: r.id,
          content_item_id: r.contentItemId,
          chunk_index: r.chunkIndex,
          chunk_text: r.chunkText,
          similarity: r.similarity,
        })),
      });
    } catch (err: any) {
      if (err.code === 'TOKEN_BALANCE_EXHAUSTED' || err.statusCode === 402) {
        return reply.status(402).send({
          error: {
            code: 'TOKEN_BALANCE_EXHAUSTED',
            message: err.message || 'Tenant token balance is exhausted.',
          },
        });
      }
      throw err;
    }
  });
}
