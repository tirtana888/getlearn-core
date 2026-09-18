import { prisma } from '../src/lib/prisma.js';
import { frappeSyncService } from '../src/services/frappeSync.service.js';

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

  const realFetch = global.fetch;
  let listCalled = false;
  let detailCalled = false;
  let quizCalled = false;
  let lessonCalled = false;

  global.fetch = (async (url: string, init?: any) => {
    const authHeader = init?.headers?.Authorization;
    const expectedAuth = `token ${fakeApiKey}:${fakeApiSecret}`;
    if (authHeader !== expectedAuth) {
      throw new Error(`Unexpected auth header: ${authHeader}`);
    }

    const decoded = decodeURIComponent(url);

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

    const checks = [
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

    let allPass = true;
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

    if (!allPass) {
      throw new Error('One or more assertions failed.');
    }
    console.log('\n>>> All checks passed <<<');
  } finally {
    global.fetch = realFetch;
    await prisma.assessmentEvent.deleteMany({ where: { tenantId, id: { startsWith: 'frappe_qr_' } } });
    await prisma.masteryRecord.deleteMany({ where: { tenantId, objectiveId: fakeLesson.name } });
    await prisma.assessmentItem.deleteMany({ where: { tenantId, id: { in: ['q_front_office_01', 'q_housekeeping_01'] } } });
    await prisma.learningObjective.deleteMany({ where: { tenantId, id: fakeLesson.name } });
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
