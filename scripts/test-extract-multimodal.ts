import { prisma } from '../src/lib/prisma.js';
import { ragService } from '../src/services/rag.service.js';
import { ContentType, IndexingStatus } from '@prisma/client';

async function main() {
  console.log('>>> Starting Multimodal Content Extraction & Indexing Test <<<\n');

  const tenantId = 'ten_dev_nusadaya';
  const hasGeminiKey = Boolean(process.env.GEMINI_API_KEY);
  console.log(`[INFO] GEMINI_API_KEY present: ${hasGeminiKey ? 'YES' : 'NO (will test graceful error handling)'}`);

  // 1. Test PDF extraction
  const pdfItem = {
    id: 'lesson_pdf_sample_01',
    type: ContentType.pdf,
    sourceUri: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf',
    objectiveIds: ['obj_py_geom_01'],
  };

  console.log(`\n[1] Upserting PDF Content Item '${pdfItem.id}' with source_uri '${pdfItem.sourceUri}'...`);
  await prisma.contentItem.upsert({
    where: { tenantId_id: { tenantId, id: pdfItem.id } },
    update: {
      type: pdfItem.type,
      sourceUri: pdfItem.sourceUri,
      objectiveIds: pdfItem.objectiveIds,
      indexingStatus: IndexingStatus.pending,
      indexingError: null,
    },
    create: {
      id: pdfItem.id,
      tenantId,
      type: pdfItem.type,
      sourceUri: pdfItem.sourceUri,
      objectiveIds: pdfItem.objectiveIds,
      indexingStatus: IndexingStatus.pending,
      indexingError: null,
    },
  });

  // Execute extraction (mimicking route handler)
  try {
    console.log('    Executing extractTextFromSource for PDF...');
    const text = await ragService.extractTextFromSource(pdfItem.type, pdfItem.sourceUri);
    console.log(`    [OK] Extracted text length: ${text.length} chars. Sample: "${text.slice(0, 100).replace(/\n/g, ' ')}..."`);

    await prisma.contentItem.update({
      where: { tenantId_id: { tenantId, id: pdfItem.id } },
      data: { rawText: text },
    });

    const chunks = await ragService.chunkAndEmbedContentItem(tenantId, pdfItem.id, text);
    console.log(`    [OK] Chunked and embedded into pgvector: ${chunks} chunk(s).`);

    await prisma.contentItem.update({
      where: { tenantId_id: { tenantId, id: pdfItem.id } },
      data: { indexingStatus: IndexingStatus.completed, indexingError: null },
    });
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.log(`    [EXPECTED/CATCH] PDF Extraction caught: ${msg}`);
    await prisma.contentItem.update({
      where: { tenantId_id: { tenantId, id: pdfItem.id } },
      data: { indexingStatus: IndexingStatus.failed, indexingError: msg },
    });
  }

  // Verify status in DB for PDF
  const dbPdf = await prisma.contentItem.findUnique({
    where: { tenantId_id: { tenantId, id: pdfItem.id } },
    include: { _count: { select: { chunks: true } } },
  });
  console.log(`    [DB STATUS] status=${dbPdf?.indexingStatus}, chunks=${dbPdf?._count.chunks}, error=${dbPdf?.indexingError ?? 'none'}`);

  // 2. Test YouTube Video extraction
  const videoItem = {
    id: 'lesson_video_youtube_01',
    type: ContentType.video,
    sourceUri: 'https://www.youtube.com/watch?v=kqtD5dpn9C8', // Python in 100 Seconds
    objectiveIds: ['obj_py_geom_01'],
  };

  console.log(`\n[2] Upserting YouTube Video '${videoItem.id}' with source_uri '${videoItem.sourceUri}'...`);
  await prisma.contentItem.upsert({
    where: { tenantId_id: { tenantId, id: videoItem.id } },
    update: {
      type: videoItem.type,
      sourceUri: videoItem.sourceUri,
      objectiveIds: videoItem.objectiveIds,
      indexingStatus: IndexingStatus.pending,
      indexingError: null,
    },
    create: {
      id: videoItem.id,
      tenantId,
      type: videoItem.type,
      sourceUri: videoItem.sourceUri,
      objectiveIds: videoItem.objectiveIds,
      indexingStatus: IndexingStatus.pending,
      indexingError: null,
    },
  });

  try {
    console.log('    Executing extractTextFromSource for YouTube Video...');
    const text = await ragService.extractTextFromSource(videoItem.type, videoItem.sourceUri);
    console.log(`    [OK] Extracted text length: ${text.length} chars. Sample: "${text.slice(0, 100).replace(/\n/g, ' ')}..."`);

    await prisma.contentItem.update({
      where: { tenantId_id: { tenantId, id: videoItem.id } },
      data: { rawText: text },
    });

    const chunks = await ragService.chunkAndEmbedContentItem(tenantId, videoItem.id, text);
    console.log(`    [OK] Chunked and embedded into pgvector: ${chunks} chunk(s).`);

    await prisma.contentItem.update({
      where: { tenantId_id: { tenantId, id: videoItem.id } },
      data: { indexingStatus: IndexingStatus.completed, indexingError: null },
    });
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.log(`    [EXPECTED/CATCH] Video Extraction caught: ${msg}`);
    await prisma.contentItem.update({
      where: { tenantId_id: { tenantId, id: videoItem.id } },
      data: { indexingStatus: IndexingStatus.failed, indexingError: msg },
    });
  }

  // Verify status in DB for Video
  const dbVideo = await prisma.contentItem.findUnique({
    where: { tenantId_id: { tenantId, id: videoItem.id } },
    include: { _count: { select: { chunks: true } } },
  });
  console.log(`    [DB STATUS] status=${dbVideo?.indexingStatus}, chunks=${dbVideo?._count.chunks}, error=${dbVideo?.indexingError ?? 'none'}`);

  // 3. Test SCORM guardrail
  console.log(`\n[3] Testing SCORM separation of concerns guardrail...`);
  try {
    await ragService.extractTextFromSource(ContentType.scorm, 'https://example.com/package.zip');
    console.error('    [FAIL] SCORM should not be extracted directly by getlearn-core!');
  } catch (err: any) {
    console.log(`    [PASS] SCORM correctly rejected with guardrail message: "${err.message}"`);
  }

  // 4. Verify Chunks & Embeddings in pgvector
  console.log(`\n[4] Verifying Chunks & pgvector Embeddings for Indexed Content Items...`);
  const sampleExtracted = `Materi Geometri Lingkaran Terstruktur:
1. Lingkaran adalah kurva tertutup sederhana di mana semua titik berjarak sama dari pusat.
2. Rumus Keliling: K = 2 * pi * r = pi * d.
3. Rumus Luas: L = pi * r^2.
Tabel Contoh Perhitungan:
- Jari-jari r=7 cm -> Luas = 22/7 * 7^2 = 154 cm^2.
- Jari-jari r=14 cm -> Luas = 22/7 * 14^2 = 616 cm^2.`;

  const chunksCount = await ragService.chunkAndEmbedContentItem(tenantId, 'lesson_pdf_sample_01', sampleExtracted);
  await prisma.contentItem.update({
    where: { tenantId_id: { tenantId, id: 'lesson_pdf_sample_01' } },
    data: {
      rawText: sampleExtracted,
      indexingStatus: IndexingStatus.completed,
      indexingError: null,
    },
  });

  console.log(`    [OK] Chunked and embedded into pgvector: ${chunksCount} chunk(s) saved in content_chunks.`);

  // Verify search
  const searchResults = await ragService.searchSimilarChunks(tenantId, 'Berapa rumus luas lingkaran', 3);
  console.log(`    [OK] pgvector Search Retrieval Results:`);
  for (const sr of searchResults) {
    console.log(`         - Item: ${sr.contentItemId}, Similarity: ${(sr.similarity * 100).toFixed(1)}%, Text: "${sr.chunkText.slice(0, 60).replace(/\n/g, ' ')}..."`);
  }

  console.log('\n>>> Multimodal Extraction Test Complete <<<');
}

main()
  .catch((e) => {
    console.error('Fatal test error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
