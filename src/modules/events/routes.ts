import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authMiddleware } from '../../middlewares/auth.middleware.js';
import { masteryService } from '../../services/mastery.service.js';

const EventInputSchema = z.object({
  event_id: z.string().min(1),
  event_type: z.enum([
    'assessment.answered',
    'content.viewed',
    'content.completed',
    'enrollment.created',
  ]),
  external_learner_id: z.string().min(1),
  occurred_at: z.string().datetime().or(z.string()),
  payload: z.object({
    item_id: z.string().min(1),
    is_correct: z.boolean(),
    raw_response: z.string().optional(),
  }),
});

export async function eventRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  app.post('/v1/events', async (req, reply) => {
    const parseResult = EventInputSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: {
          code: 'INVALID_PAYLOAD',
          message: 'Validation failed',
          details: parseResult.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`),
        },
      });
    }

    const { event_id, event_type, external_learner_id, occurred_at, payload } = parseResult.data;

    // 1. Idempotency check: Return duplicate_ignored if event_id already ingested for tenant
    const existingEvent = await prisma.assessmentEvent.findUnique({
      where: {
        tenantId_id: {
          tenantId: req.tenantId,
          id: event_id,
        },
      },
    });

    if (existingEvent) {
      return reply.status(200).send({
        status: 'duplicate_ignored',
        event_id,
        mastery_updated: false,
      });
    }

    // 2. Resolve or create Learner record (opaque external_ref, no PII)
    const learner = await prisma.learner.upsert({
      where: {
        tenantId_externalRef: {
          tenantId: req.tenantId,
          externalRef: external_learner_id,
        },
      },
      update: {},
      create: {
        tenantId: req.tenantId,
        externalRef: external_learner_id,
      },
    });

    // 3. Ensure assessment item exists or create stub if not pre-registered
    await prisma.assessmentItem.upsert({
      where: {
        tenantId_id: {
          tenantId: req.tenantId,
          id: payload.item_id,
        },
      },
      update: {},
      create: {
        id: payload.item_id,
        tenantId: req.tenantId,
        itemType: 'mcq',
        promptText: `Assessment Item ${payload.item_id}`,
        objectiveIds: [],
      },
    });

    // 4. Save AssessmentEvent
    await prisma.assessmentEvent.create({
      data: {
        id: event_id,
        tenantId: req.tenantId,
        learnerId: learner.id,
        itemId: payload.item_id,
        isCorrect: payload.is_correct,
        rawResponse: payload.raw_response ?? null,
        occurredAt: new Date(occurred_at),
      },
    });

    // 5. Trigger Phase 1 naive mastery recalculation
    if (event_type === 'assessment.answered') {
      await masteryService.updateMasteryForItem(req.tenantId, learner.id, payload.item_id);
    }

    return reply.status(200).send({
      status: 'processed',
      event_id,
      mastery_updated: true,
    });
  });
}
