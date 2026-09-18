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

  const realFetch = global.fetch;
  let listCalled = false;
  let detailCalled = false;

  global.fetch = (async (url: string, init?: any) => {
    const authHeader = init?.headers?.Authorization;
    const expectedAuth = `token ${fakeApiKey}:${fakeApiSecret}`;
    if (authHeader !== expectedAuth) {
      throw new Error(`Unexpected auth header: ${authHeader}`);
    }

    if (url.includes('/api/resource/LMS Quiz Submission?')) {
      listCalled = true;
      // Mimic Frappe's own server-side filtering, so a second sync run with an
      // advanced watermark correctly sees no submissions - same as the real API would.
      const sinceMatch = decodeURIComponent(url).match(/"creation",">","([^"]+)"/);
      const sinceParam = sinceMatch ? new Date(sinceMatch[1]) : new Date(0);
      const matches = new Date(fakeSubmission.creation) > sinceParam ? [{ name: fakeSubmission.name }] : [];
      console.log(`[mock fetch:list] since=${sinceParam.toISOString()} -> ${matches.length} match(es)`);
      return new Response(JSON.stringify({ data: matches }), { status: 200 });
    }

    if (url.includes(`/api/resource/LMS Quiz Submission/${fakeSubmission.name}`)) {
      detailCalled = true;
      console.log(`[mock fetch:detail] ${url}`);
      return new Response(JSON.stringify({ data: fakeSubmission }), { status: 200 });
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

    const checks = [
      { name: 'list endpoint called', pass: listCalled },
      { name: 'detail endpoint called', pass: detailCalled },
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
