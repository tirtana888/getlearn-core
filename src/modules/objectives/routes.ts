import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authMiddleware } from '../../middlewares/auth.middleware.js';

const ObjectiveInputSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  parent_id: z.string().optional().nullable(),
});

export async function objectiveRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  app.post('/v1/objectives', async (req, reply) => {
    const parseResult = ObjectiveInputSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: {
          code: 'INVALID_PAYLOAD',
          message: 'Validation failed',
          details: parseResult.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`),
        },
      });
    }

    const { id, label, parent_id } = parseResult.data;

    const objective = await prisma.learningObjective.upsert({
      where: {
        tenantId_id: {
          tenantId: req.tenantId,
          id,
        },
      },
      update: {
        label,
        parentId: parent_id ?? null,
      },
      create: {
        id,
        tenantId: req.tenantId,
        label,
        parentId: parent_id ?? null,
      },
    });

    return reply.status(200).send({
      id: objective.id,
      label: objective.label,
      parent_id: objective.parentId,
      tenant_id: objective.tenantId,
    });
  });
}
