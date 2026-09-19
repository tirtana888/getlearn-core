/**
 * Offline check of the DeepSeek fallback provider (no network, no DB writes):
 * request shape, token accounting, model override, and error surfacing.
 */
process.env.DEEPSEEK_API_KEY = 'sk-test';
delete process.env.DEEPSEEK_MODEL;

import { chatService } from '../src/services/chat.service.js';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' - ' + detail : ''}`);
  if (!ok) failures++;
}

const svc = chatService as any;
const realFetch = globalThis.fetch;
let captured: { url: string; init: any } | null = null;

async function main() {
  // 1. Happy path: OpenAI-compatible response with usage.
  globalThis.fetch = (async (url: any, init: any) => {
    captured = { url: String(url), init };
    return new Response(
      JSON.stringify({ choices: [{ message: { content: 'Jawaban dari DeepSeek' } }], usage: { total_tokens: 321 } }),
      { status: 200 }
    );
  }) as any;

  const out = await svc.generateWithDeepSeek('SYSTEM', 'USER');
  const body = JSON.parse(captured!.init.body);
  check('calls the chat completions endpoint', captured!.url === 'https://api.deepseek.com/chat/completions', captured!.url);
  check('sends the bearer key', captured!.init.headers.Authorization === 'Bearer sk-test');
  check('defaults to the current deepseek-flash model', body.model === 'deepseek-flash', body.model);
  check('system + user messages, non-streaming', body.messages[0].role === 'system' && body.messages[1].role === 'user' && body.stream === false);
  check('returns text and provider-reported tokens', out.text === 'Jawaban dari DeepSeek' && out.tokens === 321);

  // 2. Model override via env.
  process.env.DEEPSEEK_MODEL = 'deepseek-v4-pro';
  await svc.generateWithDeepSeek('S', 'U');
  check('DEEPSEEK_MODEL overrides the model', JSON.parse(captured!.init.body).model === 'deepseek-v4-pro');
  delete process.env.DEEPSEEK_MODEL;

  // 3. Missing usage falls back to an estimate instead of 0/NaN.
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: 'abcd'.repeat(10) } }] }), { status: 200 })) as any;
  const est = await svc.generateWithDeepSeek('s'.repeat(40), 'u'.repeat(40));
  check('estimates tokens when usage is absent', Number.isFinite(est.tokens) && est.tokens > 0, String(est.tokens));

  // 4. HTTP errors surface (so the chain can report / try the next provider).
  globalThis.fetch = (async () => new Response('rate limited', { status: 429 })) as any;
  let threw = '';
  try {
    await svc.generateWithDeepSeek('S', 'U');
  } catch (e: any) {
    threw = e.message;
  }
  check('HTTP error is thrown with status', threw.includes('429'), threw);

  // 5. Provider availability.
  check('hasAnyProvider true when only DeepSeek key is set', svc.hasAnyProvider() === true);
  delete process.env.DEEPSEEK_API_KEY;
  check('generateWithDeepSeek refuses without a key', await svc.generateWithDeepSeek('S', 'U').then(() => false, () => true));

  globalThis.fetch = realFetch;
  console.log(failures === 0 ? '\nAll DeepSeek fallback checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
