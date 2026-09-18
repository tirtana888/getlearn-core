import { ragService } from '../src/services/rag.service.js';
import { prisma } from '../src/lib/prisma.js';

async function main() {
  const onTopic = await ragService.searchSimilarChunks('ten_dev_nusadaya', 'Bagaimana rumus keliling dan luas lingkaran?', 3);
  console.log('On-topic query similarity:');
  for (const r of onTopic) {
    console.log(`- ${r.contentItemId}: similarity = ${r.similarity}`);
  }

  const offTopic = await ragService.searchSimilarChunks('ten_dev_nusadaya', 'Bagaimana cara membuat kue cokelat di dapur?', 3);
  console.log('\nOff-topic query similarity:');
  for (const r of offTopic) {
    console.log(`- ${r.contentItemId}: similarity = ${r.similarity}`);
  }
}

main().finally(() => prisma.$disconnect());
