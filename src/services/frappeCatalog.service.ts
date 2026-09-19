import crypto from 'crypto';
import { prisma } from '../lib/prisma.js';
import { ragService } from './rag.service.js';

export interface FrappeAuth {
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
}

export interface CatalogResult {
  skipped: boolean;
  courses: number;
  lessons: number;
  lessonsWithQuiz: number;
  contentQueued: number;
}

interface LessonBlocks {
  scormFileIds: string[];
  quizNames: string[];
  assignmentIds: string[];
  text: string;
}

const CATALOG_REFRESH_MS = 60 * 60 * 1000;
const MAX_LESSON_TEXT = 100_000;

// One background indexing run per tenant at a time - extracting and embedding SCORM
// packages takes minutes, and overlapping sync cycles must not double-index.
const indexingInFlight = new Set<string>();

export class FrappeCatalogService {
  private headers(auth: FrappeAuth): Record<string, string> {
    return { Authorization: `token ${auth.apiKey}:${auth.apiSecret}` };
  }

  private base(auth: FrappeAuth): string {
    return auth.baseUrl.replace(/\/$/, '');
  }

  private async getJson(auth: FrappeAuth, path: string): Promise<any> {
    const res = await fetch(`${this.base(auth)}${path}`, { headers: this.headers(auth) });
    if (!res.ok) {
      throw new Error(`Frappe API error ${res.status} for ${path}: ${(await res.text()).slice(0, 200)}`);
    }
    return res.json();
  }

  private async getList(auth: FrappeAuth, doctype: string, fields: string[]): Promise<any[]> {
    const qs =
      `fields=${encodeURIComponent(JSON.stringify(fields))}&limit_page_length=0`;
    const data = await this.getJson(auth, `/api/resource/${encodeURIComponent(doctype)}?${qs}`);
    return data.data || [];
  }

  private async getDoc(auth: FrappeAuth, doctype: string, name: string): Promise<any> {
    const data = await this.getJson(
      auth,
      `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`
    );
    return data.data;
  }

  /** Pulls the block structure of a lesson's `content` (EditorJS JSON) into what we can use. */
  parseLessonContent(raw: string | null | undefined): LessonBlocks {
    const out: LessonBlocks = { scormFileIds: [], quizNames: [], assignmentIds: [], text: '' };
    if (!raw || !raw.trim()) return out;

    let blocks: any[] = [];
    try {
      blocks = JSON.parse(raw).blocks || [];
    } catch {
      return out;
    }

    const parts: string[] = [];
    for (const b of blocks) {
      const d = b?.data || {};
      if (b.type === 'scorm' && d.scorm_package) out.scormFileIds.push(String(d.scorm_package));
      else if (b.type === 'quiz' && d.quiz) out.quizNames.push(String(d.quiz));
      else if (b.type === 'assignment' && d.assignment) out.assignmentIds.push(String(d.assignment));
      else if (b.type === 'markdown' || b.type === 'paragraph' || b.type === 'header') {
        if (d.text) parts.push(String(d.text));
      } else if (b.type === 'list' && Array.isArray(d.items)) {
        parts.push(d.items.map((i: any) => (typeof i === 'string' ? i : i?.content ?? '')).join('\n'));
      }
    }
    out.text = parts
      .join('\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return out;
  }

  /**
   * Pulls the full course catalog - every course, its chapter/lesson order, and which lessons
   * carry a quiz - whether or not any learner has touched it yet. That's what lets
   * recommendations say "start lesson 5" or "take the quiz for lesson 3" instead of only
   * reacting to what a learner already did. Catalog is small (tens of courses, low hundreds of
   * lessons), so it's a full read, refreshed at most hourly unless forced.
   */
  async syncCatalog(tenantId: string, auth: FrappeAuth, force = false): Promise<CatalogResult> {
    const connection = await prisma.frappeConnection.findUnique({ where: { tenantId } });
    const last = connection?.lastCatalogSyncedAt;
    if (!force && last && Date.now() - last.getTime() < CATALOG_REFRESH_MS) {
      return { skipped: true, courses: 0, lessons: 0, lessonsWithQuiz: 0, contentQueued: 0 };
    }

    const courses = await this.getList(auth, 'LMS Course', ['name', 'title']);
    const courseTitle = new Map<string, string>(courses.map((c) => [c.name, c.title || c.name]));

    // Lesson order: course.chapters[].idx, then chapter.lessons[].idx.
    const sequence = new Map<string, { courseId: string; seq: number; chapterId: string }>();
    for (const course of courses) {
      const courseDoc = await this.getDoc(auth, 'LMS Course', course.name);
      const chapters: { chapter: string }[] = courseDoc.chapters || [];
      for (let ci = 0; ci < chapters.length; ci++) {
        const chapterDoc = await this.getDoc(auth, 'Course Chapter', chapters[ci].chapter);
        await this.upsertChapter(tenantId, course.name, ci, chapterDoc);
        const lessons: { lesson: string }[] = chapterDoc.lessons || [];
        for (let li = 0; li < lessons.length; li++) {
          sequence.set(lessons[li].lesson, { courseId: course.name, seq: ci * 1000 + li, chapterId: chapters[ci].chapter });
        }
      }
    }
    await this.syncAssignments(tenantId, auth);

    const lessonRows = await this.getList(auth, 'Course Lesson', ['name', 'title', 'course', 'content', 'modified']);
    const quizRows = await this.getList(auth, 'LMS Quiz', ['name', 'lesson']);
    const quizByLesson = new Map<string, string>();
    for (const q of quizRows) if (q.lesson) quizByLesson.set(q.lesson, q.name);

    let lessonsWithQuiz = 0;
    const toIndex: { lessonId: string; blocks: LessonBlocks; version: string }[] = [];

    for (const row of lessonRows) {
      const blocks = this.parseLessonContent(row.content);
      const quizRef = quizByLesson.get(row.name) ?? blocks.quizNames[0] ?? null;
      if (quizRef) lessonsWithQuiz++;

      const placement = sequence.get(row.name);
      const courseId = placement?.courseId ?? row.course ?? null;

      await prisma.learningObjective.upsert({
        where: { tenantId_id: { tenantId, id: row.name } },
        update: {
          label: row.title || row.name,
          courseId,
          courseLabel: courseId ? courseTitle.get(courseId) ?? courseId : null,
          sequence: placement?.seq ?? null,
          chapterId: placement?.chapterId ?? null,
          assignmentRef: blocks.assignmentIds[0] ?? null,
          assessmentRef: quizRef,
        },
        create: {
          tenantId,
          id: row.name,
          label: row.title || row.name,
          courseId,
          courseLabel: courseId ? courseTitle.get(courseId) ?? courseId : null,
          sequence: placement?.seq ?? null,
          chapterId: placement?.chapterId ?? null,
          assignmentRef: blocks.assignmentIds[0] ?? null,
          assessmentRef: quizRef,
        },
      });

      if (blocks.text || blocks.scormFileIds.length) {
        const version = crypto
          .createHash('sha256')
          .update(`${row.modified}|${blocks.scormFileIds.join(',')}|${blocks.text}`)
          .digest('hex')
          .slice(0, 16);
        toIndex.push({ lessonId: row.name, blocks, version });
      }
    }

    await prisma.frappeConnection.update({
      where: { tenantId },
      data: { lastCatalogSyncedAt: new Date() },
    });

    const contentQueued = await this.queueContentIndexing(tenantId, auth, toIndex);

    return {
      skipped: false,
      courses: courses.length,
      lessons: lessonRows.length,
      lessonsWithQuiz,
      contentQueued,
    };
  }

  /** A Frappe date ("2026-10-01") or datetime as a UTC-midnight Date of its date part, like Frappe's getdate(). */
  toDate(value: unknown): Date | null {
    if (!value) return null;
    const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
  }

  toDateTime(value: unknown): Date | null {
    if (!value) return null;
    const d = new Date(String(value).replace(' ', 'T').replace(/(\.\d+)?$/, '') + 'Z');
    return Number.isNaN(d.getTime()) ? null : d;
  }

  /** The LMS stores assignment instructions as HTML; the coach needs plain text (capped). */
  private htmlToText(html: unknown): string | null {
    if (!html) return null;
    const text = String(html)
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<\/(p|div|h[1-6]|li|tr|br)>|<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s*\n+/g, '\n')
      .trim();
    return text ? text.slice(0, 3000) : null;
  }

  private async upsertChapter(tenantId: string, courseId: string, sequence: number, doc: any) {
    const data = {
      courseId,
      title: doc.title || doc.name,
      sequence,
      dripType: doc.drip_type || null,
      dripDate: this.toDate(doc.drip_date),
      dripDays: doc.drip_days != null ? Number(doc.drip_days) : null,
      deadlineDays: doc.deadline_days != null ? Number(doc.deadline_days) : null,
    };
    await prisma.courseChapter.upsert({
      where: { tenantId_chapterId: { tenantId, chapterId: doc.name } },
      update: data,
      create: { tenantId, chapterId: doc.name, ...data },
    });
  }

  /** Assignments and their own schedule; small (tens), so a full read every catalog refresh. */
  private async syncAssignments(tenantId: string, auth: FrappeAuth) {
    const rows = await this.getList(auth, 'LMS Assignment', [
      'name', 'title', 'course', 'question', 'enable_scheduling', 'schedule_start', 'schedule_end',
      'deadline_type', 'deadline_days', 'drip_type', 'drip_date', 'drip_days',
    ]);
    for (const a of rows) {
      const data = {
        courseId: a.course || null,
        title: a.title || a.name,
        question: this.htmlToText(a.question),
        enableScheduling: Boolean(Number(a.enable_scheduling)),
        scheduleStart: this.toDateTime(a.schedule_start),
        scheduleEnd: this.toDateTime(a.schedule_end),
        deadlineType: a.deadline_type || null,
        deadlineDays: a.deadline_days != null ? Number(a.deadline_days) : null,
        dripType: a.drip_type || null,
        dripDate: this.toDate(a.drip_date),
        dripDays: a.drip_days != null ? Number(a.drip_days) : null,
      };
      await prisma.assignment.upsert({
        where: { tenantId_assignmentId: { tenantId, assignmentId: a.name } },
        update: data,
        create: { tenantId, assignmentId: a.name, ...data },
      });
    }
  }

  /** Only lessons whose content version changed are re-extracted; the rest are left alone. */
  private async queueContentIndexing(
    tenantId: string,
    auth: FrappeAuth,
    candidates: { lessonId: string; blocks: LessonBlocks; version: string }[]
  ): Promise<number> {
    const marker = (lessonId: string, version: string) => `frappe:lesson/${lessonId}?v=${version}`;

    const existing = await prisma.contentItem.findMany({
      where: { tenantId, id: { in: candidates.map((c) => c.lessonId) } },
      select: { id: true, sourceUri: true },
    });
    const currentMarker = new Map(existing.map((e) => [e.id, e.sourceUri]));
    const stale = candidates.filter((c) => currentMarker.get(c.lessonId) !== marker(c.lessonId, c.version));

    if (!stale.length || indexingInFlight.has(tenantId)) return 0;

    indexingInFlight.add(tenantId);
    void (async () => {
      let done = 0;
      for (const item of stale) {
        try {
          await this.indexLesson(tenantId, auth, item.lessonId, item.blocks, marker(item.lessonId, item.version));
          done++;
        } catch (err: any) {
          console.error(`[frappe-catalog] indexing lesson '${item.lessonId}' failed: ${err?.message || err}`);
        }
      }
      console.log(`[frappe-catalog] tenant=${tenantId} indexed ${done}/${stale.length} lesson(s)`);
    })().finally(() => indexingInFlight.delete(tenantId));

    return stale.length;
  }

  private async indexLesson(
    tenantId: string,
    auth: FrappeAuth,
    lessonId: string,
    blocks: LessonBlocks,
    sourceMarker: string
  ) {
    const parts: string[] = [];
    if (blocks.text) parts.push(blocks.text);

    for (const fileId of blocks.scormFileIds) {
      const file = await this.getDoc(auth, 'File', fileId);
      if (!file?.file_url) continue;
      const text = await ragService.extractScormFromUrl(`${this.base(auth)}${file.file_url}`, this.headers(auth));
      if (text) parts.push(text);
    }

    const rawText = parts.join('\n\n').slice(0, MAX_LESSON_TEXT);
    if (!rawText.trim()) return;

    await prisma.contentItem.upsert({
      where: { tenantId_id: { tenantId, id: lessonId } },
      update: {
        type: blocks.scormFileIds.length ? 'scorm' : 'text',
        rawText,
        objectiveIds: [lessonId],
        indexingStatus: 'pending',
        indexingError: null,
      },
      create: {
        id: lessonId,
        tenantId,
        type: blocks.scormFileIds.length ? 'scorm' : 'text',
        rawText,
        objectiveIds: [lessonId],
        indexingStatus: 'pending',
      },
    });

    try {
      await ragService.chunkAndEmbedContentItem(tenantId, lessonId, rawText);
    } catch (err: any) {
      // Marker deliberately not written, so the next cycle retries this lesson.
      await prisma.contentItem.update({
        where: { tenantId_id: { tenantId, id: lessonId } },
        data: { indexingStatus: 'failed', indexingError: String(err?.message || err).slice(0, 500) },
      });
      throw err;
    }
    // The version marker is written only once indexing succeeded.
    await prisma.contentItem.update({
      where: { tenantId_id: { tenantId, id: lessonId } },
      data: { indexingStatus: 'completed', indexingError: null, sourceUri: sourceMarker },
    });
  }
}

export const frappeCatalogService = new FrappeCatalogService();
