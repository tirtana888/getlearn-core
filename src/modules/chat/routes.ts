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

const ResumeSessionSchema = z.object({
  learner_id: z.string().min(1),
  fresh: z.boolean().default(false),
  max_age_days: z.number().int().min(1).max(365).default(30),
});

const SendMessageSchema = z.object({
  message: z.string().min(1),
  is_assessment_active: z.boolean().default(false),
  // Facts the LMS connector knows about this learner right now that getlearn does not store
  // (drip schedule, deadlines, assignments...). Plain text, capped; used as background data only.
  client_context: z.string().max(4000).optional(),
  // The lesson the learner has open right now; retrieval and scores follow it.
  lesson_id: z.string().min(1).max(300).optional(),
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

  // POST /v1/chat/sessions/resume - the learner's continuous conversation (or a fresh one).
  // Returns the session and its recent messages, oldest first.
  app.post('/v1/chat/sessions/resume', async (req, reply) => {
    const parseResult = ResumeSessionSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: {
          code: 'INVALID_PAYLOAD',
          message: 'Validation failed',
          details: parseResult.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`),
        },
      });
    }
    const { learner_id, fresh, max_age_days } = parseResult.data;
    try {
      const result = await chatService.resumeOrCreateSession(req.tenantId, learner_id, {
        fresh,
        maxAgeDays: max_age_days,
      });
      return reply.status(200).send(result);
    } catch (err: any) {
      return reply.status(404).send({ error: { code: 'RESOURCE_NOT_FOUND', message: err.message } });
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

    const { message, is_assessment_active, client_context, lesson_id } = parseResult.data;

    // Pre-flight check: reject immediately with HTTP 402 if tenant balance is depleted
    if (req.tenant.tokenBalance <= 0) {
      return reply.status(402).send({
        error: {
          code: 'TOKEN_BALANCE_EXHAUSTED',
          message: 'Tenant token balance is exhausted. Please top up credits to use AI coach.',
        },
      });
    }

    const protocol = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'http';
    const host = (req.headers['x-forwarded-host'] as string) || req.headers.host || 'localhost:3000';
    const baseUrl = `${protocol}://${host}`;

    try {
      const response = await chatService.sendMessage(
        req.tenantId,
        id,
        message,
        is_assessment_active,
        voiceRequested,
        baseUrl,
        client_context,
        lesson_id
      );
      return reply.status(200).send(response);
    } catch (err: any) {
      if (err.code === 'TOKEN_BALANCE_EXHAUSTED' || err.statusCode === 402) {
        return reply.status(402).send({
          error: {
            code: 'TOKEN_BALANCE_EXHAUSTED',
            message: err.message || 'Tenant token balance is exhausted.',
          },
        });
      }
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
    const limit = Number((req.query as { limit?: string }).limit) || undefined;
    const session = await chatService.getSession(req.tenantId, id, limit && limit > 0 ? Math.min(limit, 200) : undefined);

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
