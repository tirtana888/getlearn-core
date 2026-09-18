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

      const similarChunks = await ragService.searchSimilarChunks(tenantId, gap.objective.label, 1);
      if (similarChunks.length > 0) {
        targetId = similarChunks[0].contentItemId;
        excerpt = similarChunks[0].chunkText;
      } else {
        const content = await prisma.contentItem.findFirst({
          where: {
            tenantId,
            objectiveIds: { has: gap.objectiveId },
          },
        });
        if (content) targetId = content.id;
      }

      return {
        learner_id: learnerId,
        action: 'review',
        target_id: targetId,
        reason_objective_id: gap.objectiveId,
        explanation: `Skor penguasaan pada "${gap.objective.label}" adalah ${(gap.score * 100).toFixed(0)}% (di bawah batas 70%). Dianjurkan mengulang materi review.${excerpt ? ` Rekomendasi bagian materi: "${excerpt.slice(0, 120)}..."` : ''}`,
      };
    }

    // 3. All current objectives mastered >= 70%: recommend practice on next assessment
    const highestConfidence = masteryRecords[0];
    const assessment = await prisma.assessmentItem.findFirst({
      where: {
        tenantId,
        objectiveIds: { has: highestConfidence.objectiveId },
      },
    });

    return {
      learner_id: learnerId,
      action: 'practice',
      target_id: assessment?.id || highestConfidence.objectiveId,
      reason_objective_id: highestConfidence.objectiveId,
      explanation: `Penguasaan materi baik! Pertahankan dengan latihan pendalaman pada "${highestConfidence.objective.label}".`,
    };
  }
}

export const masteryService = new MasteryService();
