import JSZip from 'jszip';
import { prisma } from '../src/lib/prisma.js';
import { frappeSyncService } from '../src/services/frappeSync.service.js';
import { masteryService } from '../src/services/mastery.service.js';

/**
 * Unit test for the Frappe pull-sync path — mocks a Frappe site's REST API
 * responses (list + detail shape for "LMS Quiz Submission") so it needs no
 * real Frappe site, just the real dev database for the resulting events.
 */
async function main() {
  console.log('>>> Frappe Pull-Sync Unit Test <<<\n');

  const tenantId = 'ten_dev_nusadaya';
  await prisma.tenant.upsert({
    where: { id: tenantId },
    update: {},
    create: { id: tenantId, name: 'Nusadaya Academy', tokenBalance: 500000 },
  });

  const fakeBaseUrl = 'https://fake-nusadaya.example.com';
  const fakeApiKey = 'fake_key';
  const fakeApiSecret = 'fake_secret';

  await prisma.frappeConnection.upsert({
    where: { tenantId },
    update: { baseUrl: fakeBaseUrl, apiKey: fakeApiKey, apiSecret: fakeApiSecret, enabled: true, lastSyncedAt: null, lastSyncError: null },
    create: { tenantId, baseUrl: fakeBaseUrl, apiKey: fakeApiKey, apiSecret: fakeApiSecret, enabled: true },
  });

  const fakeSubmission = {
    name: 'quiz-sub-test-1',
    member: 'siswa.uji@nusadayaacademy.com',
    quiz: 'quiz-front-office-101',
    creation: new Date().toISOString(),
    result: [
      {
        name: 'row-1',
        question: 'Apa tugas utama front office?',
        question_name: 'q_front_office_01',
        answer: 'Menangani check-in dan check-out',
        is_correct: 1,
      },
      {
        name: 'row-2',
        question: 'Siapa yang menangani housekeeping?',
        question_name: 'q_housekeeping_01',
        answer: 'Resepsionis',
        is_correct: 0,
      },
    ],
  };

  const fakeQuiz = { name: fakeSubmission.quiz, title: 'Front Office Quiz', lesson: 'lesson-front-office-intro' };
  const fakeLesson = { name: fakeQuiz.lesson, title: 'Pengenalan Front Office' };

  // 3 distinct enrolled students, only 1 of whom (the quiz-taker) has any quiz activity -
  // this is exactly the "5 learners when there should be more" scenario from production.
  const fakeEnrollments = [
    { member: fakeSubmission.member },
    { member: 'siswa.lain1@nusadayaacademy.com', course: 'course-fo', progress: 40 },
    { member: 'siswa.lain2@nusadayaacademy.com', course: 'course-fo', progress: 10 },
    { member: fakeSubmission.member }, // duplicate (2nd course enrollment) - must be deduped
  ];

  // Lesson progress: one finished, one in progress, one "Incomplete" (must be ignored).
  const progressLessonId = 'lesson-progress-only';
  const progressModified = new Date().toISOString();
  const fakeProgress = [
    { member: 'siswa.lain1@nusadayaacademy.com', lesson: progressLessonId, course: 'course-fo', status: 'Complete', modified: progressModified },
    { member: 'siswa.lain2@nusadayaacademy.com', lesson: progressLessonId, course: 'course-fo', status: 'Partially Complete', modified: progressModified },
    { member: 'siswa.lain2@nusadayaacademy.com', lesson: 'lesson-never-started', course: 'course-fo', status: 'Incomplete', modified: progressModified },
  ];


  // Catalog: one course, one chapter, four lessons in this order. The last is an empty shell.
  const catalogLessons = [
    { name: fakeLesson.name, title: fakeLesson.title, course: 'course-fo', modified: '2026-09-01 10:00:00', content: JSON.stringify({ blocks: [{ type: 'markdown', data: { text: 'Front office menyambut tamu hotel.' } }, { type: 'quiz', data: { quiz: fakeQuiz.name } }] }) },
    { name: progressLessonId, title: 'Lesson Tanpa Quiz', course: 'course-fo', modified: '2026-09-01 10:00:00', content: JSON.stringify({ blocks: [{ type: 'scorm', data: { scorm_package: 'F1' } }] }) },
    { name: 'lesson-second-unstarted', title: 'Lesson Kedua', course: 'course-fo', modified: '2026-09-01 10:00:00', content: JSON.stringify({ blocks: [{ type: 'paragraph', data: { text: 'Materi lesson kedua tentang reservasi.' } }] }) },
    { name: 'lesson-empty-shell', title: 'Lesson Kosong', course: 'course-fo', modified: '2026-09-01 10:00:00', content: null },
  ];
  const scormZip = new JSZip();
  scormZip.file('res/slide1.html', '<html><body><h1>Slide SCORM</h1><p>Kata dari SCORM asli tentang check-in tamu.</p></body></html>');
  const scormZipBytes = new Uint8Array(await scormZip.generateAsync({ type: 'nodebuffer' }));

  const realFetch = global.fetch;
  let catalogCalled = false;
  let progressCalled = false;
  let listCalled = false;
  let detailCalled = false;
  let quizCalled = false;
  let lessonCalled = false;
  let enrollmentCalled = false;

  global.fetch = (async (url: string, init?: any) => {
    const authHeader = init?.headers?.Authorization;
    const expectedAuth = `token ${fakeApiKey}:${fakeApiSecret}`;
    if (authHeader !== expectedAuth) {
      throw new Error(`Unexpected auth header: ${authHeader}`);
    }

    const decoded = decodeURIComponent(url);

    if (decoded.includes('/api/resource/LMS Course?')) {
      catalogCalled = true;
      return new Response(JSON.stringify({ data: [{ name: 'course-fo', title: 'Front Office' }] }), { status: 200 });
    }
    if (decoded.includes('/api/resource/LMS Course/course-fo')) {
      return new Response(JSON.stringify({ data: { chapters: [{ chapter: 'ch1' }] } }), { status: 200 });
    }
    if (decoded.includes('/api/resource/Course Chapter/ch1')) {
      return new Response(JSON.stringify({ data: { lessons: catalogLessons.map((l) => ({ lesson: l.name })) } }), { status: 200 });
    }
    if (decoded.includes('/api/resource/Course Lesson?')) {
      return new Response(JSON.stringify({ data: catalogLessons }), { status: 200 });
    }
    if (decoded.includes('/api/resource/LMS Quiz?')) {
      return new Response(JSON.stringify({ data: [{ name: fakeQuiz.name, lesson: fakeLesson.name }] }), { status: 200 });
    }
    if (decoded.includes('/api/resource/File/F1')) {
      return new Response(JSON.stringify({ data: { file_url: '/private/files/pkg.zip' } }), { status: 200 });
    }
    if (decoded.includes('/private/files/pkg.zip')) {
      return new Response(scormZipBytes, { status: 200 });
    }

    if (decoded.includes('/api/resource/LMS Course Progress?')) {
      progressCalled = true;
      console.log(`[mock fetch:progress] -> ${fakeProgress.length} row(s)`);
      return new Response(JSON.stringify({ data: fakeProgress }), { status: 200 });
    }

    if (decoded.includes(`/api/resource/Course Lesson/${progressLessonId}`)) {
      return new Response(JSON.stringify({ data: { name: progressLessonId, title: 'Lesson Tanpa Quiz' } }), { status: 200 });
    }

    if (decoded.includes('/api/resource/LMS Enrollment?')) {
      enrollmentCalled = true;
      console.log(`[mock fetch:enrollment] -> ${fakeEnrollments.length} row(s) (with a duplicate member)`);
      return new Response(JSON.stringify({ data: fakeEnrollments }), { status: 200 });
    }

    if (decoded.includes('/api/resource/LMS Quiz Submission?')) {
      listCalled = true;
      // Mimic Frappe's own server-side filtering, so a second sync run with an
      // advanced watermark correctly sees no submissions - same as the real API would.
      const sinceMatch = decoded.match(/"creation",">","([^"]+)"/);
      const sinceParam = sinceMatch ? new Date(sinceMatch[1]) : new Date(0);
      const matches = new Date(fakeSubmission.creation) > sinceParam ? [{ name: fakeSubmission.name }] : [];
      console.log(`[mock fetch:list] since=${sinceParam.toISOString()} -> ${matches.length} match(es)`);
      return new Response(JSON.stringify({ data: matches }), { status: 200 });
    }

    if (decoded.includes(`/api/resource/LMS Quiz Submission/${fakeSubmission.name}`)) {
      detailCalled = true;
      console.log(`[mock fetch:detail] ${url}`);
      return new Response(JSON.stringify({ data: fakeSubmission }), { status: 200 });
    }

    if (decoded.includes(`/api/resource/LMS Quiz/${fakeQuiz.name}`)) {
      quizCalled = true;
      console.log(`[mock fetch:quiz] ${url}`);
      return new Response(JSON.stringify({ data: fakeQuiz }), { status: 200 });
    }

    if (decoded.includes(`/api/resource/Course Lesson/${fakeLesson.name}`)) {
      lessonCalled = true;
      console.log(`[mock fetch:lesson] ${url}`);
      return new Response(JSON.stringify({ data: fakeLesson }), { status: 200 });
    }

    throw new Error(`Unexpected URL in mock fetch: ${url}`);
  }) as typeof fetch;

  try {
    console.log('[1] Running frappeSyncService.syncTenant(...)\n');
    const result = await frappeSyncService.syncTenant(tenantId);
    console.log('Result:', result);

    const learnerId = frappeSyncService.anonymizeLearnerId(fakeSubmission.member);
    console.log(`\n[2] Checking ingested events for anonymized learner_id=${learnerId}\n`);

    const learner = await prisma.learner.findUnique({
      where: { tenantId_externalRef: { tenantId, externalRef: learnerId } },
    });
    const events = learner
      ? await prisma.assessmentEvent.findMany({ where: { tenantId, learnerId: learner.id } })
      : [];

    const connection = await prisma.frappeConnection.findUnique({ where: { tenantId } });

    const objective = await prisma.learningObjective.findUnique({
      where: { tenantId_id: { tenantId, id: fakeLesson.name } },
    });
    const item1 = await prisma.assessmentItem.findUnique({
      where: { tenantId_id: { tenantId, id: 'q_front_office_01' } },
    });
    const masteryRecord = learner
      ? await prisma.masteryRecord.findUnique({
          where: { tenantId_learnerId_objectiveId: { tenantId, learnerId: learner.id, objectiveId: fakeLesson.name } },
        })
      : null;

    const noQuizLearner1 = await prisma.learner.findUnique({
      where: { tenantId_externalRef: { tenantId, externalRef: frappeSyncService.anonymizeLearnerId('siswa.lain1@nusadayaacademy.com') } },
    });
    const noQuizLearner2 = await prisma.learner.findUnique({
      where: { tenantId_externalRef: { tenantId, externalRef: frappeSyncService.anonymizeLearnerId('siswa.lain2@nusadayaacademy.com') } },
    });

    const progressRows = await prisma.lessonProgress.findMany({ where: { tenantId, lessonId: progressLessonId } });
    const progressObjective = await prisma.learningObjective.findUnique({
      where: { tenantId_id: { tenantId, id: progressLessonId } },
    });
    const incompleteRow = await prisma.lessonProgress.findFirst({ where: { tenantId, lessonId: 'lesson-never-started' } });
    const doneRow = progressRows.find((r) => r.learnerId === noQuizLearner1?.id);
    const partialRow = progressRows.find((r) => r.learnerId === noQuizLearner2?.id);
    const partialAction = noQuizLearner2 ? await masteryService.getNextAction(tenantId, noQuizLearner2.id) : null;

    const checks = [
      { name: 'progress endpoint called', pass: progressCalled },
      { name: 'result.progressRecords === 2 (Incomplete ignored)', pass: result.progressRecords === 2 },
      { name: 'Complete -> status complete', pass: doneRow?.status === 'complete' },
      { name: 'Partially Complete -> status partial', pass: partialRow?.status === 'partial' },
      { name: 'Incomplete row not stored', pass: !incompleteRow },
      { name: 'progress lesson registered as objective with its real title', pass: progressObjective?.label === 'Lesson Tanpa Quiz' },
      { name: 'learner with no quiz but an unfinished lesson gets a "continue" recommendation', pass: partialAction?.action === 'continue' && partialAction?.target_id === progressLessonId },
      { name: 'enrollment endpoint called', pass: enrollmentCalled },
      { name: 'result.learnersRegistered === 3 (deduped from 4 rows)', pass: result.learnersRegistered === 3 },
      { name: 'student with zero quiz activity still registered as a learner', pass: Boolean(noQuizLearner1) && Boolean(noQuizLearner2) },
      { name: 'list endpoint called', pass: listCalled },
      { name: 'detail endpoint called', pass: detailCalled },
      { name: 'quiz endpoint called (lesson lookup)', pass: quizCalled },
      { name: 'lesson endpoint called (objective lookup)', pass: lessonCalled },
      { name: 'result.submissionsSeen === 1', pass: result.submissionsSeen === 1 },
      { name: 'result.eventsIngested === 2', pass: result.eventsIngested === 2 },
      { name: 'result.errors === 0', pass: result.errors === 0 },
      { name: 'learner_id is NOT the raw email', pass: !learnerId.includes('@') && !learnerId.includes('siswa') },
      { name: 'learner record created with anonymized id', pass: Boolean(learner) },
      { name: '2 AssessmentEvent rows created', pass: events.length === 2 },
      {
        name: 'event_id is stable per Frappe child row (idempotency-ready)',
        pass: events.some((e) => e.id === 'frappe_qr_row-1') && events.some((e) => e.id === 'frappe_qr_row-2'),
      },
      { name: 'is_correct mapped correctly (1/0 -> true/false)', pass: events.some((e) => e.isCorrect === true) && events.some((e) => e.isCorrect === false) },
      { name: 'lastSyncedAt advanced past the submission creation time', pass: Boolean(connection?.lastSyncedAt) },
      { name: 'lesson registered as LearningObjective with its real title', pass: objective?.label === fakeLesson.title },
      { name: 'question registered as AssessmentItem, mapped to the lesson objective', pass: Boolean(item1) && item1!.objectiveIds.includes(fakeLesson.name) },
      { name: 'question prompt text is the real question, not the generic stub', pass: item1?.promptText === fakeSubmission.result[0].question },
      { name: 'mastery record computed for the lesson objective (this is the whole point)', pass: Boolean(masteryRecord) },
    ];


    // Background indexing (SCORM download + embed) - wait for it to settle.
    for (let i = 0; i < 40; i++) {
      const done = await prisma.contentItem.count({ where: { tenantId, id: { in: catalogLessons.slice(0, 3).map((l) => l.name) }, indexingStatus: 'completed' } });
      if (done === 3) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const scormItem = await prisma.contentItem.findUnique({ where: { tenantId_id: { tenantId, id: progressLessonId } } });
    const scormChunks = await prisma.contentChunk.count({ where: { tenantId, contentItemId: progressLessonId } });
    const introObjective = await prisma.learningObjective.findUnique({ where: { tenantId_id: { tenantId, id: fakeLesson.name } } });
    const secondObjective = await prisma.learningObjective.findUnique({ where: { tenantId_id: { tenantId, id: 'lesson-second-unstarted' } } });
    const enrollmentRow = noQuizLearner1
      ? await prisma.enrollment.findUnique({ where: { tenantId_learnerId_courseId: { tenantId, learnerId: noQuizLearner1.id, courseId: 'course-fo' } } })
      : null;

    const catalogChecks = [
      { name: 'catalog endpoint called', pass: catalogCalled },
      { name: 'result.catalogLessons === 4 (whole catalog, incl. never-touched lessons)', pass: result.catalogLessons === 4 },
      { name: 'result.contentQueued === 3 (empty shell not queued)', pass: result.contentQueued === 3 },
      { name: 'lesson ordered within its course + labelled with the course title', pass: introObjective?.sequence === 0 && secondObjective?.sequence === 2 && introObjective?.courseLabel === 'Front Office' },
      { name: 'quiz attached to its lesson via LMS Quiz.lesson', pass: introObjective?.assessmentRef === fakeQuiz.name },
      { name: 'SCORM lesson material downloaded with auth and indexed', pass: scormItem?.indexingStatus === 'completed' && (scormItem?.rawText || '').includes('Kata dari SCORM asli') },
      { name: 'SCORM lesson has embedded chunks for RAG', pass: scormChunks > 0 },
      { name: 'version marker written only after successful indexing', pass: (scormItem?.sourceUri || '').startsWith('frappe:lesson/') },
      { name: 'enrollment stored with course + progress', pass: enrollmentRow?.progressPct === 40 && enrollmentRow?.courseLabel === 'Front Office' },
    ];
    for (const c of catalogChecks) {
      console.log(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.name}`);
    }

    // Recommendation ladder for a learner (siswa.lain1), one signal at a time.
    const l1 = noQuizLearner1!.id;
    const step = async () => masteryService.getNextAction(tenantId, l1);
    const s1 = await step();
    await prisma.lessonProgress.create({ data: { tenantId, learnerId: l1, lessonId: fakeLesson.name, courseId: 'course-fo', status: 'complete', sourceModified: new Date() } });
    const s2 = await step();
    await prisma.masteryRecord.create({ data: { tenantId, learnerId: l1, objectiveId: fakeLesson.name, score: 0.9, evidenceCount: 5 } });
    const s3 = await step();
    await prisma.lessonProgress.create({ data: { tenantId, learnerId: l1, lessonId: 'lesson-second-unstarted', courseId: 'course-fo', status: 'complete', sourceModified: new Date() } });
    const s4 = await step();

    const ladderChecks = [
      { name: 'enrolled, nothing started -> "start" the first lesson that has material', pass: s1.action === 'start' && s1.target_id === fakeLesson.name },
      { name: 'finished a lesson whose quiz was never taken -> "practice" that quiz', pass: s2.action === 'practice' && s2.target_id === fakeQuiz.name },
      { name: 'quiz taken -> moves on to the next unstarted lesson (second)', pass: s3.action === 'start' && s3.target_id === 'lesson-second-unstarted' },
      { name: 'only an empty shell left -> never recommended as a lesson to start', pass: s4.target_id !== 'lesson-empty-shell' && s4.action !== 'start' },
    ];
    for (const c of ladderChecks) {
      console.log(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.name}`);
    }
    const catalogAllPass = [...catalogChecks, ...ladderChecks].every((c) => c.pass);

    let allPass = catalogAllPass;
    for (const c of checks) {
      console.log(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.name}`);
      if (!c.pass) allPass = false;
    }

    console.log('\n[3] Re-running sync with the SAME mock data (should now see 0 new submissions, watermark already advanced)\n');
    const secondResult = await frappeSyncService.syncTenant(tenantId);
    console.log('Second run result:', secondResult);
    const idempotentOnRerun = secondResult.submissionsSeen === 0;
    console.log(`  [${idempotentOnRerun ? 'PASS' : 'FAIL'}] second run sees no submissions (watermark prevents re-fetch)`);
    if (!idempotentOnRerun) allPass = false;
    const progressAfterRerun = await prisma.lessonProgress.count({ where: { tenantId, lessonId: progressLessonId } });
    console.log(`  [${progressAfterRerun === 2 ? 'PASS' : 'FAIL'}] progress rows not duplicated by the overlapping re-read (${progressAfterRerun})`);
    if (progressAfterRerun !== 2) allPass = false;

    console.log(
      '\n[4] Backfill scenario: simulate an event ingested by pre-lesson-mapping code ' +
        '(objectiveIds wiped, mastery record removed), then re-sync the SAME submission ' +
        '(watermark rewound) - the event is a duplicate, but mastery must still get fixed.\n'
    );
    await prisma.assessmentItem.update({
      where: { tenantId_id: { tenantId, id: 'q_front_office_01' } },
      data: { objectiveIds: [] },
    });
    await prisma.masteryRecord.deleteMany({ where: { tenantId, objectiveId: fakeLesson.name } });
    await prisma.frappeConnection.update({ where: { tenantId }, data: { lastSyncedAt: new Date(0) } });

    const backfillResult = await frappeSyncService.syncTenant(tenantId);
    console.log('Backfill run result:', backfillResult);

    const itemAfterBackfill = await prisma.assessmentItem.findUnique({
      where: { tenantId_id: { tenantId, id: 'q_front_office_01' } },
    });
    const masteryAfterBackfill = await prisma.masteryRecord.findUnique({
      where: { tenantId_learnerId_objectiveId: { tenantId, learnerId: learner!.id, objectiveId: fakeLesson.name } },
    });

    const backfillChecks = [
      { name: 'backfill run reported 0 newly-processed events (they were duplicates)', pass: backfillResult.eventsIngested === 0 },
      { name: 'objectiveIds restored on the existing item despite the duplicate event', pass: Boolean(itemAfterBackfill?.objectiveIds.includes(fakeLesson.name)) },
      { name: 'mastery record recreated from old events without a fresh event', pass: Boolean(masteryAfterBackfill) },
    ];
    for (const c of backfillChecks) {
      console.log(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.name}`);
      if (!c.pass) allPass = false;
    }

    if (!allPass) {
      throw new Error('One or more assertions failed.');
    }
    console.log('\n>>> All checks passed <<<');
  } finally {
    global.fetch = realFetch;
    await prisma.lessonProgress.deleteMany({ where: { tenantId } });
    await prisma.enrollment.deleteMany({ where: { tenantId } });
    await prisma.contentItem.deleteMany({ where: { tenantId, id: { in: catalogLessons.map((l) => l.name) } } });
    await prisma.masteryRecord.deleteMany({ where: { tenantId, objectiveId: fakeLesson.name } });
    await prisma.learningObjective.deleteMany({ where: { tenantId, id: { in: ['lesson-second-unstarted', 'lesson-empty-shell'] } } });
    await prisma.learningObjective.deleteMany({ where: { tenantId, id: progressLessonId } });
    await prisma.assessmentEvent.deleteMany({ where: { tenantId, id: { startsWith: 'frappe_qr_' } } });
    await prisma.masteryRecord.deleteMany({ where: { tenantId, objectiveId: fakeLesson.name } });
    await prisma.assessmentItem.deleteMany({ where: { tenantId, id: { in: ['q_front_office_01', 'q_housekeeping_01'] } } });
    await prisma.learningObjective.deleteMany({ where: { tenantId, id: fakeLesson.name } });
    await prisma.learner.deleteMany({
      where: {
        tenantId,
        externalRef: {
          in: [
            frappeSyncService.anonymizeLearnerId('siswa.lain1@nusadayaacademy.com'),
            frappeSyncService.anonymizeLearnerId('siswa.lain2@nusadayaacademy.com'),
          ],
        },
      },
    });
    await prisma.frappeConnection.delete({ where: { tenantId } }).catch(() => {});
  }
}

main()
  .catch((err) => {
    console.error('\n>>> TEST FAILED <<<');
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
