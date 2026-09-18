import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { unkeyService } from '../../services/unkey.service.js';

const CreateTenantSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  token_balance: z.number().int().positive().optional(),
  rate_limit: z.number().int().positive().optional(),
});

export async function adminRoutes(app: FastifyInstance) {
  app.post('/v1/admin/tenants', async (req, reply) => {
    const parseResult = CreateTenantSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: {
          code: 'INVALID_PAYLOAD',
          message: 'Validation failed',
          details: parseResult.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`),
        },
      });
    }

    const { id, name, token_balance, rate_limit } = parseResult.data;

    const tenant = await prisma.tenant.create({
      data: {
        id: id ?? undefined,
        name,
        tokenBalance: token_balance ?? 100000,
      },
    });

    const apiKey = await unkeyService.issueKey(
      tenant.id,
      tenant.name,
      rate_limit ? { ratelimit: { limit: rate_limit } } : undefined
    );

    return reply.status(201).send({
      tenant: {
        id: tenant.id,
        name: tenant.name,
        token_balance: tenant.tokenBalance,
        created_at: tenant.createdAt.toISOString(),
      },
      apiKey,
    });
  });

  // GET /v1/admin/tenants - list all tenants with observability metrics
  app.get('/v1/admin/tenants', async () => {
    const tenants = await prisma.tenant.findMany({
      include: {
        _count: {
          select: {
            learners: true,
            objectives: true,
            assessmentEvents: true,
            contentItems: true,
            masteryRecords: true,
            chatSessions: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return {
      tenants: tenants.map((t) => ({
        id: t.id,
        name: t.name,
        token_balance: t.tokenBalance,
        created_at: t.createdAt.toISOString(),
        stats: {
          learners: t._count.learners,
          objectives: t._count.objectives,
          events: t._count.assessmentEvents,
          content_items: t._count.contentItems,
          mastery_records: t._count.masteryRecords,
          chat_sessions: t._count.chatSessions,
        },
      })),
    };
  });

  // POST /v1/admin/tenants/:id/credits - manual top-up
  app.post('/v1/admin/tenants/:id/credits', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { amount: number };

    if (!body || typeof body.amount !== 'number' || body.amount <= 0) {
      return reply.status(400).send({
        error: {
          code: 'INVALID_AMOUNT',
          message: 'Top-up amount must be a positive integer.',
        },
      });
    }

    const tenant = await prisma.tenant.update({
      where: { id },
      data: {
        tokenBalance: { increment: body.amount },
      },
    });

    return {
      id: tenant.id,
      name: tenant.name,
      token_balance: tenant.tokenBalance,
      credited_amount: body.amount,
      updated_at: tenant.updatedAt.toISOString(),
    };
  });
}
