import { ragService } from '../src/services/rag.service.js';
import { prisma } from '../src/lib/prisma.js';

async function main() {
  const query = "Geometri: Menghitung Keliling dan Luas Lingkaran";
  const results = await ragService.searchSimilarChunks('ten_dev_nusadaya', query, 5);
  console.log('Query:', query);
  for (const r of results) {
    console.log(`- Item: ${r.contentItemId}, Similarity: ${r.similarity}, Text: ${r.chunkText.slice(0, 50)}`);
  }
}

main().finally(() => prisma.$disconnect());
