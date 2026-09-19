/**
 * Offline check of the schedule / assignment / quiz-score context (no DB, no network).
 * Uses the same shapes the sync stores; dates follow the LMS's three drip rules.
 */
import { renderLmsContext, releaseDate, todayInSchoolTz, LmsContextInput } from '../src/services/lmsContext.service.js';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' - ' + detail : ''}`);
  if (!ok) failures++;
}
const d = (s: string) => new Date(`${s}T00:00:00Z`);

// --- drip rule maths, one case per mode + the fallbacks the LMS has ---
check('fixed date returns that date', releaseDate('On a fixed date', d('2026-10-01'), null, d('2026-09-15'), null)?.toISOString().slice(0, 10) === '2026-10-01');
check('days after enrollment adds days to enrollment', releaseDate('Days after enrollment', null, 3, d('2026-09-15'), null)?.toISOString().slice(0, 10) === '2026-09-18');
check('days after batch start uses the batch start', releaseDate('Days after batch start', null, 7, d('2026-09-15'), d('2026-09-01'))?.toISOString().slice(0, 10) === '2026-09-08');
check('batch drip falls back to enrollment for a direct enrolment', releaseDate('Days after batch start', null, 7, d('2026-09-15'), null)?.toISOString().slice(0, 10) === '2026-09-22');
check('no drip type -> no release date', releaseDate(null, null, null, d('2026-09-15'), null) === null);
check('enrollment-relative drip without an enrollment date -> unresolved', releaseDate('Days after enrollment', null, 3, null, null) === null);
check('school date is a YYYY-MM-DD string in Asia/Jakarta', /^\d{4}-\d{2}-\d{2}$/.test(todayInSchoolTz()));
check('late evening UTC is already tomorrow in Jakarta', todayInSchoolTz(new Date('2026-09-19T20:00:00Z')) === '2026-09-20');

const input: LmsContextInput = {
  today: '2026-09-19',
  courseLabels: { c1: 'MKI-04 English Profesional', c2: 'MKK-11 Digital' },
  enrollments: [
    { courseId: 'c1', enrolledAt: d('2026-09-15'), batchStartDate: null },
    { courseId: 'c2', enrolledAt: d('2026-08-01'), batchStartDate: d('2026-08-10') },
  ],
  chapters: [
    { chapterId: 'ch1', courseId: 'c1', title: 'Unit 1', dripType: 'Days after enrollment', dripDate: null, dripDays: 0, deadlineDays: 3 }, // opens 09-15, due 09-18 -> passed
    { chapterId: 'ch2', courseId: 'c1', title: 'Unit 2', dripType: 'On a fixed date', dripDate: d('2026-10-01'), dripDays: null, deadlineDays: 7 }, // locked, opens 10-01
    { chapterId: 'ch3', courseId: 'c1', title: 'Unit 3', dripType: 'Days after enrollment', dripDate: null, dripDays: 2, deadlineDays: 10 }, // opens 09-17, due 09-27 -> upcoming
    { chapterId: 'ch4', courseId: 'c2', title: 'Bab A', dripType: null, dripDate: null, dripDays: null, deadlineDays: null },
  ],
  assignments: [
    { assignmentId: 'a1', courseId: 'c1', title: 'Assignment Unit 1', enableScheduling: true, scheduleStart: null, scheduleEnd: d('2026-09-10'), deadlineType: 'Fixed date', deadlineDays: null, dripType: null, dripDate: null, dripDays: null },
    { assignmentId: 'a2', courseId: 'c1', title: 'Assignment Unit 2', enableScheduling: true, scheduleStart: d('2026-09-25'), scheduleEnd: d('2026-09-30'), deadlineType: 'Fixed date', deadlineDays: null, dripType: null, dripDate: null, dripDays: null },
    { assignmentId: 'a3', courseId: 'c2', title: 'Tugas Akhir', enableScheduling: false, scheduleStart: null, scheduleEnd: null, deadlineType: null, deadlineDays: null, dripType: null, dripDate: null, dripDays: null },
  ],
  submissions: [{ assignmentId: 'a3', status: 'Pass' }],
  quizAttempts: [
    { quizId: 'q1', quizTitle: 'Ujian Unit 1', courseId: 'c1', score: 6, scoreOutOf: 10, percentage: 60, passingPercentage: 70, submittedAt: new Date('2026-09-16T08:00:00Z') },
    { quizId: 'q1', quizTitle: 'Ujian Unit 1', courseId: 'c1', score: 8, scoreOutOf: 10, percentage: 80, passingPercentage: 70, submittedAt: new Date('2026-09-17T08:00:00Z') },
    { quizId: 'q2', quizTitle: 'Kuis PMS', courseId: 'c2', score: 3, scoreOutOf: 10, percentage: null, passingPercentage: 70, submittedAt: new Date('2026-09-18T08:00:00Z') },
  ],
};

const out = renderLmsContext(input);
console.log('\n' + out + '\n');

check('today line', out.includes('Tanggal hari ini: 2026-09-19'));
check('locked chapter shows its open date', out.includes('Unit 2 (dibuka 2026-10-01)'));
check('passed chapter deadline reported', out.includes('deadline bab sudah lewat: Unit 1 (2026-09-18)'));
check('upcoming chapter deadline reported', out.includes('deadline bab berikutnya: Unit 3 (2026-09-27)'));
check('unsubmitted, overdue assignment flagged', out.includes('Assignment Unit 1 [MKI-04 English Profesional]: BELUM dikumpulkan, deadline lewat 2026-09-10'));
check('assignment that has not opened yet says when', out.includes('baru dibuka 2026-09-25'));
check('submitted assignment shows its outcome', out.includes('Tugas Akhir [MKK-11 Digital]: sudah dikumpulkan, lulus'));
check('count of submitted assignments', out.includes('1 dari 3 sudah dikumpulkan'));
const asg = out.split('\n').filter((l) => l.startsWith('- ') && l.includes('Assignment') || l.startsWith('- Tugas'));
check('overdue unsubmitted listed before submitted', asg[0].includes('Assignment Unit 1') && asg[asg.length - 1].includes('Tugas Akhir'));
check('quiz: latest and best with attempts and verdict', out.includes('Ujian Unit 1 [MKI-04 English Profesional]: terakhir 80% (8/10), terbaik 80%, 2x percobaan, lulus (batas 70%)'));
check('quiz without stored percentage derives it from score/out-of', out.includes('Kuis PMS [MKK-11 Digital]: terakhir 30% (3/10), 1x percobaan, belum lulus (batas 70%)'));
check('quiz summary count and average of best scores', out.includes('Skor quiz (2 quiz, rata-rata nilai terbaik 55%)'));
check('most recently attempted quiz first', out.indexOf('Kuis PMS') < out.indexOf('Ujian Unit 1 ['));

const manyCourses: LmsContextInput = {
  ...input,
  enrollments: Array.from({ length: 12 }, (_, i) => ({ courseId: `k${i}`, enrolledAt: d('2026-09-15'), batchStartDate: null })),
  courseLabels: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, `Course panjang nomor ${i} dengan nama cukup panjang`])),
  chapters: Array.from({ length: 12 }, (_, i) => Array.from({ length: 4 }, (_, j) => ({
    chapterId: `k${i}c${j}`, courseId: `k${i}`, title: `Bab ${j} yang judulnya lumayan panjang sekali`, dripType: 'On a fixed date',
    dripDate: d(`2026-10-${String(10 + j).padStart(2, '0')}`), dripDays: null, deadlineDays: 7,
  }))).flat(),
};
const crowded = renderLmsContext(manyCourses);
check('12 courses of drip do not crowd out assignments and quiz scores', crowded.includes('Tugas (assignment):') && crowded.includes('Skor quiz (') && crowded.includes('Ujian Unit 1'));
check('crowded output still within the cap', crowded.length <= 4000, String(crowded.length));

// --- the open course wins ambiguous references ("unit 2 kapan dibuka" while in MKK-11) ---
const focused = renderLmsContext({ ...input, focusCourseId: 'c2' });
check('focus: header names the open course and the default rule', focused.includes('Course yang sedang dibuka siswa: MKK-11 Digital') && focused.includes('yang dimaksud course ini'));
check('focus: the open course schedule line is marked', renderLmsContext({ ...input, focusCourseId: 'c1' }).includes('- MKI-04 English Profesional (course yang sedang dibuka): bab belum dibuka'));
const unfocused = renderLmsContext(input);
check('no focus: no header and nothing marked', !unfocused.includes('Course yang sedang dibuka siswa') && !unfocused.includes('(course yang sedang dibuka)'));
const focusedC1 = renderLmsContext({ ...input, focusCourseId: 'c1' });
check('focus c1: c1 schedule listed before c2', focusedC1.indexOf('MKI-04 English Profesional (course yang sedang dibuka)') < focusedC1.indexOf('- MKK-11 Digital') || !focusedC1.includes('- MKK-11 Digital'));
check('focus: unsubmitted assignments of the open course precede other courses', (() => {
  const two = renderLmsContext({
    ...input,
    focusCourseId: 'c2',
    assignments: [
      ...input.assignments.slice(0, 2),
      { ...input.assignments[2], assignmentId: 'a4', title: 'Tugas Baru MKK-11', courseId: 'c2' },
    ],
    submissions: [],
  });
  return two.indexOf('Tugas Baru MKK-11') < two.indexOf('Assignment Unit 1');
})());
check('focus: the open course quiz is listed first', (() => {
  const q = renderLmsContext({ ...input, focusCourseId: 'c1' });
  return q.indexOf('Ujian Unit 1') < q.indexOf('Kuis PMS');
})());

check('no enrollments/assignments/attempts -> empty string', renderLmsContext({ ...input, enrollments: [], assignments: [], quizAttempts: [] }) === '');
check('output is capped', renderLmsContext({ ...input, assignments: Array.from({ length: 60 }, (_, i) => ({ ...input.assignments[0], assignmentId: `x${i}`, title: 'T'.repeat(200) })) }).length <= 4000);

console.log(failures === 0 ? '\nAll LMS-context checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
