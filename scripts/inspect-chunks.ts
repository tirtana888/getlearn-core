import { prisma } from '../src/lib/prisma.js';

async function main() {
  const chunks = await prisma.contentChunk.findMany();
  console.log('Total chunks in DB:', chunks.length);
  for (const c of chunks) {
    console.log(`- Item: ${c.contentItemId}, Text: ${c.chunkText.slice(0, 60)}`);
  }
}

main().finally(() => prisma.$disconnect());
