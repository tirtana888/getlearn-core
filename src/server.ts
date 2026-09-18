import { buildApp } from './app.js';
import { config } from './config/env.js';
import { prisma } from './lib/prisma.js';
import { frappeSyncService } from './services/frappeSync.service.js';

const FRAPPE_SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

async function runFrappeSyncCycle() {
  const connections = await prisma.frappeConnection.findMany({
    where: { enabled: true },
    select: { tenantId: true },
  });

  for (const { tenantId } of connections) {
    try {
      const result = await frappeSyncService.syncTenant(tenantId);
      if (result.eventsIngested > 0 || result.errors > 0) {
        console.log(
          `[frappe-sync] tenant=${tenantId} submissions=${result.submissionsSeen} ` +
            `events=${result.eventsIngested} errors=${result.errors}`
        );
      }
    } catch (err) {
      console.error(`[frappe-sync] tenant=${tenantId} cycle failed:`, err);
    }
  }
}

async function start() {
  try {
    const app = await buildApp();
    await app.listen({ port: config.port, host: '0.0.0.0' });
    console.log(`🚀 getlearn.ai Core Server running on http://localhost:${config.port}`);
    console.log(`📚 Swagger documentation available at http://localhost:${config.port}/docs`);

    // Periodic pull sync for any tenant with a configured Frappe source (see
    // frappeSync.service.ts) - getlearn adapts to Frappe's own REST API,
    // nothing is pushed from the Frappe side for event ingestion.
    setInterval(() => {
      runFrappeSyncCycle().catch((err) => console.error('[frappe-sync] cycle error:', err));
    }, FRAPPE_SYNC_INTERVAL_MS);
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
