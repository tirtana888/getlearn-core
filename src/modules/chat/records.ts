import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authMiddleware } from '../../middlewares/auth.middleware.js';
import { chatRecordsService, toCsv, testLearnerRefs } from '../../services/chatRecords.service.js';

const OUTCOMES = ['answered', 'no_material', 'vague_fallback', 'provider_failed', 'dev_fallback', 'unknown'] as const;

const RecordsQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  before: z.coerce.date().optional(), // cursor: return records answered before this instant
  learner_id: z.string().min(1).optional(),
  lesson_id: z.string().min(1).optional(),
  outcome: z.enum(OUTCOMES).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  // Internal test accounts (ANALYTICS_TEST_LEARNERS) are hidden unless this is 'true'.
  include_test: z.enum(['true', 'false']).optional(),
});

const ExportQuery = RecordsQuery.extend({ limit: z.coerce.number().int().min(1).max(5000).default(1000) });

const SummaryQuery = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
  include_test: z.enum(['true', 'false']).optional(),
});

const FeedbackBody = z.object({ value: z.union([z.literal(1), z.literal(-1), z.literal(0)]) });

function invalid(reply: any, error: z.ZodError) {
  return reply.status(400).send({
    error: { code: 'INVALID_QUERY', message: 'Validation failed', details: error.errors.map((e) => `${e.path.join('.')}: ${e.message}`) },
  });
}

export async function chatRecordsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  const toFilters = (q: z.infer<typeof RecordsQuery>) => ({
    from: q.from,
    to: q.to,
    before: q.before,
    learnerRef: q.learner_id,
    lessonId: q.lesson_id,
    outcome: q.outcome,
    excludeLearners: q.include_test === 'true' ? [] : testLearnerRefs(),
    limit: q.limit,
  });

  // GET /v1/chat/records - question/answer turns with how each answer was produced, newest first.
  // Page through with `before` = the last record's answered_at.
  app.get('/v1/chat/records', async (req, reply) => {
    const parsed = RecordsQuery.safeParse(req.query);
    if (!parsed.success) return invalid(reply, parsed.error);
    const records = await chatRecordsService.listRecords(req.tenantId, toFilters(parsed.data));
    return reply.status(200).send({
      records,
      next_before: records.length ? records[records.length - 1].answered_at : null,
    });
  });

  // GET /v1/chat/records/export?format=csv|jsonl - the same records as a download.
  app.get('/v1/chat/records/export', async (req, reply) => {
    const parsed = ExportQuery.extend({ format: z.enum(['csv', 'jsonl']).default('csv') }).safeParse(req.query);
    if (!parsed.success) return invalid(reply, parsed.error);
    const records = await chatRecordsService.listRecords(req.tenantId, toFilters(parsed.data));
    const stamp = new Date().toISOString().slice(0, 10);

    if (parsed.data.format === 'jsonl') {
      reply.header('Content-Type', 'application/x-ndjson; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="chat-records-${stamp}.jsonl"`);
      return reply.send(records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    }
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="chat-records-${stamp}.csv"`);
    // BOM so Excel opens Indonesian text as UTF-8.
    return reply.send('﻿' + toCsv(records));
  });

  // GET /v1/analytics/chat?days=30 - volume, outcomes, model/latency/cost, lesson hot spots and the
  // questions the material could not answer.
  app.get('/v1/analytics/chat', async (req, reply) => {
    const parsed = SummaryQuery.safeParse(req.query);
    if (!parsed.success) return invalid(reply, parsed.error);
    const exclude = parsed.data.include_test === 'true' ? [] : testLearnerRefs();
    return reply.status(200).send(await chatRecordsService.summary(req.tenantId, parsed.data.days, exclude));
  });

  // POST /v1/chat/messages/:id/feedback {value: 1 | -1 | 0} - a learner's thumbs on an answer.
  app.post('/v1/chat/messages/:id/feedback', async (req, reply) => {
    const parsed = FeedbackBody.safeParse(req.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    const { id } = req.params as { id: string };
    const ok = await chatRecordsService.setFeedback(req.tenantId, id, parsed.data.value);
    if (!ok) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Answer not found.' } });
    return reply.status(200).send({ message_id: id, feedback: parsed.data.value === 0 ? null : parsed.data.value });
  });
}
