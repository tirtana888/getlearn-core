import { prisma } from '../lib/prisma.js';

/**
 * What the coach may know about a learner beyond the course material: when chapters open and
 * close (drip + deadlines), which assignments are due or unsubmitted, and the scores of their
 * quizzes. Everything is pulled from the LMS by the sync and evaluated here, per learner, with the
 * same three drip rules the LMS uses - the LMS itself runs no extra code for this.
 *
 * The result is plain text for the model's prompt. It only ever contains the learner's own data
 * (anonymous id, no name/email) and never the content of a submission.
 */

const DAY_MS = 86_400_000;
const MAX_CHARS = 4000;
// Each part gets its own budget. A learner in many courses has a long drip schedule; without
// separate budgets it used up the whole limit and the scores and assignments never made it in.
const BUDGET = { tasks: 1100, scores: 1000, schedule: 1700 } as const;

/** Keeps whole lines, in order, until the budget is spent. */
function within(lines: string[], budget: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > budget) break;
    out.push(line);
    used += line.length + 1;
  }
  return out;
}

export interface LmsContextInput {
  /** Today as YYYY-MM-DD in the school's timezone. */
  today: string;
  courseLabels: Record<string, string>;
  enrollments: Array<{ courseId: string; enrolledAt: Date | null; batchStartDate: Date | null }>;
  chapters: Array<{
    chapterId: string;
    courseId: string;
    title: string;
    dripType: string | null;
    dripDate: Date | null;
    dripDays: number | null;
    deadlineDays: number | null;
  }>;
  assignments: Array<{
    assignmentId: string;
    courseId: string | null;
    title: string;
    enableScheduling: boolean;
    scheduleStart: Date | null;
    scheduleEnd: Date | null;
    deadlineType: string | null;
    deadlineDays: number | null;
    dripType: string | null;
    dripDate: Date | null;
    dripDays: number | null;
  }>;
  submissions: Array<{ assignmentId: string; status: string }>;
  quizAttempts: Array<{
    quizId: string;
    quizTitle: string;
    courseId: string | null;
    score: number | null;
    scoreOutOf: number | null;
    percentage: number | null;
    passingPercentage: number | null;
    submittedAt: Date;
  }>;
}

/** Jakarta's calendar date for "now" (Nusadaya's site runs on WIB). */
export function todayInSchoolTz(now = new Date(), timeZone = 'Asia/Jakarta'): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(now);
}

const ymd = (d: Date | null | undefined): string => (d ? d.toISOString().slice(0, 10) : '');
const addDays = (d: Date, n: number): Date => new Date(d.getTime() + n * DAY_MS);

/** The LMS's drip rule: the date an item opens for this learner, or null if it cannot be resolved. */
export function releaseDate(
  dripType: string | null,
  dripDate: Date | null,
  dripDays: number | null,
  enrolledAt: Date | null,
  batchStartDate: Date | null
): Date | null {
  if (dripType === 'On a fixed date') return dripDate;
  if (dripType === 'Days after enrollment') return enrolledAt ? addDays(enrolledAt, dripDays ?? 0) : null;
  if (dripType === 'Days after batch start') {
    const anchor = batchStartDate ?? enrolledAt; // a direct enrolment counts from enrolment, as in the LMS
    return anchor ? addDays(anchor, dripDays ?? 0) : null;
  }
  return null;
}

export function renderLmsContext(input: LmsContextInput): string {
  const { today } = input;
  const label = (courseId: string | null) => (courseId ? input.courseLabels[courseId] ?? courseId : '');
  const anchors = new Map(input.enrollments.map((e) => [e.courseId, e]));
  const schedule: string[] = [];
  const tasks: string[] = [];
  const scores: string[] = [];

  // ---- course schedule: chapters that are still locked, passed and upcoming chapter deadlines
  for (const enrollment of input.enrollments) {
    const chapters = input.chapters.filter((c) => c.courseId === enrollment.courseId);
    const locked: Array<[string, string]> = [];
    const closed: Array<[string, string]> = [];
    const upcoming: Array<[string, string]> = [];

    for (const ch of chapters) {
      const opens = releaseDate(ch.dripType, ch.dripDate, ch.dripDays, enrollment.enrolledAt, enrollment.batchStartDate);
      if (opens && ymd(opens) > today) locked.push([ymd(opens), ch.title]);
      if (opens && ch.deadlineDays && ch.deadlineDays > 0) {
        const due = ymd(addDays(opens, ch.deadlineDays));
        if (due < today) closed.push([due, ch.title]);
        else upcoming.push([due, ch.title]);
      }
    }

    const notes: string[] = [];
    if (locked.length) {
      locked.sort();
      notes.push('bab belum dibuka (drip): ' + locked.slice(0, 3).map(([d, t]) => `${t} (dibuka ${d})`).join('; '));
    }
    if (closed.length) {
      closed.sort();
      notes.push('deadline bab sudah lewat: ' + closed.slice(-2).map(([d, t]) => `${t} (${d})`).join('; '));
    }
    if (upcoming.length) {
      upcoming.sort();
      notes.push('deadline bab berikutnya: ' + upcoming.slice(0, 2).map(([d, t]) => `${t} (${d})`).join('; '));
    }
    if (notes.length) {
      schedule.push(`- ${label(enrollment.courseId)}: ${notes.join(' | ')}`);
    }
  }

  // ---- assignments and their status
  if (input.assignments.length) {
    const status = new Map(input.submissions.map((s) => [s.assignmentId, s.status]));
    const rows: Array<{ rank: [number, number, string]; text: string }> = [];

    for (const a of input.assignments) {
      const enrollment = a.courseId ? anchors.get(a.courseId) : undefined;
      let opens = releaseDate(a.dripType, a.dripDate, a.dripDays, enrollment?.enrolledAt ?? null, enrollment?.batchStartDate ?? null);
      if (a.enableScheduling && a.scheduleStart) opens = a.scheduleStart;

      let due: string | null = null;
      if (a.enableScheduling) {
        const relative = a.deadlineType === 'Days after release';
        const releaseForDeadline = releaseDate(a.dripType, a.dripDate, a.dripDays, enrollment?.enrolledAt ?? null, enrollment?.batchStartDate ?? null);
        if (relative && releaseForDeadline) due = ymd(addDays(releaseForDeadline, a.deadlineDays ?? 0));
        else if (a.scheduleEnd) due = ymd(a.scheduleEnd);
      }

      const submitted = status.get(a.assignmentId);
      const parts: string[] = [];
      if (submitted) {
        parts.push(
          ({ Pass: 'sudah dikumpulkan, lulus', Fail: 'sudah dikumpulkan, belum lulus', 'Not Graded': 'sudah dikumpulkan, menunggu dinilai' } as Record<string, string>)[submitted] ??
            'sudah dikumpulkan'
        );
      } else {
        parts.push('BELUM dikumpulkan');
      }
      if (opens && ymd(opens) > today) parts.push(`baru dibuka ${ymd(opens)}`);
      const overdue = Boolean(due && due < today);
      if (due) parts.push(`${overdue ? 'deadline lewat' : 'deadline'} ${due}`);

      rows.push({
        rank: [submitted ? 1 : 0, overdue ? 0 : 1, due ?? '9999'],
        text: `- ${a.title}${a.courseId ? ` [${label(a.courseId)}]` : ''}: ${parts.join(', ')}`,
      });
    }

    rows.sort((x, y) => x.rank[0] - y.rank[0] || x.rank[1] - y.rank[1] || x.rank[2].localeCompare(y.rank[2]));
    const done = input.assignments.filter((a) => status.get(a.assignmentId)).length;
    tasks.push(`Tugas (assignment): ${done} dari ${input.assignments.length} sudah dikumpulkan.`);
    tasks.push(...rows.slice(0, 10).map((r) => r.text));
  }

  // ---- quiz scores, one line per quiz (best and latest attempt)
  if (input.quizAttempts.length) {
    const byQuiz = new Map<string, LmsContextInput['quizAttempts']>();
    for (const q of input.quizAttempts) byQuiz.set(q.quizId, [...(byQuiz.get(q.quizId) ?? []), q]);

    const pct = (q: LmsContextInput['quizAttempts'][number]): number | null =>
      q.percentage ?? (q.score != null && q.scoreOutOf ? Math.round((q.score / q.scoreOutOf) * 100) : null);

    const summaries = [...byQuiz.values()]
      .map((attempts) => {
        const sorted = [...attempts].sort((a, b) => b.submittedAt.getTime() - a.submittedAt.getTime());
        const latest = sorted[0];
        const values = attempts.map(pct).filter((v): v is number => v != null);
        const best = values.length ? Math.max(...values) : null;
        const passing = latest.passingPercentage;
        const verdict = best != null && passing ? (best >= passing ? `lulus (batas ${passing}%)` : `belum lulus (batas ${passing}%)`) : '';
        const latestPct = pct(latest);
        const detail = latest.score != null && latest.scoreOutOf ? ` (${latest.score}/${latest.scoreOutOf})` : '';
        return {
          at: latest.submittedAt.getTime(),
          best,
          text:
            `- ${latest.quizTitle}${latest.courseId ? ` [${label(latest.courseId)}]` : ''}: ` +
            [
              latestPct != null ? `terakhir ${latestPct}%${detail}` : null,
              best != null && attempts.length > 1 ? `terbaik ${best}%` : null,
              `${attempts.length}x percobaan`,
              verdict || null,
            ]
              .filter(Boolean)
              .join(', '),
        };
      })
      .sort((a, b) => b.at - a.at);

    const bests = summaries.map((s) => s.best).filter((v): v is number => v != null);
    scores.push(
      `Skor quiz (${summaries.length} quiz` + (bests.length ? `, rata-rata nilai terbaik ${Math.round(bests.reduce((s, v) => s + v, 0) / bests.length)}%` : '') + '):'
    );
    scores.push(...summaries.slice(0, 10).map((s) => s.text));
  }

  if (!schedule.length && !tasks.length && !scores.length) return '';
  // Most decision-relevant first: what is owed, what was scored, then what opens/closes when.
  return [
    `Tanggal hari ini: ${today}`,
    ...within(tasks, BUDGET.tasks),
    ...within(scores, BUDGET.scores),
    ...within(schedule, BUDGET.schedule),
  ]
    .join('\n')
    .slice(0, MAX_CHARS);
}

/** Loads one learner's data and renders it. Best effort: never throws into the chat. */
export async function buildLmsContext(tenantId: string, learnerId: string): Promise<string> {
  try {
    const enrollments = await prisma.enrollment.findMany({
      where: { tenantId, learnerId },
      select: { courseId: true, courseLabel: true, enrolledAt: true, batchStartDate: true },
      take: 12,
    });
    if (!enrollments.length) return '';
    const courseIds = enrollments.map((e) => e.courseId);

    const [chapters, assignments, submissions, quizAttempts] = await Promise.all([
      prisma.courseChapter.findMany({ where: { tenantId, courseId: { in: courseIds } } }),
      prisma.assignment.findMany({ where: { tenantId, courseId: { in: courseIds } }, take: 60 }),
      prisma.assignmentSubmission.findMany({ where: { tenantId, learnerId }, select: { assignmentId: true, status: true } }),
      prisma.quizAttempt.findMany({ where: { tenantId, learnerId }, orderBy: { submittedAt: 'desc' }, take: 80 }),
    ]);

    return renderLmsContext({
      today: todayInSchoolTz(),
      courseLabels: Object.fromEntries(enrollments.map((e) => [e.courseId, e.courseLabel ?? e.courseId])),
      enrollments,
      chapters,
      assignments,
      submissions,
      quizAttempts,
    });
  } catch (err: any) {
    console.warn('[lms-context] unavailable:', err?.message || err);
    return '';
  }
}
