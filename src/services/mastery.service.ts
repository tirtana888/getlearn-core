import { prisma } from '../lib/prisma.js';
import { ragService } from './rag.service.js';

export class MasteryService {
  /**
   * Recalculate naive mastery scores for all objectives touched by an assessment item
   */
  async updateMasteryForItem(tenantId: string, learnerId: string, itemId: string) {
    const item = await prisma.assessmentItem.findUnique({
      where: {
        tenantId_id: {
          tenantId,
          id: itemId,
        },
      },
    });

    if (!item || !item.objectiveIds.length) {
      return;
    }

    for (const objectiveId of item.objectiveIds) {
      // Find all assessment items that evaluate this objective
      const itemsForObjective = await prisma.assessmentItem.findMany({
        where: {
          tenantId,
          objectiveIds: {
            has: objectiveId,
          },
        },
        select: { id: true },
      });

      const itemIds = itemsForObjective.map((i) => i.id);

      // Fetch all events by this learner on these items
      const events = await prisma.assessmentEvent.findMany({
        where: {
          tenantId,
          learnerId,
          itemId: { in: itemIds },
        },
      });

      const evidenceCount = events.length;
      if (evidenceCount === 0) continue;

      const correctCount = events.filter((e) => e.isCorrect).length;
      const score = parseFloat((correctCount / evidenceCount).toFixed(2));

      // Ensure objective exists in DB so foreign key constraint passes
      await prisma.learningObjective.upsert({
        where: {
          tenantId_id: {
            tenantId,
            id: objectiveId,
          },
        },
        update: {},
        create: {
          id: objectiveId,
          tenantId,
          label: `Objective ${objectiveId}`,
        },
      });

      // Upsert MasteryRecord
      await prisma.masteryRecord.upsert({
        where: {
          tenantId_learnerId_objectiveId: {
            tenantId,
            learnerId,
            objectiveId,
          },
        },
        update: {
          score,
          evidenceCount,
        },
        create: {
          tenantId,
          learnerId,
          objectiveId,
          score,
          evidenceCount,
        },
      });
    }
  }

  /**
   * Determine the next best learning action for one learner, from everything we know:
   *   1. a quiz gap (score < 70%)            -> review that lesson's material
   *   2. a lesson started but not finished   -> continue it
   *   3. a finished lesson whose quiz they
   *      haven't taken                        -> take the quiz
   *   4. the next lesson in a course they're
   *      enrolled in and haven't started      -> start it
   *   5. everything else is on track          -> keep practising
   * Each step only fires when there is real evidence for it, so a learner with no quiz
   * history but active lesson progress still gets a personal recommendation.
   */
  async getNextAction(tenantId: string, learnerId: string) {
    const masteryRecords = await prisma.masteryRecord.findMany({
      where: { tenantId, learnerId },
      include: { objective: true },
      orderBy: { score: 'asc' },
    });

    // 1. Quiz gap first - remediation beats moving on.
    const gap = masteryRecords.find((r) => r.score < 0.7);
    if (gap) {
      let targetId = gap.objectiveId;
      let excerpt = '';

      const directlyMapped = await prisma.contentItem.findFirst({
        where: { tenantId, objectiveIds: { has: gap.objectiveId } },
      });

      if (directlyMapped) {
        targetId = directlyMapped.id;
        const chunk = await prisma.contentChunk.findFirst({
          where: { tenantId, contentItemId: directlyMapped.id },
        });
        if (chunk) excerpt = chunk.chunkText;
      } else {
        const similarChunks = await ragService.searchSimilarChunks(tenantId, gap.objective.label, 1);
        if (similarChunks.length > 0) {
          targetId = similarChunks[0].contentItemId;
          excerpt = similarChunks[0].chunkText;
        }
      }

      return {
        learner_id: learnerId,
        action: 'review',
        target_id: targetId,
        reason_objective_id: gap.objectiveId,
        explanation: `Skor penguasaan pada "${gap.objective.label}" adalah ${(gap.score * 100).toFixed(0)}% (di bawah batas 70%). Dianjurkan mengulang materi review.${excerpt ? ` Rekomendasi bagian materi: "${excerpt.slice(0, 120)}..."` : ''}`,
      };
    }

    const progress = await prisma.lessonProgress.findMany({
      where: { tenantId, learnerId },
      include: { objective: true },
      orderBy: { sourceModified: 'desc' },
    });

    // 2. Started but unfinished - the most recently touched one.
    const inProgress = progress.find((p) => p.status === 'partial');
    if (inProgress) {
      return {
        learner_id: learnerId,
        action: 'continue',
        target_id: inProgress.lessonId,
        reason_objective_id: inProgress.lessonId,
        explanation: `Lesson "${inProgress.objective.label}" sudah dimulai tapi belum selesai. Lanjutkan sampai tuntas.`,
      };
    }

    // 3. Finished a lesson that has a quiz, but never took it.
    const quizzed = new Set(masteryRecords.map((r) => r.objectiveId));
    const untestedLesson = progress.find(
      (p) => p.status === 'complete' && p.objective.assessmentRef && !quizzed.has(p.lessonId)
    );
    if (untestedLesson) {
      return {
        learner_id: learnerId,
        action: 'practice',
        target_id: untestedLesson.objective.assessmentRef as string,
        reason_objective_id: untestedLesson.lessonId,
        explanation: `Lesson "${untestedLesson.objective.label}" sudah selesai, tapi quiz-nya belum dikerjakan. Kerjakan quiz untuk mengukur pemahaman.`,
      };
    }

    // 4. Next unstarted lesson in a course they're enrolled in.
    const enrollments = await prisma.enrollment.findMany({
      where: { tenantId, learnerId },
      orderBy: { progressPct: 'desc' },
    });
    const touched = new Set([...progress.map((p) => p.lessonId), ...quizzed]);
    for (const enrollment of enrollments) {
      if (enrollment.progressPct >= 100) continue;
      const candidates = await prisma.learningObjective.findMany({
        where: {
          tenantId,
          courseId: enrollment.courseId,
          sequence: { not: null },
          id: { notIn: [...touched] },
        },
        orderBy: { sequence: 'asc' },
      });
      // Skip empty shells: a lesson with neither indexed material nor a quiz gives the
      // learner nothing to actually start.
      const withMaterial = new Set(
        (
          await prisma.contentItem.findMany({
            where: { tenantId, id: { in: candidates.map((c) => c.id) } },
            select: { id: true },
          })
        ).map((c) => c.id)
      );
      const next = candidates.find((c) => withMaterial.has(c.id) || c.assessmentRef);
      if (next) {
        return {
          learner_id: learnerId,
          action: 'start',
          target_id: next.id,
          reason_objective_id: next.id,
          explanation: `Lesson berikutnya di "${enrollment.courseLabel ?? enrollment.courseId}" (${Math.round(enrollment.progressPct)}% selesai): "${next.label}". Mulai dari sini.`,
        };
      }
    }

    // 5. Nothing to fix and nothing left to start - reinforce what they know best.
    if (masteryRecords.length) {
      const strongest = masteryRecords[masteryRecords.length - 1];
      const pct = Math.round(strongest.score * 100);
      const tier =
        pct === 100
          ? 'Penguasaan sempurna'
          : pct >= 90
            ? 'Penguasaan sangat baik'
            : 'Penguasaan baik, sudah lolos ambang batas';
      const assessment = await prisma.assessmentItem.findFirst({
        where: { tenantId, objectiveIds: { has: strongest.objectiveId } },
      });
      return {
        learner_id: learnerId,
        action: 'practice',
        target_id: assessment?.id || strongest.objectiveId,
        reason_objective_id: strongest.objectiveId,
        explanation: `${tier} (${pct}%) pada "${strongest.objective.label}". Pertahankan dengan latihan pendalaman.`,
      };
    }

    const firstContent = await prisma.contentItem.findFirst({ where: { tenantId } });
    return {
      learner_id: learnerId,
      action: 'start',
      target_id: firstContent?.id || 'onboarding',
      reason_objective_id: 'initial',
      explanation: 'Belum ada aktivitas belajar. Mulailah dengan materi awal.',
    };
  }
}

export const masteryService = new MasteryService();
