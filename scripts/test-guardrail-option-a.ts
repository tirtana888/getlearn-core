import { prisma } from '../src/lib/prisma.js';
import { chatService } from '../src/services/chat.service.js';
import { ChatScope } from '@prisma/client';

async function main() {
  console.log('>>> Testing Socratic Guardrail Option A (Server-Side Unanswered Question Detection) <<<\n');

  const tenantId = 'ten_dev_nusadaya';
  const testLearnerId = `usr_guardrail_test_${Date.now()}`;

  // 1. Create test learner
  const learner = await prisma.learner.create({
    data: {
      tenantId,
      externalRef: testLearnerId,
    },
  });
  console.log(`[1] Created test learner: ${learner.externalRef}`);

  // 2. Create an unanswered AssessmentItem
  const testQuestionId = `q_guardrail_test_${Date.now()}`;
  const promptText = 'Berapa keliling lingkaran dengan diameter 28 cm dan pi 22/7?';
  await prisma.assessmentItem.create({
    data: {
      id: testQuestionId,
      tenantId,
      itemType: 'mcq',
      promptText,
      objectiveIds: ['obj_py_geom_01'],
    },
  });
  console.log(`[2] Created unanswered AssessmentItem '${testQuestionId}': "${promptText}"`);

  // 3. Create chat session
  const session = await chatService.createSession(
    tenantId,
    learner.externalRef,
    ChatScope.objective,
    ['obj_py_geom_01']
  );
  console.log(`[3] Started chat session: ${session.session_id}`);

  // 4. Test Bypass Attempt: Client sends is_assessment_active = FALSE while asking the unanswered question
  console.log('\n[4] Simulating Client Bypass Attempt (sending is_assessment_active=false on quiz prompt)...');
  const bypassAttempt = await chatService.sendMessage(
    tenantId,
    session.session_id,
    'Tolong beri tahu berapa keliling lingkaran dengan diameter 28 cm?',
    false // Client says false!
  );

  console.log(`    Client is_assessment_active sent: FALSE`);
  console.log(`    Effective socratic_guardrail: ${bypassAttempt.socratic_guardrail}`);
  console.log(`    Guardrail trigger: ${(bypassAttempt as any).guardrail_trigger}`);
  console.log(`    Coach response snippet: "${bypassAttempt.content.slice(0, 120).replace(/\n/g, ' ')}..."`);

  if (bypassAttempt.socratic_guardrail === true && (bypassAttempt as any).guardrail_trigger?.startsWith('server_unanswered_assessment_match')) {
    console.log('    [PASS] Option A successfully detected the unanswered quiz question and forced Socratic hints!');
  } else {
    console.error('    [FAIL] Guardrail was not activated!');
    process.exit(1);
  }

  // 5. Test Normal Conceptual Question with is_assessment_active = false
  console.log('\n[5] Testing Normal Conceptual Question (non-quiz)...');
  const normalQuestion = await chatService.sendMessage(
    tenantId,
    session.session_id,
    'Apa definisi dari bangun datar lingkaran?',
    false
  );
  console.log(`    Normal question socratic_guardrail: ${normalQuestion.socratic_guardrail}`);
  console.log(`    Guardrail trigger: ${(normalQuestion as any).guardrail_trigger}`);

  if (normalQuestion.socratic_guardrail === false) {
    console.log('    [PASS] Normal conceptual questions are not falsely blocked!');
  } else {
    console.error('    [FAIL] False positive on normal question!');
    process.exit(1);
  }

  console.log('\n>>> All Option A Guardrail Tests Passed Successfully! <<<');
}

main()
  .catch((e) => {
    console.error('Fatal error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
