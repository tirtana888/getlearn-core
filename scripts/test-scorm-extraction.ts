import JSZip from 'jszip';
import { ragService } from '../src/services/rag.service.js';
import { ContentType } from '@prisma/client';

/**
 * Pure unit test for SCORM extraction — builds a synthetic package in memory and
 * mocks global fetch, so it needs no real database, tenant, or hosted SCORM file.
 */
async function main() {
  console.log('>>> SCORM Extraction Unit Test <<<\n');

  const zip = new JSZip();
  zip.file('imsmanifest.xml', '<manifest>fake manifest, must be skipped</manifest>');
  zip.file('scorm_api.html', '<html><body>SCORM API wrapper, must be skipped</body></html>');
  zip.file(
    'res/slide1.html',
    '<html><head><style>.x{color:red}</style></head><body><script>var x=1;</script>' +
      '<h1>Pengenalan Front Office</h1>' +
      '<p>Front office adalah bagian hotel yang menangani check-in &amp; check-out tamu.</p></body></html>'
  );
  zip.file(
    'res/slide2.html',
    '<html><body><h1>Tugas Utama</h1>' +
      '<p>Front office bertugas menyambut tamu, memproses reservasi, dan menangani keluhan.</p></body></html>'
  );

  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
  console.log(`[1] Built synthetic SCORM package: ${zipBuffer.length} bytes\n`);

  const realFetch = global.fetch;
  global.fetch = (async (url: string) => {
    console.log(`[mock fetch] ${url}`);
    return new Response(zipBuffer, { status: 200 });
  }) as typeof fetch;

  try {
    console.log('[2] Calling ragService.extractTextFromSource(ContentType.scorm, ...)\n');
    const extracted = await ragService.extractTextFromSource(
      ContentType.scorm,
      'https://example.com/fake-package.zip'
    );

    console.log('--- EXTRACTED TEXT ---');
    console.log(extracted);
    console.log('----------------------\n');

    const checks = [
      { name: 'contains slide1 heading', pass: extracted.includes('Pengenalan Front Office') },
      { name: 'contains slide2 heading', pass: extracted.includes('Tugas Utama') },
      { name: 'imsmanifest.xml excluded', pass: !extracted.includes('fake manifest') },
      { name: 'scorm_api.html excluded', pass: !extracted.includes('SCORM API wrapper') },
      { name: 'script tags stripped', pass: !extracted.includes('var x=1') },
      { name: 'entities unescaped (&amp; -> &)', pass: extracted.includes('check-in & check-out') },
    ];

    let allPass = true;
    for (const c of checks) {
      console.log(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.name}`);
      if (!c.pass) allPass = false;
    }

    if (!allPass) {
      throw new Error('One or more assertions failed.');
    }
    console.log('\n>>> All checks passed <<<');
  } finally {
    global.fetch = realFetch;
  }
}

main().catch((err) => {
  console.error('\n>>> TEST FAILED <<<');
  console.error(err);
  process.exit(1);
});
