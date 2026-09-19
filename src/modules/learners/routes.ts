import { FastifyInstance } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { authMiddleware } from '../../middlewares/auth.middleware.js';
import { masteryService } from '../../services/mastery.service.js';

export async function learnerRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  // Helper to resolve learner by internal id OR externalRef
  async function resolveLearner(tenantId: string, idOrRef: string) {
    return prisma.learner.findFirst({
      where: {
        tenantId,
        OR: [{ id: idOrRef }, { externalRef: idOrRef }],
      },
    });
  }

  // GET /v1/learners - list all learners for current tenant
  app.get('/v1/learners', async (req) => {
    const learners = await prisma.learner.findMany({
      where: { tenantId: req.tenantId },
      include: {
        masteryRecords: {
          include: { objective: true },
        },
        lessonProgress: { select: { status: true } },
        _count: {
          select: { assessmentEvents: true, chatSessions: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return {
      learners: learners.map((l) => {
        const total = l.masteryRecords.length;
        const avgScore =
          total > 0
            ? l.masteryRecords.reduce((acc, r) => acc + r.score, 0) / total
            : null;
        const gapCount = l.masteryRecords.filter((r) => r.score < 0.7).length;

        return {
          id: l.id,
          external_ref: l.externalRef,
          created_at: l.createdAt.toISOString(),
          event_count: l._count.assessmentEvents,
          chat_session_count: l._count.chatSessions,
          mastery_record_count: total,
          avg_mastery_score: avgScore !== null ? Math.round(avgScore * 1000) / 1000 : null,
          gap_count: gapCount,
          lessons_complete: l.lessonProgress.filter((p) => p.status === 'complete').length,
          lessons_partial: l.lessonProgress.filter((p) => p.status === 'partial').length,
        };
      }),
    };
  });

  // GET /v1/learners/:id/mastery
  app.get('/v1/learners/:id/mastery', async (req, reply) => {
    const { id } = req.params as { id: string };
    const learner = await resolveLearner(req.tenantId, id);

    if (!learner) {
      return reply.status(404).send({
        error: {
          code: 'LEARNER_NOT_FOUND',
          message: `Learner with ID '${id}' not found in this tenant.`,
        },
      });
    }

    const records = await prisma.masteryRecord.findMany({
      where: {
        tenantId: req.tenantId,
        learnerId: learner.id,
      },
      include: {
        objective: true,
      },
      orderBy: { score: 'asc' },
    });

    return reply.status(200).send({
      learner_id: learner.externalRef,
      mastery: records.map((r) => ({
        objective_id: r.objectiveId,
        label: r.objective.label,
        score: r.score,
        evidence_count: r.evidenceCount,
        confidence: r.evidenceCount >= 5 ? 'high' : r.evidenceCount >= 2 ? 'medium' : 'low',
        is_gap: r.score < 0.7,
        updated_at: r.updatedAt.toISOString(),
      })),
    });
  });

  // GET /v1/learners/:id/gaps
  app.get('/v1/learners/:id/gaps', async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = req.query as { threshold?: string };
    const threshold = query.threshold ? parseFloat(query.threshold) : 0.7;

    const learner = await resolveLearner(req.tenantId, id);
    if (!learner) {
      return reply.status(404).send({
        error: {
          code: 'LEARNER_NOT_FOUND',
          message: `Learner with ID '${id}' not found in this tenant.`,
        },
      });
    }

    const records = await prisma.masteryRecord.findMany({
      where: {
        tenantId: req.tenantId,
        learnerId: learner.id,
        score: { lt: threshold },
      },
      include: { objective: true },
      orderBy: { score: 'asc' },
    });

    return reply.status(200).send({
      learner_id: learner.externalRef,
      threshold,
      gaps: records.map((r) => ({
        objective_id: r.objectiveId,
        label: r.objective.label,
        score: r.score,
        evidence_count: r.evidenceCount,
        confidence: r.evidenceCount >= 5 ? 'high' : r.evidenceCount >= 2 ? 'medium' : 'low',
        is_gap: true,
        updated_at: r.updatedAt.toISOString(),
      })),
    });
  });


  // GET /v1/learners/:id/progress - lesson-level progress, separate from quiz mastery
  app.get('/v1/learners/:id/progress', async (req, reply) => {
    const { id } = req.params as { id: string };
    const learner = await resolveLearner(req.tenantId, id);

    if (!learner) {
      return reply.status(404).send({
        error: {
          code: 'LEARNER_NOT_FOUND',
          message: `Learner with ID '${id}' not found in this tenant.`,
        },
      });
    }

    const rows = await prisma.lessonProgress.findMany({
      where: { tenantId: req.tenantId, learnerId: learner.id },
      include: { objective: true },
      orderBy: { sourceModified: 'desc' },
    });

    return reply.status(200).send({
      learner_id: learner.externalRef,
      lessons_complete: rows.filter((r) => r.status === 'complete').length,
      lessons_partial: rows.filter((r) => r.status === 'partial').length,
      lessons: rows.map((r) => ({
        lesson_id: r.lessonId,
        label: r.objective.label,
        course_id: r.courseId,
        status: r.status,
        updated_at: r.sourceModified.toISOString(),
      })),
    });
  });

  // GET /v1/learners/:id/next-action
  app.get('/v1/learners/:id/next-action', async (req, reply) => {
    const { id } = req.params as { id: string };
    const learner = await resolveLearner(req.tenantId, id);

    if (!learner) {
      return reply.status(404).send({
        error: {
          code: 'LEARNER_NOT_FOUND',
          message: `Learner with ID '${id}' not found in this tenant.`,
        },
      });
    }

    const nextAction = await masteryService.getNextAction(req.tenantId, learner.id);
    return reply.status(200).send({
      ...nextAction,
      learner_id: learner.externalRef,
    });
  });
}
