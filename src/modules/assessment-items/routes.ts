import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authMiddleware } from '../../middlewares/auth.middleware.js';
import { AssessmentType } from '@prisma/client';

const AssessmentItemInputSchema = z.object({
  id: z.string().min(1),
  item_type: z.enum(['mcq', 'short', 'essay']),
  prompt_text: z.string().min(1),
  objective_ids: z.array(z.string()).default([]),
});

export async function assessmentItemRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  app.post('/v1/assessment-items', async (req, reply) => {
    const parseResult = AssessmentItemInputSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: {
          code: 'INVALID_PAYLOAD',
          message: 'Validation failed',
          details: parseResult.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`),
        },
      });
    }

    const { id, item_type, prompt_text, objective_ids } = parseResult.data;

    const assessmentItem = await prisma.assessmentItem.upsert({
      where: {
        tenantId_id: {
          tenantId: req.tenantId,
          id,
        },
      },
      update: {
        itemType: item_type as AssessmentType,
        promptText: prompt_text,
        objectiveIds: objective_ids,
      },
      create: {
        id,
        tenantId: req.tenantId,
        itemType: item_type as AssessmentType,
        promptText: prompt_text,
        objectiveIds: objective_ids,
      },
    });

    return reply.status(200).send({
      id: assessmentItem.id,
      item_type: assessmentItem.itemType,
      prompt_text: assessmentItem.promptText,
      objective_ids: assessmentItem.objectiveIds,
      tenant_id: assessmentItem.tenantId,
    });
  });
}
