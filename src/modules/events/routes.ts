import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authMiddleware } from '../../middlewares/auth.middleware.js';
import { eventsService } from '../../services/events.service.js';

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

    const result = await eventsService.ingestEvent(req.tenantId, parseResult.data);
    return reply.status(200).send(result);
  });
}
