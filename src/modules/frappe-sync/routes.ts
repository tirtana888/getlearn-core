import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authMiddleware } from '../../middlewares/auth.middleware.js';
import { frappeSyncService } from '../../services/frappeSync.service.js';

const ConnectionInputSchema = z.object({
  base_url: z.string().url(),
  api_key: z.string().min(1),
  api_secret: z.string().min(1),
  enabled: z.boolean().default(true),
  // Forces the next sync to re-walk full history instead of only what's new
  // since the last watermark - e.g. after a mapping/objective fix that needs
  // to reach submissions already ingested under the old behavior.
  reset_watermark: z.boolean().default(false),
});

export async function frappeSyncRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  // PUT /v1/frappe-sync/connection - configure (or update) this tenant's own Frappe source.
  // Scoped to the calling tenant's own API key - a tenant can only ever set up sync for itself.
  app.put('/v1/frappe-sync/connection', async (req, reply) => {
    const parseResult = ConnectionInputSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: {
          code: 'INVALID_PAYLOAD',
          message: 'Validation failed',
          details: parseResult.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`),
        },
      });
    }

    const { base_url, api_key, api_secret, enabled, reset_watermark } = parseResult.data;

    const connection = await prisma.frappeConnection.upsert({
      where: { tenantId: req.tenantId },
      update: {
        baseUrl: base_url,
        apiKey: api_key,
        apiSecret: api_secret,
        enabled,
        lastSyncError: null,
        ...(reset_watermark ? { lastSyncedAt: null } : {}),
      },
      create: {
        tenantId: req.tenantId,
        baseUrl: base_url,
        apiKey: api_key,
        apiSecret: api_secret,
        enabled,
      },
    });

    return reply.status(200).send({
      base_url: connection.baseUrl,
      enabled: connection.enabled,
      last_synced_at: connection.lastSyncedAt?.toISOString() ?? null,
      last_sync_error: connection.lastSyncError,
    });
  });

  // GET /v1/frappe-sync/connection - status only. api_key/api_secret are write-only,
  // never echoed back once set.
  app.get('/v1/frappe-sync/connection', async (req, reply) => {
    const connection = await prisma.frappeConnection.findUnique({ where: { tenantId: req.tenantId } });
    if (!connection) {
      return reply.status(404).send({
        error: { code: 'NOT_CONFIGURED', message: 'No Frappe connection configured for this tenant.' },
      });
    }
    return reply.status(200).send({
      base_url: connection.baseUrl,
      enabled: connection.enabled,
      last_synced_at: connection.lastSyncedAt?.toISOString() ?? null,
      last_sync_error: connection.lastSyncError,
    });
  });

  // POST /v1/frappe-sync/trigger - run a sync cycle for this tenant right now,
  // instead of waiting for the periodic background job. Useful for testing.
  app.post('/v1/frappe-sync/trigger', async (req, reply) => {
    const result = await frappeSyncService.syncTenant(req.tenantId);
    return reply.status(200).send({
      learners_registered: result.learnersRegistered,
      submissions_seen: result.submissionsSeen,
      events_ingested: result.eventsIngested,
      errors: result.errors,
    });
  });
}
