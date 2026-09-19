/**
 * Pure helpers for the chat's tutoring guardrails and follow-up suggestions. No database, no
 * network, so they can be tested offline.
 */

export type HintTrigger = 'answer_seeking' | 'exam_shaped' | 'assignment_lesson' | 'assessment_lesson';

// A blank the learner is meant to fill in, as pasted from a worksheet or an interactive lesson.
const STRONG_BLANK = /(titik[- ]titik|kolom isian|ketikkan jawaban|ketik jawaban|_{3,}|\(\s*\.{2,}\s*\)|\[\s*\.{2,}\s*\])/i;
// "... " between words inside a longer sentence ("adalah ... tidak terganggu"), not a trailing "hmm..."
const INLINE_ELLIPSIS = /\S+\s*(\.{3,}|…)\s*\S+/;
// Two consecutive option lines: "a. ...\nb. ..." or "(a) ...\n(b) ..."
const OPTION_LINES = /(^|\n)\s*\(?[a-e][.)]\s+\S[^\n]*\n\s*\(?[a-e][.)]\s+\S/i;
// Asking for the answer itself.
const ANSWER_SEEKING =
  /(jawabannya apa|apa jawabannya|jawaban(nya)? (yang )?(benar|tepat|lain)|kunci jawaban|cari(kan)? jawaban|jawab(kan)? (soal|pertanyaan|tugas)( ini| berikut)?|kerjakan(kan)? (soal|tugas)|selesaikan (soal|tugas)|bahas semua soal|minta jawaban|contek|(buat(kan)?|tuliskan|berikan|kasih(kan)?) (aku |saya |ku )?(jawaban|essay|esai|resume))/i;
// A lesson that is itself a test or a task.
const ASSESSMENT_TITLE = /\b(ujian|assignment|assigment|tugas|quiz|kuis|exam|tryout|try out|ulangan)\b/i;

/** Does the message itself look like a worksheet/exam item? */
export function looksLikeExamItem(message: string): boolean {
  if (STRONG_BLANK.test(message) || OPTION_LINES.test(message)) return true;
  return message.length > 30 && INLINE_ELLIPSIS.test(message);
}

/** Is the learner asking for the answer to something they are meant to work out? (analytics) */
export function isAnswerSeeking(message: string): boolean {
  return ANSWER_SEEKING.test(message) || looksLikeExamItem(message);
}

/**
 * Hint-only mode: the coach may explain concepts and ask guiding questions, but never gives
 * the final answer and never guesses one. Returns why it applies, or null.
 */
export function detectHintOnly(input: {
  message: string;
  lessonLabel?: string | null;
  hasAssignment?: boolean;
}): HintTrigger | null {
  if (ANSWER_SEEKING.test(input.message)) return 'answer_seeking';
  if (looksLikeExamItem(input.message)) return 'exam_shaped';
  if (input.hasAssignment) return 'assignment_lesson';
  if (input.lessonLabel && ASSESSMENT_TITLE.test(input.lessonLabel)) return 'assessment_lesson';
  return null;
}

// -------------------------------------------------------------------------------------------
// Follow-up suggestions: the model appends one last line "[[saran: a | b | c]]"; it is stripped
// from the visible answer and returned separately.
// -------------------------------------------------------------------------------------------

const SUGGESTION_TAIL = /\s*\[\[\s*saran\s*:\s*([\s\S]*?)\s*\]\]\s*$/i;
const SUGGESTION_ANYWHERE = /\s*\[\[\s*saran\s*:[\s\S]*?\]\]/gi;

export function parseSuggestions(text: string): { text: string; suggestions: string[] } {
  const tail = text.match(SUGGESTION_TAIL);
  let suggestions: string[] = [];
  if (tail) {
    suggestions = tail[1]
      .split(/\||\n/)
      .map((s) => s.replace(/^[\s\-*•"'“”]+|[\s"'“”]+$/g, '').trim())
      .filter((s) => s.length >= 3 && s.length <= 60);
    suggestions = [...new Set(suggestions)].slice(0, 3);
  }
  // Never let a marker leak into what the learner reads, even if it is not at the very end.
  const cleaned = text.replace(SUGGESTION_TAIL, '').replace(SUGGESTION_ANYWHERE, '').trimEnd();
  return { text: cleaned, suggestions };
}

/** Used when the model gave none (or no model answered). */
export function defaultSuggestions(opts: { hintMode: boolean }): string[] {
  return opts.hintMode
    ? ['Beri petunjuk pertama', 'Jelaskan konsep yang dibutuhkan', 'Cek jawabanku, aku tulis dulu']
    : ['Kasih contoh', 'Ringkas jadi poin', 'Uji pemahamanku'];
}
