/** Offline check of the hint-only guardrail and the follow-up suggestion parser. */
import { detectHintOnly, isAnswerSeeking, looksLikeExamItem, parseSuggestions, defaultSuggestions, CAPABILITY_STATEMENT } from '../src/services/chatGuard.js';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' - ' + detail : ''}`);
  if (!ok) failures++;
}

// --- the real exchange that went wrong (Melda, lesson "The Function of Banquet") ---
const meldaItem =
  'Ketika menghadapi perubahan mendadak sebelum acara dimulai, langkah pertama yang harus diambil staf banquet adalah memastikan \nKetikkan jawaban Anda\n tidak terganggu.';
check("Melda's pasted worksheet item -> hint-only (exam_shaped)", detectHintOnly({ message: meldaItem, lessonLabel: 'The Function of Banquet' }) === 'exam_shaped');
check('"jadi jawabannya apa" -> answer_seeking', detectHintOnly({ message: 'jadi jawabannya apa', lessonLabel: 'The Function of Banquet' }) === 'answer_seeking');
check('"jawaban lain" -> answer_seeking', detectHintOnly({ message: 'jawaban lain', lessonLabel: null }) === 'answer_seeking');
check('"jawabannya salah, cari jawaban lainnya" -> answer_seeking', detectHintOnly({ message: 'jawabannya salah, cari jawaban lainnya', lessonLabel: null }) === 'answer_seeking');
check('"bahas semua soal" -> answer_seeking', detectHintOnly({ message: 'bahas semua soal', lessonLabel: 'Assignment Unit 1' }) === 'answer_seeking');
check('"buatkan jawaban lengkap Assignment Unit 2" -> answer_seeking', detectHintOnly({ message: 'buatkan jawaban lengkap Assignment Unit 2 dong', lessonLabel: 'Peran Regulasi' }) === 'answer_seeking');
check('"tuliskan essay untukku" -> answer_seeking', detectHintOnly({ message: 'tuliskan essay untukku', lessonLabel: null }) === 'answer_seeking');
check('"kasih contoh jawaban yang baik" is a legitimate ask for an example, not caught', detectHintOnly({ message: 'kasih contoh kalimat yang baik', lessonLabel: 'Ekosistem' }) === null);

// --- other worksheet shapes ---
check('multiple-choice options -> exam_shaped', detectHintOnly({ message: 'Ibukota Prancis?\na. Paris\nb. Roma\nc. Berlin', lessonLabel: null }) === 'exam_shaped');
check('parenthesised options (a) (b) -> exam_shaped', looksLikeExamItem('Pilih:\n(a) satu\n(b) dua'));
check('dotted blank inside a sentence -> exam_shaped', looksLikeExamItem('Tugas utama front office adalah ... tamu saat tiba di hotel.'));
check('titik-titik -> exam_shaped', looksLikeExamItem('Lengkapi kalimat berikut dengan titik-titik yang sesuai'));

// --- lesson-based triggers ---
check('lesson holding an assignment -> assignment_lesson', detectHintOnly({ message: 'aku bingung mulai dari mana', lessonLabel: 'Peran Regulasi', hasAssignment: true }) === 'assignment_lesson');
check('lesson titled Ujian -> assessment_lesson', detectHintOnly({ message: 'apa itu ekosistem', lessonLabel: 'Ujian Unit 1 - MKI-04' }) === 'assessment_lesson');
check('lesson titled Assignment -> assessment_lesson', detectHintOnly({ message: 'halo', lessonLabel: '0168 Assigment Unit 1' }) === 'assessment_lesson');

// --- must NOT trigger: ordinary learning talk and casual typing ---
const normal = [
  'jelaskan inti lesson ini', 'apa itu ekosistem pariwisata?', 'kasih contoh dong', 'progres aku gimana?', 'tugas apa yang belum aku kumpulkan?',
  'kapan bab Unit 2 dibuka?', 'hmm... oke deh', 'gimana...', 'makasih ya', 'Bagaimana prosedur check-in tamu?', 'rangkum materi ini',
];
for (const m of normal) check(`normal message stays in normal mode: "${m}"`, detectHintOnly({ message: m, lessonLabel: 'Ekosistem dan Sektor Utama Industri Pariwisata' }) === null);

// --- analytics flag ---
check('isAnswerSeeking flags the worksheet item', isAnswerSeeking(meldaItem));
check('isAnswerSeeking ignores a normal question', !isAnswerSeeking('apa itu ekosistem pariwisata?'));

// --- suggestion parsing ---
let p = parseSuggestions('Ekosistem itu jaringan yang saling bergantung.\n\n[[saran: Kasih contoh | Ringkas jadi poin | Kapan bab berikutnya dibuka?]]');
check('marker is stripped from the answer', p.text === 'Ekosistem itu jaringan yang saling bergantung.', JSON.stringify(p.text));
check('three suggestions extracted in order', JSON.stringify(p.suggestions) === JSON.stringify(['Kasih contoh', 'Ringkas jadi poin', 'Kapan bab berikutnya dibuka?']));
p = parseSuggestions('Jawaban.\n[[Saran: "Satu" | - Dua | * Tiga | Empat]]');
check('quotes and bullets trimmed, capped at 3', JSON.stringify(p.suggestions) === JSON.stringify(['Satu', 'Dua', 'Tiga']), JSON.stringify(p.suggestions));
p = parseSuggestions('Jawaban tanpa saran.');
check('no marker -> text unchanged, no suggestions', p.text === 'Jawaban tanpa saran.' && p.suggestions.length === 0);
p = parseSuggestions('Awal [[saran: A1 | B2]] tengah jawaban.\nLanjut.');
check('a marker in the middle never leaks into the text', !/saran/i.test(p.text) && p.text.includes('tengah jawaban'), JSON.stringify(p.text));
p = parseSuggestions('Jawaban.\n[[saran: ok | ' + 'x'.repeat(80) + ' | Contoh bagus]]');
check('too short / too long suggestions are dropped', JSON.stringify(p.suggestions) === JSON.stringify(['Contoh bagus']), JSON.stringify(p.suggestions));
p = parseSuggestions('Jawaban.\n[[saran: Sama | Sama | Beda]]');
check('duplicates removed', JSON.stringify(p.suggestions) === JSON.stringify(['Sama', 'Beda']));
check('defaults differ for hint mode', defaultSuggestions({ hintMode: true })[0] !== defaultSuggestions({ hintMode: false })[0] && defaultSuggestions({ hintMode: false }).length === 3);

// --- the fixed capability statement must stay accurate ---
const cap = CAPABILITY_STATEMENT;
for (const seen of ['progres', 'skor quiz', 'batas lulus', 'status tugas', 'jadwal bab', 'isi materi lesson', 'instruksi tugas', 'pesan terakhir']) {
  check(`capability statement says the coach can see: ${seen}`, cap.toLowerCase().includes(seen));
}
for (const blind of ['isi jawaban tugas', 'komentar penilai', 'absensi', 'nilai rapor', 'data siswa lain', 'nama dan email', 'label batch']) {
  check(`capability statement says the coach cannot see: ${blind}`, cap.toLowerCase().includes(blind));
}
check('capability statement admits data lag (minutes for progress, about an hour for material)', cap.includes('beberapa menit') && cap.includes('satu jam'));
check('capability statement does not claim "bukan data pribadi" as a fact', cap.includes('Jangan bilang datanya "bukan data pribadi"') && !/(^|[^"])bukan data pribadi(?!")/.test(cap.replace('Jangan bilang datanya "bukan data pribadi"', '')));
check('assignment deadlines are described as conditional on a schedule', cap.includes('hanya kalau tugas itu diberi jadwal'));

console.log(failures === 0 ? '\nAll chat-guard checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
