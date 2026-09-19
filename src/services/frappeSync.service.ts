import crypto from 'crypto';
import { prisma } from '../lib/prisma.js';
import { eventsService } from './events.service.js';
import { masteryService } from './mastery.service.js';

interface FrappeQuizResultRow {
  name: string;
  question: string;
  question_name: string;
  answer: string;
  is_correct: number;
}

interface FrappeQuizSubmissionDetail {
  name: string;
  member: string;
  quiz: string;
  creation: string;
  result: FrappeQuizResultRow[];
}

interface FrappeQuizDoc {
  name: string;
  title: string;
  lesson: string | null;
}

interface FrappeLessonDoc {
  name: string;
  title: string;
}

interface FrappeEnrollmentRow {
  member: string;
}

interface FrappeProgressRow {
  member: string;
  lesson: string;
  course: string | null;
  status: string;
  modified: string;
}

export interface SyncResult {
  progressRecords: number;
  learnersRegistered: number;
  submissionsSeen: number;
  eventsIngested: number;
  errors: number;
}

/** Resolved once per quiz, cached for the rest of one sync cycle so 90 submissions of the
 * same quiz don't trigger 90 redundant lookups of the same lesson. */
interface QuizObjectiveInfo {
  objectiveId: string;
  objectiveLabel: string;
}

export class FrappeSyncService {
  /**
   * Deterministic, one-way, PII-free learner id - never sends the Frappe
   * User docname (which is typically the learner's real email) to getlearn.
   */
  anonymizeLearnerId(member: string): string {
    return 'frappe_' + crypto.createHash('sha256').update(member).digest('hex').slice(0, 32);
  }

  private authHeader(apiKey: string, apiSecret: string): string {
    return `token ${apiKey}:${apiSecret}`;
  }

  async syncTenant(tenantId: string): Promise<SyncResult> {
    const connection = await prisma.frappeConnection.findUnique({ where: { tenantId } });
    if (!connection || !connection.enabled) {
      return { progressRecords: 0, learnersRegistered: 0, submissionsSeen: 0, eventsIngested: 0, errors: 0 };
    }

    const since = connection.lastSyncedAt ?? new Date(0);
    const result: SyncResult = { progressRecords: 0, learnersRegistered: 0, submissionsSeen: 0, eventsIngested: 0, errors: 0 };
    let latestCreation = since;

    // Register every enrolled student up front, not just whoever happens to have a quiz
    // submission - otherwise a student who's only watched lessons/SCORM never shows up
    // in getlearn at all. Small school (tens of users) for now, so a full pull every
    // cycle is fine; revisit with a watermark if this ever needs to scale to thousands.
    try {
      result.learnersRegistered = await this.syncAllStudents(tenantId, connection.baseUrl, connection.apiKey, connection.apiSecret);
    } catch (err: any) {
      result.errors++;
      await this.recordError(tenantId, `student roster pull failed: ${err.message || err}`);
    }

    try {
      result.progressRecords = await this.syncLessonProgress(
        tenantId,
        connection.baseUrl,
        connection.apiKey,
        connection.apiSecret,
        connection.lastProgressSyncedAt
      );
    } catch (err: any) {
      result.errors++;
      await this.recordError(tenantId, `lesson progress pull failed: ${err.message || err}`);
    }

    // Lesson-as-objective is the level of granularity we ship with: quiz.lesson
    // already exists in Frappe today, so mastery works with zero new fields or
    // editor UI on that side. Cached per quiz name for this sync cycle only.
    const quizObjectiveCache = new Map<string, QuizObjectiveInfo | null>();

    try {
      const names = await this.fetchSubmissionNamesSince(
        connection.baseUrl,
        connection.apiKey,
        connection.apiSecret,
        since
      );

      for (const name of names) {
        result.submissionsSeen++;
        try {
          const submission = await this.fetchSubmissionDetail(
            connection.baseUrl,
            connection.apiKey,
            connection.apiSecret,
            name
          );

          const creation = new Date(submission.creation);
          if (creation > latestCreation) latestCreation = creation;

          const learnerId = this.anonymizeLearnerId(submission.member);

          const objectiveInfo = await this.getOrFetchObjectiveForQuiz(
            connection.baseUrl,
            connection.apiKey,
            connection.apiSecret,
            submission.quiz,
            quizObjectiveCache
          );

          // Resolved once here (not left to ingestEvent) because mastery needs the
          // internal learner id even when the event itself turns out to be a
          // duplicate - see the comment below on why mastery is recalculated
          // unconditionally instead of only on a fresh "processed" event.
          const learner = await prisma.learner.upsert({
            where: { tenantId_externalRef: { tenantId, externalRef: learnerId } },
            update: {},
            create: { tenantId, externalRef: learnerId },
          });

          for (const row of submission.result || []) {
            if (!row.question_name) continue; // can't map to a canonical item without a stable id

            if (objectiveInfo) {
              await this.registerObjectiveAndItem(tenantId, objectiveInfo, row.question_name, row.question);
            }

            const ingested = await eventsService.ingestEvent(tenantId, {
              event_id: `frappe_qr_${row.name}`,
              event_type: 'assessment.answered',
              external_learner_id: learnerId,
              occurred_at: submission.creation,
              payload: {
                item_id: row.question_name,
                is_correct: Boolean(row.is_correct),
                raw_response: row.answer,
              },
            });
            if (ingested.status === 'processed') {
              result.eventsIngested++;
            }

            // Recalculated unconditionally, not gated on ingested.status === 'processed':
            // an item's objective mapping can be fixed up (registerObjectiveAndItem, above)
            // for a submission that was already ingested in an earlier sync cycle, before
            // this quiz->lesson resolution existed. mastery.service.ts recomputes from all
            // of that learner's existing events for the item, so re-running this is always
            // safe, never double-counts, and is what actually backfills old data.
            if (objectiveInfo) {
              await masteryService.updateMasteryForItem(tenantId, learner.id, row.question_name);
            }
          }
        } catch (err: any) {
          result.errors++;
          await this.recordError(tenantId, `submission ${name}: ${err.message || err}`);
        }
      }

      await prisma.frappeConnection.update({
        where: { tenantId },
        data: {
          lastSyncedAt: latestCreation,
          lastSyncError: result.errors > 0 ? `${result.errors} submission(s) failed during last sync` : null,
        },
      });
    } catch (err: any) {
      result.errors++;
      await this.recordError(tenantId, `fetch failed: ${err.message || err}`);
    }

    return result;
  }

  /**
   * Pulls LMS Course Progress rows changed since the last progress watermark and upserts
   * one LessonProgress per (learner, lesson). Keyed on `modified`, not `creation`, because
   * a row flips Partially Complete -> Complete in place. The lesson becomes a
   * LearningObjective (same id the quiz mapping uses), so progress and quiz mastery for
   * a lesson line up on the same objective. A small overlap is re-read on purpose: the
   * upserts are idempotent, and it avoids missing rows that share the watermark instant.
   */
  private async syncLessonProgress(
    tenantId: string,
    baseUrl: string,
    apiKey: string,
    apiSecret: string,
    watermark: Date | null
  ): Promise<number> {
    const since = watermark ? new Date(watermark.getTime() - 60_000) : new Date(0);
    const filters = encodeURIComponent(JSON.stringify([['modified', '>', since.toISOString()]]));
    const fields = encodeURIComponent(JSON.stringify(['member', 'lesson', 'course', 'status', 'modified']));
    const orderBy = encodeURIComponent('modified asc');
    const url =
      `${baseUrl.replace(/\/$/, '')}/api/resource/${encodeURIComponent('LMS Course Progress')}` +
      `?filters=${filters}&fields=${fields}&limit_page_length=0&order_by=${orderBy}`;

    const res = await fetch(url, { headers: { Authorization: this.authHeader(apiKey, apiSecret) } });
    if (!res.ok) {
      throw new Error(`Frappe API error ${res.status} listing LMS Course Progress: ${await res.text()}`);
    }
    const data: any = await res.json();
    const rows: FrappeProgressRow[] = data.data || [];

    const lessonTitleCache = new Map<string, string>();
    let latest = watermark ?? new Date(0);
    let processed = 0;

    for (const row of rows) {
      if (!row.member || !row.lesson) continue;
      // "Incomplete" carries no signal beyond "not started", which is the absence of a row.
      const status = row.status === 'Complete' ? 'complete' : row.status === 'Partially Complete' ? 'partial' : null;
      if (!status) continue;

      let title = lessonTitleCache.get(row.lesson);
      if (title === undefined) {
        try {
          const lesson = await this.fetchDoc<FrappeLessonDoc>(baseUrl, apiKey, apiSecret, 'Course Lesson', row.lesson);
          title = lesson.title || lesson.name;
        } catch {
          title = row.lesson;
        }
        lessonTitleCache.set(row.lesson, title);
      }

      await prisma.learningObjective.upsert({
        where: { tenantId_id: { tenantId, id: row.lesson } },
        update: { label: title },
        create: { tenantId, id: row.lesson, label: title },
      });

      const learner = await prisma.learner.upsert({
        where: { tenantId_externalRef: { tenantId, externalRef: this.anonymizeLearnerId(row.member) } },
        update: {},
        create: { tenantId, externalRef: this.anonymizeLearnerId(row.member) },
      });

      const modified = new Date(row.modified);
      await prisma.lessonProgress.upsert({
        where: { tenantId_learnerId_lessonId: { tenantId, learnerId: learner.id, lessonId: row.lesson } },
        update: { status, courseId: row.course, sourceModified: modified },
        create: {
          tenantId,
          learnerId: learner.id,
          lessonId: row.lesson,
          courseId: row.course,
          status,
          sourceModified: modified,
        },
      });

      if (modified > latest) latest = modified;
      processed++;
    }

    await prisma.frappeConnection.update({
      where: { tenantId },
      data: { lastProgressSyncedAt: latest },
    });

    return processed;
  }

  /**
   * Pulls every LMS Enrollment with member_type "Student", dedupes to distinct
   * members, and upserts a Learner for each - so a student shows up in getlearn
   * as soon as they enroll, whether or not they've touched a quiz yet.
   */
  private async syncAllStudents(
    tenantId: string,
    baseUrl: string,
    apiKey: string,
    apiSecret: string
  ): Promise<number> {
    const filters = encodeURIComponent(JSON.stringify([['member_type', '=', 'Student']]));
    const fields = encodeURIComponent(JSON.stringify(['member']));
    const url =
      `${baseUrl.replace(/\/$/, '')}/api/resource/${encodeURIComponent('LMS Enrollment')}` +
      `?filters=${filters}&fields=${fields}&limit_page_length=0`;

    const res = await fetch(url, { headers: { Authorization: this.authHeader(apiKey, apiSecret) } });
    if (!res.ok) {
      throw new Error(`Frappe API error ${res.status} listing LMS Enrollment: ${await res.text()}`);
    }
    const data: any = await res.json();
    const rows: FrappeEnrollmentRow[] = data.data || [];

    const distinctMembers = new Set(rows.map((r) => r.member).filter(Boolean));

    for (const member of distinctMembers) {
      const learnerId = this.anonymizeLearnerId(member);
      await prisma.learner.upsert({
        where: { tenantId_externalRef: { tenantId, externalRef: learnerId } },
        update: {},
        create: { tenantId, externalRef: learnerId },
      });
    }

    return distinctMembers.size;
  }

  /**
   * Resolves quiz -> lesson -> LearningObjective, caching the lookup per quiz
   * for the current sync cycle. Returns null (not thrown) if the quiz has no
   * lesson linked, so the caller can still ingest the event without an
   * objective mapping rather than failing the whole submission over it.
   */
  private async getOrFetchObjectiveForQuiz(
    baseUrl: string,
    apiKey: string,
    apiSecret: string,
    quizName: string,
    cache: Map<string, QuizObjectiveInfo | null>
  ): Promise<QuizObjectiveInfo | null> {
    if (cache.has(quizName)) {
      return cache.get(quizName) ?? null;
    }

    let info: QuizObjectiveInfo | null = null;
    try {
      const quiz = await this.fetchDoc<FrappeQuizDoc>(baseUrl, apiKey, apiSecret, 'LMS Quiz', quizName);
      if (quiz.lesson) {
        const lesson = await this.fetchDoc<FrappeLessonDoc>(baseUrl, apiKey, apiSecret, 'Course Lesson', quiz.lesson);
        info = { objectiveId: lesson.name, objectiveLabel: lesson.title || lesson.name };
      }
    } catch {
      // Leave info as null - events still get ingested, just without a mastery mapping yet.
      info = null;
    }

    cache.set(quizName, info);
    return info;
  }

  private async registerObjectiveAndItem(
    tenantId: string,
    objective: QuizObjectiveInfo,
    questionName: string,
    questionText: string
  ) {
    await prisma.learningObjective.upsert({
      where: { tenantId_id: { tenantId, id: objective.objectiveId } },
      update: { label: objective.objectiveLabel },
      create: { tenantId, id: objective.objectiveId, label: objective.objectiveLabel },
    });

    await prisma.assessmentItem.upsert({
      where: { tenantId_id: { tenantId, id: questionName } },
      update: { objectiveIds: [objective.objectiveId] },
      create: {
        tenantId,
        id: questionName,
        itemType: 'mcq',
        promptText: questionText || `Assessment Item ${questionName}`,
        objectiveIds: [objective.objectiveId],
      },
    });
  }

  private async recordError(tenantId: string, message: string) {
    await prisma.frappeConnection
      .update({ where: { tenantId }, data: { lastSyncError: message } })
      .catch(() => {});
  }

  private async fetchDoc<T>(
    baseUrl: string,
    apiKey: string,
    apiSecret: string,
    doctype: string,
    name: string
  ): Promise<T> {
    const url = `${baseUrl.replace(/\/$/, '')}/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`;
    const res = await fetch(url, { headers: { Authorization: this.authHeader(apiKey, apiSecret) } });
    if (!res.ok) {
      throw new Error(`Frappe API error ${res.status} fetching ${doctype} ${name}: ${await res.text()}`);
    }
    const data: any = await res.json();
    return data.data;
  }

  private async fetchSubmissionNamesSince(
    baseUrl: string,
    apiKey: string,
    apiSecret: string,
    since: Date
  ): Promise<string[]> {
    const filters = encodeURIComponent(JSON.stringify([['creation', '>', since.toISOString()]]));
    const fields = encodeURIComponent(JSON.stringify(['name']));
    const orderBy = encodeURIComponent('creation asc');
    const url =
      `${baseUrl.replace(/\/$/, '')}/api/resource/${encodeURIComponent('LMS Quiz Submission')}` +
      `?filters=${filters}&fields=${fields}&limit_page_length=0&order_by=${orderBy}`;

    const res = await fetch(url, { headers: { Authorization: this.authHeader(apiKey, apiSecret) } });
    if (!res.ok) {
      throw new Error(`Frappe API error ${res.status} listing LMS Quiz Submission: ${await res.text()}`);
    }
    const data: any = await res.json();
    return (data.data || []).map((r: any) => r.name);
  }

  private async fetchSubmissionDetail(
    baseUrl: string,
    apiKey: string,
    apiSecret: string,
    name: string
  ): Promise<FrappeQuizSubmissionDetail> {
    return this.fetchDoc<FrappeQuizSubmissionDetail>(baseUrl, apiKey, apiSecret, 'LMS Quiz Submission', name);
  }
}

export const frappeSyncService = new FrappeSyncService();
