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
   * Determine next best learning action for a learner
   */
  async getNextAction(tenantId: string, learnerId: string) {
    // 1. Get all mastery records
    const masteryRecords = await prisma.masteryRecord.findMany({
      where: { tenantId, learnerId },
      include: { objective: true },
      orderBy: { score: 'asc' },
    });

    // Lesson the learner started but hasn't finished - the most recently touched one.
    const inProgress = await prisma.lessonProgress.findFirst({
      where: { tenantId, learnerId, status: 'partial' },
      include: { objective: true },
      orderBy: { sourceModified: 'desc' },
    });
    const continueAction = inProgress
      ? {
          learner_id: learnerId,
          action: 'continue',
          target_id: inProgress.lessonId,
          reason_objective_id: inProgress.lessonId,
          explanation: `Lesson "${inProgress.objective.label}" sudah dimulai tapi belum selesai. Lanjutkan sampai tuntas.`,
        }
      : null;

    // If no quiz evidence yet, lesson progress is the only personal signal there is.
    if (!masteryRecords.length && continueAction) {
      return continueAction;
    }

    // If no records, recommend generic start
    if (!masteryRecords.length) {
      const firstContent = await prisma.contentItem.findFirst({
        where: { tenantId },
      });
      return {
        learner_id: learnerId,
        action: 'practice',
        target_id: firstContent?.id || 'onboarding',
        reason_objective_id: 'initial',
        explanation: 'Belum ada bukti asesmen. Mulailah mempelajari materi awal.',
      };
    }

    // 2. Check for learning gaps (score < 0.70)
    const gap = masteryRecords.find((r) => r.score < 0.7);

    if (gap) {
      // Find content item or semantically matching chunk covering this gap
      let targetId = gap.objectiveId;
      let excerpt = '';

      // 1. Check directly mapped content item first
      const directlyMapped = await prisma.contentItem.findFirst({
        where: {
          tenantId,
          objectiveIds: { has: gap.objectiveId },
        },
      });

      if (directlyMapped) {
        targetId = directlyMapped.id;
        const chunk = await prisma.contentChunk.findFirst({
          where: { tenantId, contentItemId: directlyMapped.id },
        });
        if (chunk) excerpt = chunk.chunkText;
      } else {
        // 2. Fallback to vector search across all chunks
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

    // No quiz gap to fix first, so unfinished lesson work comes before more practice.
    if (continueAction) {
      return continueAction;
    }

    // 3. All current objectives mastered >= 70%: recommend practice on next assessment
    const highestConfidence = masteryRecords[0];
    const assessment = await prisma.assessmentItem.findFirst({
      where: {
        tenantId,
        objectiveIds: { has: highestConfidence.objectiveId },
      },
    });

    const pct = Math.round(highestConfidence.score * 100);
    const tier =
      pct === 100
        ? 'Penguasaan sempurna'
        : pct >= 90
          ? 'Penguasaan sangat baik'
          : 'Penguasaan baik, sudah lolos ambang batas';

    return {
      learner_id: learnerId,
      action: 'practice',
      target_id: assessment?.id || highestConfidence.objectiveId,
      reason_objective_id: highestConfidence.objectiveId,
      explanation: `${tier} (${pct}%) pada "${highestConfidence.objective.label}". Pertahankan dengan latihan pendalaman.`,
    };
  }
}

export const masteryService = new MasteryService();
