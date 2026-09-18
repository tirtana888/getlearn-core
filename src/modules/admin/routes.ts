import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { unkeyService } from '../../services/unkey.service.js';

const CreateTenantSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  token_balance: z.number().int().positive().optional(),
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

    const { id, name, token_balance } = parseResult.data;

    const tenant = await prisma.tenant.create({
      data: {
        id: id ?? undefined,
        name,
        tokenBalance: token_balance ?? 100000,
      },
    });

    const apiKey = await unkeyService.issueKey(tenant.id, tenant.name);

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
}
