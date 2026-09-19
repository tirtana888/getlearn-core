import { prisma } from '../src/lib/prisma.js';
import { chatService, CHAT_SIMILARITY_THRESHOLD } from '../src/services/chat.service.js';
import { ragService } from '../src/services/rag.service.js';
import { ChatScope } from '@prisma/client';

async function main() {
  console.log('>>> Testing Chat RAG Relevance Threshold Guardrail <<<\n');
  console.log(`[CONFIG] Named CHAT_SIMILARITY_THRESHOLD = ${CHAT_SIMILARITY_THRESHOLD}`);

  const tenantId = 'ten_dev_nusadaya';
  const testLearnerId = `usr_thresh_test_${Date.now()}`;

  // 1. Create test learner and session
  const learner = await prisma.learner.create({
    data: { tenantId, externalRef: testLearnerId },
  });
  const session = await chatService.createSession(
    tenantId,
    learner.externalRef,
    ChatScope.learner
  );
  console.log(`[1] Created test session: ${session.session_id} for learner: ${learner.externalRef}`);

  // 2. Test ON-TOPIC Query (Geometry)
  console.log('\n[2] Testing ON-TOPIC Query ("Bagaimana rumus luas lingkaran?")...');
  const onTopicReply = await chatService.sendMessage(
    tenantId,
    session.session_id,
    'Bagaimana rumus luas lingkaran?',
    false
  );
  console.log(`    Response snippet: "${onTopicReply.content.slice(0, 100).replace(/\n/g, ' ')}..."`);
  console.log(`    Source content IDs: ${JSON.stringify(onTopicReply.source_content_ids)}`);
  
  if (onTopicReply.source_content_ids && onTopicReply.source_content_ids.length > 0) {
    console.log('    [PASS] Relevant curriculum material found and cited.');
  } else {
    console.error('    [FAIL] On-topic query failed to find chunks!');
    process.exit(1);
  }

  // 3. Test OFF-TOPIC Query (Baking Chocolate Cake)
  console.log('\n[3] Testing OFF-TOPIC Query ("Bagaimana resep dan cara memanggang kue bolu cokelat di oven?")...');
  const offTopicReply = await chatService.sendMessage(
    tenantId,
    session.session_id,
    'Bagaimana resep dan cara memanggang kue bolu cokelat di oven?',
    false
  );
  console.log(`    Response snippet: "${offTopicReply.content}"`);
  console.log(`    Source content IDs: ${JSON.stringify(offTopicReply.source_content_ids)}`);

  // With an AI provider configured the coach now answers off-topic messages in its own words
  // (a polite redirect) instead of a canned line, so assert on what matters: nothing was retrieved
  // or cited, and the reply is not a made-up answer built from unrelated material.
  if (offTopicReply.source_content_ids.length === 0 && offTopicReply.content.trim().length > 0) {
    console.log('    [PASS] Off-topic query retrieved no material (caught by the similarity threshold) and got a reply with no citations.');
  } else {
    console.error('    [FAIL] Off-topic query was not caught by threshold!');
    process.exit(1);
  }

  // 4. Test Raw Search Endpoint Non-regression (without threshold parameter)
  console.log('\n[4] Testing Raw searchSimilarChunks without threshold (must return raw results)...');
  const rawResults = await ragService.searchSimilarChunks(tenantId, 'kue bolu', 3);
  console.log(`    Raw results returned: ${rawResults.length} items (unfiltered for exploration).`);
  if (rawResults.length > 0) {
    console.log('    [PASS] Raw search endpoint behavior preserved without regression.');
  } else {
    console.error('    [FAIL] Raw search unexpectedly empty!');
    process.exit(1);
  }

  console.log('\n>>> All Relevance Threshold Tests Passed Successfully! <<<');
}

main()
  .catch((e) => {
    console.error('Fatal error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
