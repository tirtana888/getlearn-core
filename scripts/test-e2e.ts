import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

async function runE2ETests() {
  console.log('🧪 Starting getlearn.ai Phase 0 & Phase 1 E2E Verification Tests...\n');

  const app = await buildApp();
  const apiKey = 'dev-nusadaya-key';
  const authHeader = { authorization: `Bearer ${apiKey}` };

  try {
    // 1. Health check test
    console.log('1️⃣ Testing Health Check...');
    const healthRes = await app.inject({
      method: 'GET',
      url: '/health',
    });
    if (healthRes.statusCode !== 200) throw new Error(`Health check failed: ${healthRes.body}`);
    console.log('   ✅ GET /health -> 200 OK');

    // 2. Register Learning Objective
    console.log('2️⃣ Registering Learning Objective (POST /v1/objectives)...');
    const objRes = await app.inject({
      method: 'POST',
      url: '/v1/objectives',
      headers: authHeader,
      payload: {
        id: 'obj_fraction_add',
        label: 'Penjumlahan dan Pengurangan Pecahan',
      },
    });
    if (objRes.statusCode !== 200) throw new Error(`Objective registration failed: ${objRes.body}`);
    console.log('   ✅ Objective registered:', objRes.json().id);

    // 3. Register Content Item
    console.log('3️⃣ Registering Content Item (POST /v1/content-items)...');
    const contentRes = await app.inject({
      method: 'POST',
      url: '/v1/content-items',
      headers: authHeader,
      payload: {
        id: 'lesson_frac_intro',
        type: 'text',
        source_uri: 'https://nusadaya.academy/lessons/pecahan-dasar',
        objective_ids: ['obj_fraction_add'],
      },
    });
    if (contentRes.statusCode !== 200) throw new Error(`Content registration failed: ${contentRes.body}`);
    console.log('   ✅ Content item registered:', contentRes.json().id);

    // 4. Register Assessment Item
    console.log('4️⃣ Registering Assessment Item (POST /v1/assessment-items)...');
    const itemRes = await app.inject({
      method: 'POST',
      url: '/v1/assessment-items',
      headers: authHeader,
      payload: {
        id: 'q_frac_add_01',
        item_type: 'mcq',
        prompt_text: 'Berapakah hasil dari 1/2 + 1/4?',
        objective_ids: ['obj_fraction_add'],
      },
    });
    if (itemRes.statusCode !== 200) throw new Error(`Assessment item registration failed: ${itemRes.body}`);
    console.log('   ✅ Assessment item registered:', itemRes.json().id);

    // 5. Ingest First Event (Correct Answer)
    const learnerExternalId = 'usr_frappe_test_01';
    console.log('5️⃣ Ingesting 1st Assessment Event (Correct answer)...');
    const evt1Res = await app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: authHeader,
      payload: {
        event_id: `evt_test_${Date.now()}_1`,
        event_type: 'assessment.answered',
        external_learner_id: learnerExternalId,
        occurred_at: new Date().toISOString(),
        payload: {
          item_id: 'q_frac_add_01',
          is_correct: true,
          raw_response: '3/4',
        },
      },
    });
    if (evt1Res.statusCode !== 200) throw new Error(`Event 1 ingestion failed: ${evt1Res.body}`);
    console.log('   ✅ Event 1 processed:', evt1Res.json());

    // 6. Check Mastery After 1st Event
    console.log('6️⃣ Checking Learner Mastery (GET /v1/learners/:id/mastery)...');
    const mastery1Res = await app.inject({
      method: 'GET',
      url: `/v1/learners/${learnerExternalId}/mastery`,
      headers: authHeader,
    });
    const mastery1Data = mastery1Res.json();
    console.log(`   ✅ Current Score: ${mastery1Data.mastery[0].score} (Evidence count: ${mastery1Data.mastery[0].evidence_count})`);
    if (mastery1Data.mastery[0].score !== 1.0) throw new Error('Expected score 1.0');

    // 7. Ingest Second Event (Incorrect Answer)
    console.log('7️⃣ Ingesting 2nd Assessment Event (Incorrect answer)...');
    const event2Id = `evt_test_${Date.now()}_2`;
    const evt2Res = await app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: authHeader,
      payload: {
        event_id: event2Id,
        event_type: 'assessment.answered',
        external_learner_id: learnerExternalId,
        occurred_at: new Date().toISOString(),
        payload: {
          item_id: 'q_frac_add_01',
          is_correct: false,
          raw_response: '2/6',
        },
      },
    });
    if (evt2Res.statusCode !== 200) throw new Error(`Event 2 ingestion failed: ${evt2Res.body}`);
    console.log('   ✅ Event 2 processed:', evt2Res.json());

    // 8. Test Idempotency (Re-send Event 2 with identical event_id)
    console.log('8️⃣ Testing Event Idempotency (Re-sending identical event_id)...');
    const duplicateRes = await app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: authHeader,
      payload: {
        event_id: event2Id,
        event_type: 'assessment.answered',
        external_learner_id: learnerExternalId,
        occurred_at: new Date().toISOString(),
        payload: {
          item_id: 'q_frac_add_01',
          is_correct: false,
          raw_response: '2/6',
        },
      },
    });
    const dupData = duplicateRes.json();
    if (duplicateRes.statusCode !== 200 || dupData.status !== 'duplicate_ignored') {
      throw new Error(`Idempotency check failed: ${duplicateRes.body}`);
    }
    console.log('   ✅ Idempotency confirmed: Status returned duplicate_ignored');

    // 9. Query Learning Gaps
    console.log('9️⃣ Querying Learning Gaps (GET /v1/learners/:id/gaps)...');
    const gapsRes = await app.inject({
      method: 'GET',
      url: `/v1/learners/${learnerExternalId}/gaps?threshold=0.70`,
      headers: authHeader,
    });
    const gapsData = gapsRes.json();
    console.log(`   ✅ Gaps found: ${gapsData.gaps.length} (Score: ${gapsData.gaps[0]?.score})`);
    if (gapsData.gaps.length === 0 || gapsData.gaps[0].score !== 0.5) {
      throw new Error(`Expected gap with score 0.5, got: ${JSON.stringify(gapsData)}`);
    }

    // 10. Query Next Action Recommendation
    console.log('🔟 Querying Next Action Recommendation (GET /v1/learners/:id/next-action)...');
    const nextActionRes = await app.inject({
      method: 'GET',
      url: `/v1/learners/${learnerExternalId}/next-action`,
      headers: authHeader,
    });
    const nextActionData = nextActionRes.json();
    console.log('   ✅ Next Action:', nextActionData);
    if (nextActionData.action !== 'review' || nextActionData.target_id !== 'lesson_frac_intro') {
      throw new Error(`Unexpected next action: ${JSON.stringify(nextActionData)}`);
    }

    console.log('\n🎉 ALL PHASE 0 & PHASE 1 E2E TESTS PASSED SUCCESSFULLY! 🚀\n');
  } catch (err) {
    console.error('\n❌ Test execution failed:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

runE2ETests();
