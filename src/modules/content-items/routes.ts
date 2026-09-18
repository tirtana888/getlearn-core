import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authMiddleware } from '../../middlewares/auth.middleware.js';
import { ContentType } from '@prisma/client';

const ContentItemInputSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['text', 'video', 'pdf', 'scorm']),
  source_uri: z.string().optional().nullable(),
  objective_ids: z.array(z.string()).default([]),
});

export async function contentItemRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

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

    const { id, type, source_uri, objective_ids } = parseResult.data;

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
        objectiveIds: objective_ids,
      },
      create: {
        id,
        tenantId: req.tenantId,
        type: type as ContentType,
        sourceUri: source_uri ?? null,
        objectiveIds: objective_ids,
      },
    });

    return reply.status(200).send({
      id: contentItem.id,
      type: contentItem.type,
      source_uri: contentItem.sourceUri,
      objective_ids: contentItem.objectiveIds,
      tenant_id: contentItem.tenantId,
    });
  });
}
