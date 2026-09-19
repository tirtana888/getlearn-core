/** Offline check of the chat-record CSV export (no DB, no network). */
import { toCsv, ChatRecord } from '../src/services/chatRecords.service.js';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' - ' + detail : ''}`);
  if (!ok) failures++;
}

const base: ChatRecord = {
  message_id: 'm1', session_id: 's1', learner_id: 'frappe_abc', lesson_id: 'L1', lesson: 'Ekosistem Pariwisata',
  asked_at: '2026-09-19T05:00:00.000Z', answered_at: '2026-09-19T05:00:03.000Z',
  question: 'Apa itu ekosistem?', answer: 'Jaringan yang saling bergantung.', outcome: 'answered', provider: 'deepseek',
  latency_ms: 3120, tokens_used: 950, retrieval_count: 4, top_similarity: 0.823, source_lessons: ['Ekosistem Pariwisata'],
  guardrail: null, feedback: null,
};

const csv = toCsv([
  base,
  { ...base, message_id: 'm2', question: 'Halo, "apa kabar"?\nBaris kedua', answer: 'Baik, terima kasih', top_similarity: null, provider: null, source_lessons: ['A', 'B'] },
  { ...base, message_id: 'm3', question: '=HYPERLINK("http://evil","klik")', answer: '+cmd|calc', lesson: null, feedback: -1 },
  { ...base, message_id: 'm4', question: '@SUM(A1)', answer: '-1+1' },
]);
const lines = csv.split('\r\n');

check('header is the documented column order', lines[0] === 'answered_at,asked_at,session_id,learner_id,lesson_id,lesson,question,answer,outcome,provider,latency_ms,tokens_used,retrieval_count,top_similarity,source_lessons,guardrail,feedback');
check('plain row has no needless quoting', lines[1].startsWith('2026-09-19T05:00:03.000Z,2026-09-19T05:00:00.000Z,s1,frappe_abc,L1,Ekosistem Pariwisata,Apa itu ekosistem?,'));
check('commas, quotes and newlines are quoted and escaped', csv.includes('"Halo, ""apa kabar""?\nBaris kedua"'));
check('null becomes an empty cell', /,,/.test(lines[2]) || lines[2].includes(',,'));
check('list values are joined with a separator', csv.includes('A | B'));
check('a leading = is neutralised so it cannot run as a formula', csv.includes("'=HYPERLINK") && !/(^|,)=HYPERLINK/.test(csv));
check('a leading + is neutralised', csv.includes("'+cmd|calc"));
check('a leading @ is neutralised', csv.includes("'@SUM(A1)"));
check('a leading - is neutralised', csv.includes("'-1+1"));
check('numbers and negative feedback are kept', csv.includes(',3120,950,4,0.823,') && csv.includes(',-1'));
check('ends with a line break and has one row per record + header', csv.endsWith('\r\n') && csv.split('\r\n').filter((l) => l.length).length >= 5);
check('no records -> header only', toCsv([]).trim().split('\r\n').length === 1);

console.log(failures === 0 ? '\nAll chat-record export checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
