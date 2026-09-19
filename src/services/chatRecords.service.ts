import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

/**
 * Chat records for analytics and product improvement. A "record" is one turn: the learner's
 * question paired with the coach's answer, plus how the answer was produced (which model, whether
 * any lesson material matched, how long it took, what it cost).
 *
 * Learners appear only by their anonymous id. Message text is whatever the learner typed, so a
 * record can still contain personal details they chose to write - treat exports accordingly.
 */

export interface RecordFilters {
  from?: Date;
  to?: Date;
  before?: Date;
  learnerRef?: string;
  lessonId?: string;
  outcome?: string;
  limit: number;
}

export interface ChatRecord {
  message_id: string;
  session_id: string;
  learner_id: string;
  lesson_id: string | null;
  lesson: string | null;
  asked_at: string;
  answered_at: string;
  question: string;
  answer: string;
  outcome: string;
  provider: string | null;
  latency_ms: number | null;
  tokens_used: number | null;
  retrieval_count: number | null;
  top_similarity: number | null;
  source_lessons: string[];
  guardrail: string | null;
  feedback: number | null;
}

const CSV_COLUMNS: Array<keyof ChatRecord> = [
  'answered_at', 'asked_at', 'session_id', 'learner_id', 'lesson_id', 'lesson', 'question', 'answer', 'outcome',
  'provider', 'latency_ms', 'tokens_used', 'retrieval_count', 'top_similarity', 'source_lessons', 'guardrail', 'feedback',
];

/** RFC 4180 CSV. Cells starting with = + - @ are prefixed so a spreadsheet never runs them as formulas. */
export function toCsv(records: ChatRecord[]): string {
  const cell = (value: unknown): string => {
    if (typeof value === 'number') return String(value); // numbers (incl. negatives) are data, not formulas
    let s = Array.isArray(value) ? value.join(' | ') : value == null ? '' : String(value);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of records) lines.push(CSV_COLUMNS.map((c) => cell(r[c])).join(','));
  return lines.join('\r\n') + '\r\n';
}

export class ChatRecordsService {
  async listRecords(tenantId: string, f: RecordFilters): Promise<ChatRecord[]> {
    const assistants = await prisma.chatMessage.findMany({
      where: {
        sender: 'assistant',
        createdAt: {
          ...(f.from ? { gte: f.from } : {}),
          ...(f.to ? { lte: f.to } : {}),
          ...(f.before ? { lt: f.before } : {}),
        },
        ...(f.outcome ? { outcome: f.outcome } : {}),
        ...(f.lessonId ? { OR: [{ lessonId: f.lessonId }, { lessonId: null, session: { objectiveIds: { has: f.lessonId } } }] } : {}),
        session: {
          tenantId,
          ...(f.learnerRef ? { learner: { externalRef: f.learnerRef } } : {}),
        },
      },
      orderBy: { createdAt: 'desc' },
      take: f.limit,
      include: { session: { select: { id: true, objectiveIds: true, learner: { select: { externalRef: true } } } } },
    });
    if (!assistants.length) return [];

    // Pair each answer with the learner message just before it in the same session. An assistant
    // message with no learner message before it is the automatic greeting, not a turn.
    const sessionIds = [...new Set(assistants.map((a) => a.sessionId))];
    const oldest = assistants[assistants.length - 1].createdAt;
    const learnerMessages = await prisma.chatMessage.findMany({
      where: { sender: 'user', sessionId: { in: sessionIds }, createdAt: { lte: assistants[0].createdAt, gte: new Date(oldest.getTime() - 24 * 3_600_000) } },
      orderBy: { createdAt: 'asc' },
      select: { sessionId: true, content: true, createdAt: true },
    });
    const bySession = new Map<string, typeof learnerMessages>();
    for (const m of learnerMessages) bySession.set(m.sessionId, [...(bySession.get(m.sessionId) ?? []), m]);

    const lessonIds = new Set<string>();
    for (const a of assistants) {
      const own = a.lessonId ?? a.session.objectiveIds[0];
      if (own) lessonIds.add(own);
      a.sourceContentIds.forEach((id) => lessonIds.add(id));
    }
    const labels = new Map(
      (await prisma.learningObjective.findMany({ where: { tenantId, id: { in: [...lessonIds] } }, select: { id: true, label: true } })).map((o) => [o.id, o.label])
    );

    const records: ChatRecord[] = [];
    for (const a of assistants) {
      const question = [...(bySession.get(a.sessionId) ?? [])].reverse().find((m) => m.createdAt <= a.createdAt);
      if (!question) continue;
      const lessonId = a.lessonId ?? a.session.objectiveIds[0] ?? null;
      records.push({
        message_id: a.id,
        session_id: a.sessionId,
        learner_id: a.session.learner.externalRef,
        lesson_id: lessonId,
        lesson: lessonId ? labels.get(lessonId) ?? lessonId : null,
        asked_at: question.createdAt.toISOString(),
        answered_at: a.createdAt.toISOString(),
        question: question.content,
        answer: a.content,
        outcome: a.outcome ?? 'unknown',
        provider: a.provider,
        latency_ms: a.latencyMs,
        tokens_used: a.tokensUsed,
        retrieval_count: a.retrievalCount,
        top_similarity: a.topSimilarity,
        source_lessons: a.sourceContentIds.map((id) => labels.get(id) ?? id),
        guardrail: a.guardrail,
        feedback: a.feedback,
      });
    }
    return records;
  }

  /** Aggregates for the last `days` days. Questions = learner messages; outcomes come from the answers. */
  async summary(tenantId: string, days: number) {
    const since = new Date(Date.now() - days * 24 * 3_600_000);
    type Row = Record<string, any>;
    const q = <T = Row[]>(sql: Prisma.Sql) => prisma.$queryRaw<T>(sql);

    const [totals, byDay, outcomes, providers, feedback, lessons] = await Promise.all([
      q(Prisma.sql`
        SELECT COUNT(DISTINCT s.id)::int AS sessions,
               COUNT(DISTINCT s.learner_id)::int AS learners,
               COUNT(*) FILTER (WHERE m.sender = 'user')::int AS questions,
               COUNT(*) FILTER (WHERE m.sender = 'assistant' AND m.outcome IS NOT NULL)::int AS answers_tracked
        FROM chat_messages m JOIN chat_sessions s ON s.id = m.session_id
        WHERE s.tenant_id = ${tenantId} AND m.created_at >= ${since}`),
      q(Prisma.sql`
        SELECT to_char((m.created_at AT TIME ZONE 'Asia/Jakarta')::date, 'YYYY-MM-DD') AS day,
               COUNT(*)::int AS questions
        FROM chat_messages m JOIN chat_sessions s ON s.id = m.session_id
        WHERE s.tenant_id = ${tenantId} AND m.sender = 'user' AND m.created_at >= ${since}
        GROUP BY 1 ORDER BY 1`),
      q(Prisma.sql`
        SELECT COALESCE(m.outcome, 'unknown') AS outcome, COUNT(*)::int AS n
        FROM chat_messages m JOIN chat_sessions s ON s.id = m.session_id
        WHERE s.tenant_id = ${tenantId} AND m.sender = 'assistant' AND m.created_at >= ${since}
          AND EXISTS (SELECT 1 FROM chat_messages u WHERE u.session_id = m.session_id AND u.sender = 'user' AND u.created_at <= m.created_at)
        GROUP BY 1 ORDER BY 2 DESC`),
      q(Prisma.sql`
        SELECT m.provider, COUNT(*)::int AS n,
               ROUND(AVG(m.latency_ms))::int AS avg_latency_ms,
               COALESCE(SUM(m.tokens_used), 0)::int AS tokens
        FROM chat_messages m JOIN chat_sessions s ON s.id = m.session_id
        WHERE s.tenant_id = ${tenantId} AND m.sender = 'assistant' AND m.provider IS NOT NULL AND m.created_at >= ${since}
        GROUP BY 1 ORDER BY 2 DESC`),
      q(Prisma.sql`
        SELECT COUNT(*) FILTER (WHERE m.feedback = 1)::int AS up, COUNT(*) FILTER (WHERE m.feedback = -1)::int AS down
        FROM chat_messages m JOIN chat_sessions s ON s.id = m.session_id
        WHERE s.tenant_id = ${tenantId} AND m.sender = 'assistant' AND m.created_at >= ${since}`),
      q(Prisma.sql`
        SELECT COALESCE(m.lesson_id, s.objective_ids[1]) AS lesson_id, COUNT(DISTINCT s.id)::int AS sessions,
               COUNT(*) FILTER (WHERE m.sender = 'user')::int AS questions
        FROM chat_messages m JOIN chat_sessions s ON s.id = m.session_id
        WHERE s.tenant_id = ${tenantId} AND m.created_at >= ${since} AND COALESCE(m.lesson_id, s.objective_ids[1]) IS NOT NULL
        GROUP BY 1 ORDER BY 3 DESC LIMIT 10`),
    ]);

    const lessonLabels = new Map(
      (await prisma.learningObjective.findMany({
        where: { tenantId, id: { in: lessons.map((l: Row) => l.lesson_id) } },
        select: { id: true, label: true },
      })).map((o) => [o.id, o.label])
    );

    // Questions the material could not answer: the clearest signal of what content is missing.
    const gaps = await this.listRecords(tenantId, { from: since, outcome: 'no_material', limit: 25 });

    const t = totals[0] ?? { sessions: 0, learners: 0, questions: 0, answers_tracked: 0 };
    // Rates cover only answers recorded with an outcome; older rows have none and would skew them.
    const answered = outcomes.filter((o: Row) => o.outcome !== 'unknown').reduce((s: number, o: Row) => s + o.n, 0);
    const n = (name: string) => outcomes.find((o: Row) => o.outcome === name)?.n ?? 0;
    return {
      period_days: days,
      sessions: t.sessions,
      active_learners: t.learners,
      questions: t.questions,
      questions_per_session: t.sessions ? Math.round((t.questions / t.sessions) * 10) / 10 : 0,
      by_day: byDay,
      outcomes,
      answered_rate: answered ? Math.round((n('answered') / answered) * 100) : null,
      no_material_rate: answered ? Math.round((n('no_material') / answered) * 100) : null,
      failure_rate: answered ? Math.round((n('provider_failed') / answered) * 100) : null,
      providers,
      tokens_total: providers.reduce((s: number, p: Row) => s + p.tokens, 0),
      feedback: feedback[0] ?? { up: 0, down: 0 },
      top_lessons: lessons.map((l: Row) => ({ lesson_id: l.lesson_id, lesson: lessonLabels.get(l.lesson_id) ?? l.lesson_id, sessions: l.sessions, questions: l.questions })),
      unanswered_questions: gaps.map((g) => ({ asked_at: g.asked_at, lesson: g.lesson, question: g.question })),
      note: 'Outcome-based figures cover only answers recorded after chat analytics was enabled.',
    };
  }

  async setFeedback(tenantId: string, messageId: string, value: 1 | -1 | 0): Promise<boolean> {
    const result = await prisma.chatMessage.updateMany({
      where: { id: messageId, sender: 'assistant', session: { tenantId } },
      data: { feedback: value === 0 ? null : value, feedbackAt: value === 0 ? null : new Date() },
    });
    return result.count > 0;
  }
}

export const chatRecordsService = new ChatRecordsService();
