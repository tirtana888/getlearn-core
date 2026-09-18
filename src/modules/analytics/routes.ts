import { FastifyInstance } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { authMiddleware } from '../../middlewares/auth.middleware.js';

export async function analyticsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  app.get('/v1/analytics/overview', async (req, reply) => {
    const tenantId = req.tenantId;

    const [tenant, learnerCount, objectiveCount, eventCount, masteryRecords] = await Promise.all([
      prisma.tenant.findUnique({ where: { id: tenantId } }),
      prisma.learner.count({ where: { tenantId } }),
      prisma.learningObjective.count({ where: { tenantId } }),
      prisma.assessmentEvent.count({ where: { tenantId } }),
      prisma.masteryRecord.findMany({
        where: { tenantId },
        include: { objective: true },
      }),
    ]);

    const totalRecords = masteryRecords.length;
    const avgScore = totalRecords > 0
      ? masteryRecords.reduce((acc, r) => acc + r.score, 0) / totalRecords
      : 0;

    const gaps = masteryRecords.filter((r) => r.score < 0.7);

    // Group by objective
    const objMap = new Map<string, { label: string; scores: number[]; gaps: number }>();
    for (const r of masteryRecords) {
      const entry = objMap.get(r.objectiveId) || { label: r.objective.label, scores: [], gaps: 0 };
      entry.scores.push(r.score);
      if (r.score < 0.7) entry.gaps++;
      objMap.set(r.objectiveId, entry);
    }

    const objectiveDistribution = Array.from(objMap.entries()).map(([objId, data]) => ({
      objective_id: objId,
      label: data.label,
      avg_score: data.scores.length > 0 ? data.scores.reduce((a, b) => a + b, 0) / data.scores.length : 0,
      learner_count: data.scores.length,
      gap_count: data.gaps,
      gap_rate: data.scores.length > 0 ? data.gaps / data.scores.length : 0,
    }));

    return {
      tenant: {
        id: tenant?.id,
        name: tenant?.name,
        token_balance: tenant?.tokenBalance ?? 0,
      },
      summary: {
        total_learners: learnerCount,
        total_objectives: objectiveCount,
        total_events: eventCount,
        total_mastery_records: totalRecords,
        average_mastery_score: Math.round(avgScore * 1000) / 1000,
        active_gap_count: gaps.length,
        gap_percentage: totalRecords > 0 ? Math.round((gaps.length / totalRecords) * 100) : 0,
      },
      objective_distribution: objectiveDistribution,
    };
  });
}
