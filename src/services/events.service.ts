import { prisma } from '../lib/prisma.js';
import { masteryService } from './mastery.service.js';

export interface EventInput {
  event_id: string;
  event_type: 'assessment.answered' | 'content.viewed' | 'content.completed' | 'enrollment.created';
  external_learner_id: string;
  occurred_at: string;
  payload: {
    item_id: string;
    is_correct: boolean;
    raw_response?: string;
  };
}

export interface EventIngestResult {
  status: 'processed' | 'duplicate_ignored';
  event_id: string;
  mastery_updated: boolean;
}

export class EventsService {
  /**
   * Shared ingestion path for both POST /v1/events (pushed by a connector) and
   * FrappeSyncService (pulled from a Frappe site's own REST API) - same
   * idempotency, upsert, and mastery-recalculation behavior either way.
   */
  async ingestEvent(tenantId: string, input: EventInput): Promise<EventIngestResult> {
    const { event_id, event_type, external_learner_id, occurred_at, payload } = input;

    // 1. Idempotency check: Return duplicate_ignored if event_id already ingested for tenant
    const existingEvent = await prisma.assessmentEvent.findUnique({
      where: {
        tenantId_id: {
          tenantId,
          id: event_id,
        },
      },
    });

    if (existingEvent) {
      return { status: 'duplicate_ignored', event_id, mastery_updated: false };
    }

    // 2. Resolve or create Learner record (opaque external_ref, no PII)
    const learner = await prisma.learner.upsert({
      where: {
        tenantId_externalRef: {
          tenantId,
          externalRef: external_learner_id,
        },
      },
      update: {},
      create: {
        tenantId,
        externalRef: external_learner_id,
      },
    });

    // 3. Ensure assessment item exists or create stub if not pre-registered
    await prisma.assessmentItem.upsert({
      where: {
        tenantId_id: {
          tenantId,
          id: payload.item_id,
        },
      },
      update: {},
      create: {
        id: payload.item_id,
        tenantId,
        itemType: 'mcq',
        promptText: `Assessment Item ${payload.item_id}`,
        objectiveIds: [],
      },
    });

    // 4. Save AssessmentEvent
    await prisma.assessmentEvent.create({
      data: {
        id: event_id,
        tenantId,
        learnerId: learner.id,
        itemId: payload.item_id,
        isCorrect: payload.is_correct,
        rawResponse: payload.raw_response ?? null,
        occurredAt: new Date(occurred_at),
      },
    });

    // 5. Trigger Phase 1 naive mastery recalculation
    if (event_type === 'assessment.answered') {
      await masteryService.updateMasteryForItem(tenantId, learner.id, payload.item_id);
    }

    return { status: 'processed', event_id, mastery_updated: true };
  }
}

export const eventsService = new EventsService();
