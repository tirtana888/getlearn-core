import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authMiddleware } from '../../middlewares/auth.middleware.js';
import { ragService } from '../../services/rag.service.js';
import { ContentType } from '@prisma/client';

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
      },
      create: {
        id,
        tenantId: req.tenantId,
        type: type as ContentType,
        sourceUri: source_uri ?? null,
        rawText: raw_text ?? null,
        objectiveIds: objective_ids,
      },
    });

    let chunksCount = 0;
    if (raw_text) {
      chunksCount = await ragService.chunkAndEmbedContentItem(req.tenantId, contentItem.id, raw_text);
    }

    return reply.status(200).send({
      id: contentItem.id,
      type: contentItem.type,
      source_uri: contentItem.sourceUri,
      objective_ids: contentItem.objectiveIds,
      tenant_id: contentItem.tenantId,
      chunks_indexed: chunksCount,
    });
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
  });
}
