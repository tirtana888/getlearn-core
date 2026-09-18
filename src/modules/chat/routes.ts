import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authMiddleware } from '../../middlewares/auth.middleware.js';
import { chatService } from '../../services/chat.service.js';
import { ChatScope } from '@prisma/client';

const CreateSessionSchema = z.object({
  learner_id: z.string().min(1),
  scope: z.enum(['objective', 'learner']).default('objective'),
  objective_ids: z.array(z.string()).default([]),
});

const SendMessageSchema = z.object({
  message: z.string().min(1),
  is_assessment_active: z.boolean().default(false),
});

export async function chatRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  // POST /v1/chat/sessions
  app.post('/v1/chat/sessions', async (req, reply) => {
    const parseResult = CreateSessionSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: {
          code: 'INVALID_PAYLOAD',
          message: 'Validation failed',
          details: parseResult.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`),
        },
      });
    }

    const { learner_id, scope, objective_ids } = parseResult.data;
    try {
      const session = await chatService.createSession(
        req.tenantId,
        learner_id,
        scope as ChatScope,
        objective_ids
      );
      return reply.status(201).send(session);
    } catch (err: any) {
      return reply.status(404).send({
        error: {
          code: 'RESOURCE_NOT_FOUND',
          message: err.message,
        },
      });
    }
  });

  // POST /v1/chat/sessions/:id/messages
  app.post('/v1/chat/sessions/:id/messages', async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = req.query as { voice?: string };
    const voiceRequested = query.voice === 'true' || query.voice === '1';

    const parseResult = SendMessageSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: {
          code: 'INVALID_PAYLOAD',
          message: 'Validation failed',
          details: parseResult.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`),
        },
      });
    }

    const { message, is_assessment_active } = parseResult.data;

    try {
      const response = await chatService.sendMessage(
        req.tenantId,
        id,
        message,
        is_assessment_active,
        voiceRequested
      );
      return reply.status(200).send(response);
    } catch (err: any) {
      return reply.status(404).send({
        error: {
          code: 'SESSION_NOT_FOUND',
          message: err.message,
        },
      });
    }
  });

  // GET /v1/chat/sessions/:id
  app.get('/v1/chat/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = await chatService.getSession(req.tenantId, id);

    if (!session) {
      return reply.status(404).send({
        error: {
          code: 'SESSION_NOT_FOUND',
          message: `Chat session '${id}' not found in this tenant.`,
        },
      });
    }

    return reply.status(200).send(session);
  });
}
