import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { GoogleGenAI } from '@google/genai';
import { prisma } from '../lib/prisma.js';
import { ragService } from './rag.service.js';
import { ChatScope, ChatSender } from '@prisma/client';

/**
 * Minimum cosine similarity threshold for retrieved chunks to be considered relevant for AI tutoring.
 * Calibrated against gemini-embedding-001 on real Nusadaya material: on-topic questions score
 * 0.65 - 0.87 for their best chunk, while off-topic ones ("Siapa presiden Indonesia?") peak at
 * ~0.57. Chunks below this threshold are discarded so off-topic questions get no context.
 */
export const CHAT_SIMILARITY_THRESHOLD = 0.6;

/** Bar for retrieval restricted to a single lesson's own material. */
export const LESSON_SCOPED_SIMILARITY_THRESHOLD = 0.5;

/**
 * Questions about the lesson as a whole ("ini materi tentang apa?", "rangkum lesson ini").
 * They resemble no single passage, so similarity search finds nothing and the coach would
 * refuse a perfectly answerable question.
 */
export const OVERVIEW_QUESTION_RE =
  /\b(tentang apa|apa isi|isi (materi|lesson|pelajaran|modul)|membahas apa|belajar apa|rangkum|ringkas|ringkasan|overview|garis besar|inti (dari )?(materi|lesson|bab))\b|(materi|lesson|pelajaran|bab|modul|topik).{0,25}\b(apa|tentang|isi|bahas)\b/i;

export class ChatService {
  private ai: GoogleGenAI | null = null;

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey) {
      this.ai = new GoogleGenAI({ apiKey });
    }
  }

  /**
   * Start a new chat session with an automated personalized opening
   */
  async createSession(
    tenantId: string,
    learnerIdOrRef: string,
    scope: ChatScope,
    objectiveIds: string[] = []
  ) {
    const learner = await prisma.learner.findFirst({
      where: {
        tenantId,
        OR: [{ id: learnerIdOrRef }, { externalRef: learnerIdOrRef }],
      },
    });

    if (!learner) {
      throw new Error(`Learner '${learnerIdOrRef}' not found`);
    }

    // 1. Look up weakest objective in the scope to contextualize greeting
    let focusObjectiveLabel = '';
    const masteryWhere: any = { tenantId, learnerId: learner.id };
    if (scope === 'objective' && objectiveIds.length > 0) {
      masteryWhere.objectiveId = { in: objectiveIds };
    }

    const weakestRecord = await prisma.masteryRecord.findFirst({
      where: masteryWhere,
      include: { objective: true },
      orderBy: { score: 'asc' },
    });

    if (weakestRecord) {
      focusObjectiveLabel = weakestRecord.objective.label;
    } else if (objectiveIds.length > 0) {
      const obj = await prisma.learningObjective.findFirst({
        where: { tenantId, id: objectiveIds[0] },
      });
      if (obj) focusObjectiveLabel = obj.label;
    }

    const title = focusObjectiveLabel
      ? `Coach: ${focusObjectiveLabel.slice(0, 30)}...`
      : 'Sesi Bimbingan Belajar';

    // 2. Create ChatSession
    const session = await prisma.chatSession.create({
      data: {
        tenantId,
        learnerId: learner.id,
        scope,
        objectiveIds,
        title,
      },
    });

    // 3. Create Automated Opening Message
    const openingContent = focusObjectiveLabel
      ? `Hai! Aku Study Coach-mu. Kita lagi di materi "${focusObjectiveLabel}". Mau bahas bagian yang mana, atau ada yang bikin bingung?`
      : 'Hai! Aku Study Coach-mu. Ada materi atau konsep yang mau kita bahas?';

    await prisma.chatMessage.create({
      data: {
        sessionId: session.id,
        sender: ChatSender.assistant,
        content: openingContent,
        sourceContentIds: [],
      },
    });

    return {
      session_id: session.id,
      learner_id: learner.externalRef,
      scope: session.scope,
      title: session.title,
      opening_message: openingContent,
      created_at: session.createdAt.toISOString(),
    };
  }

  /**
   * Send a chat message and receive a guardrailed Socratic response
   */
  async sendMessage(
    tenantId: string,
    sessionId: string,
    userMessage: string,
    isAssessmentActive = false,
    voiceRequested = false,
    baseUrl?: string
  ) {
    const session = await prisma.chatSession.findUnique({
      where: { id: sessionId },
      include: { learner: true },
    });

    if (!session || session.tenantId !== tenantId) {
      throw new Error('Chat session not found');
    }

    // Pre-flight check: verify tenant token balance before executing AI services
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { tokenBalance: true },
    });
    if (tenant && tenant.tokenBalance <= 0) {
      const err: any = new Error('Tenant token balance is exhausted. Please top up credits to use AI coach.');
      err.code = 'TOKEN_BALANCE_EXHAUSTED';
      err.statusCode = 402;
      throw err;
    }

    let tokensUsed = 0;

    // Recent turns, read before saving this message. Without them a follow-up such as
    // "bisa kasih contohnya?" has no topic of its own and retrieves unrelated chunks.
    const recent = await prisma.chatMessage.findMany({
      where: { sessionId: session.id },
      orderBy: { createdAt: 'desc' },
      take: 6,
      select: { sender: true, content: true, sourceContentIds: true },
    });
    const history = recent.reverse();

    // 1. Save User Message
    await prisma.chatMessage.create({
      data: {
        sessionId: session.id,
        sender: ChatSender.user,
        content: userMessage,
        sourceContentIds: [],
      },
    });

    // 2. Retrieve relevant content chunks using pgvector with similarity threshold filtering
    // In production with Gemini embeddings (text-embedding-004), threshold is CHAT_SIMILARITY_THRESHOLD (0.55).
    // In dev / fallback mode with deterministic n-gram hashing, threshold adapts to 0.25 to prevent false rejections.
    const activeThreshold = ragService.hasGeminiEmbeddings() ? CHAT_SIMILARITY_THRESHOLD : 0.25;

    // A short message ("contohnya?", "jelaskan lebih lanjut") carries no topic, so search with
    // the learner's previous question(s) as well.
    const isShortFollowUp = userMessage.trim().split(/\s+/).length < 6;
    const retrievalQuery = isShortFollowUp
      ? [...history.filter((m) => m.sender === ChatSender.user).slice(-2).map((m) => m.content), userMessage].join(' ')
      : userMessage;

    // A session scoped to specific objectives only searches the material of those lessons.
    let scopedContentIds: string[] | undefined;
    if (session.scope === 'objective' && session.objectiveIds.length > 0) {
      const scopedItems = await prisma.contentItem.findMany({
        where: { tenantId, objectiveIds: { hasSome: session.objectiveIds } },
        select: { id: true },
      });
      // No indexed material for the chosen objective: search everything rather than nothing.
      if (scopedItems.length > 0) scopedContentIds = scopedItems.map((i) => i.id);
    }

    // A follow-up stays on the lesson(s) the coach just answered from: "contohnya?" means examples
    // of that topic, not of whatever lesson happens to mention examples the most.
    // Inside one lesson the candidate set is small and all on-topic, so a lower bar is safe (the
    // guardrail prompt still makes the model say so when the answer is not in the material).
    // Across the whole tenant a vague message drifts to unrelated lessons, so the bar stays high.
    const searchThreshold = scopedContentIds
      ? Math.min(activeThreshold, LESSON_SCOPED_SIMILARITY_THRESHOLD)
      : activeThreshold;
    let retrievedChunks: Awaited<ReturnType<typeof ragService.searchSimilarChunks>> = [];
    const lastSources = isShortFollowUp
      ? [...history].reverse().find((m) => m.sender === ChatSender.assistant && m.sourceContentIds.length > 0)
          ?.sourceContentIds
      : undefined;
    if (lastSources && lastSources.length > 0) {
      const allowed = scopedContentIds ? lastSources.filter((id) => scopedContentIds!.includes(id)) : lastSources;
      if (allowed.length > 0) {
        retrievedChunks = await ragService.searchSimilarChunks(tenantId, retrievalQuery, 4, searchThreshold, allowed);
      }
    }
    if (retrievedChunks.length === 0) {
      retrievedChunks = await ragService.searchSimilarChunks(
        tenantId,
        retrievalQuery,
        4,
        searchThreshold,
        scopedContentIds
      );
    }
    // Lesson-scoped session + a question about the lesson itself: answer from its opening
    // material instead of refusing for lack of a similar passage.
    // A message of a few words ("gimana", "lanjut") names no topic either; in a lesson-scoped
    // session the lesson itself is the topic.
    const isVague = userMessage.trim().split(/\s+/).length <= 3;
    const isOverview = OVERVIEW_QUESTION_RE.test(userMessage);
    let contextIsOnlyFallback = false;
    if (retrievedChunks.length === 0 && scopedContentIds && (isOverview || isVague)) {
      retrievedChunks = await ragService.getLeadingChunks(tenantId, scopedContentIds, 4);
      // Handed to the model as background so it can read a vague message, but not a passage that
      // matched the question - so it must not be listed as a source under "makasih ya".
      contextIsOnlyFallback = retrievedChunks.length > 0 && !isOverview;
    }

    const sourceContentIds = contextIsOnlyFallback
      ? []
      : Array.from(new Set(retrievedChunks.map((c) => c.contentItemId)));

    const contextText = retrievedChunks.map((c) => c.chunkText).join('\n---\n');

    // 2b. Server-Side Guardrail Detection (Option A)
    // Even if client passes isAssessmentActive=false, check if the user is asking about an unanswered AssessmentItem
    let effectiveAssessmentActive = isAssessmentActive;
    let guardrailTrigger = isAssessmentActive ? 'client_flag' : 'none';

    if (!effectiveAssessmentActive) {
      try {
        const unansweredWhere: any = {
          tenantId,
          assessmentEvents: {
            none: {
              learnerId: session.learnerId,
            },
          },
        };

        if (session.scope === 'objective' && session.objectiveIds.length > 0) {
          unansweredWhere.objectiveIds = { hasSome: session.objectiveIds };
        }

        const unansweredItems = await prisma.assessmentItem.findMany({
          where: unansweredWhere,
          select: {
            id: true,
            promptText: true,
          },
          take: 50,
        });

        for (const item of unansweredItems) {
          if (this.checkPromptOverlap(userMessage, item.promptText)) {
            effectiveAssessmentActive = true;
            guardrailTrigger = `server_unanswered_assessment_match:${item.id}`;
            break;
          }
        }
      } catch (err) {
        console.warn('Error during server-side assessment prompt matching:', err);
      }
    }

    // 3. Generate response with strict Guardrails
    let assistantReply = '';
    let finalAudioUrl: string | null = null;

    let providerUsed: 'gemini' | 'deepseek' | null = null;

    // Name of the lesson the session is scoped to, so "ini materi apa?" is answerable even when
    // no passage matched.
    let lessonLabel: string | undefined;
    if (session.scope === 'objective' && session.objectiveIds.length > 0) {
      lessonLabel = (
        await prisma.learningObjective.findFirst({
          where: { tenantId, id: { in: session.objectiveIds } },
          select: { label: true },
        })
      )?.label;
    }

    // The model is called even when no passage matched: a greeting, a thank-you or a vague
    // "gimana" deserves a natural reply, not a canned refusal. It is told plainly when nothing
    // matched, so it cannot pretend to quote material it was not given.
    if (this.hasAnyProvider()) {
      const systemPrompt = `Kamu adalah Study Coach di getlearn.ai: teman belajar yang santai, sabar, dan to the point. Ngobrol seperti mentor yang enak diajak bicara, bukan seperti robot atau buku teks.

GAYA BICARA
- Bahasa Indonesia sehari-hari yang tetap sopan. Pakai "aku" dan "kamu". Hangat boleh, lebay jangan.
- Langsung ke jawaban. Jangan membuka dengan "Halo!", "Pertanyaan bagus!" atau pujian lain, kecuali memang sedang membalas sapaan.
- Singkat: biasanya 2-4 kalimat atau paragraf pendek. Panjangkan hanya kalau diminta atau memang butuh langkah berurutan. Pakai poin/daftar hanya untuk hal yang berurutan.
- Kalau pesannya samar atau cuma satu-dua kata ("gimana", "lanjut", "terus?"), tebak maksudnya dari percakapan dan lesson yang sedang dibuka lalu jawab, atau tanya balik satu pertanyaan pendek. Jangan menolak.
- Sapaan, terima kasih, atau basa-basi: balas singkat dan wajar, lalu ajak lanjut belajar. Tidak perlu materi untuk itu.
- Variasikan kalimatmu. Jangan mengulang kalimat baku yang sama di tiap balasan.

ISI JAWABAN
1. Pijakan utama adalah MATERI PELAJARAN di bawah. Jangan mengarang isi materi, angka, nama, atau istilah yang tidak ada di sana, dan jangan mengaku materi berkata sesuatu yang tidak tertulis.
2. Kamu boleh menambah penjelasan umum yang singkat (contoh, analogi, definisi sederhana) supaya konsepnya mudah dipahami, selama masih satu topik dengan lesson. WAJIB ditandai dengan awalan singkat seperti "Di luar materi:" atau "Sekadar contoh umum:", supaya siswa tahu mana yang dari materi dan mana tambahanmu.
3. Kalau materi tidak memuat jawabannya, bilang santai apa yang ada dan tidak ada di materi, lalu arahkan ke bagian terdekat atau tawarkan bantuan lain.
4. Kalau pertanyaannya jelas tidak berhubungan dengan belajar (politik, gosip, dan sebagainya), tolak dengan ramah dalam satu kalimat dan ajak balik ke lesson.
5. ${
        effectiveAssessmentActive
          ? 'PENTING: siswa sedang mengerjakan soal/asesmen aktif. JANGAN memberi jawaban langsung atau final. Bantu dengan petunjuk, pertanyaan pengarah, atau tunjukkan konsep/rumus yang relevan supaya ia menemukan jawabannya sendiri.'
          : 'Jelaskan bertahap dan mudah dipahami.'
      }`;

      const transcript = history
        .map((m) => `${m.sender === ChatSender.user ? 'SISWA' : 'COACH'}: ${m.content.slice(0, 600)}`)
        .join('\n');

      const prompt = `${lessonLabel ? `LESSON YANG SEDANG DIBUKA: ${lessonLabel}\n\n` : ''}MATERI PELAJARAN:
${contextText.trim() ? contextText : '(tidak ada bagian materi yang cocok dengan pesan ini)'}
${transcript ? `\nRIWAYAT PERCAKAPAN (untuk memahami konteks pertanyaan lanjutan):\n${transcript}\n` : ''}
PESAN SISWA:
${userMessage}`;

      // Gemini first; if it fails (quota, timeout, outage) DeepSeek answers instead. Both get
      // the identical guardrail prompt, so the fallback never loosens the tutoring rules.
      const providers: Array<['gemini' | 'deepseek', () => Promise<{ text: string; tokens: number }>]> = [];
      if (this.ai) providers.push(['gemini', () => this.generateWithGemini(systemPrompt, prompt)]);
      if (process.env.DEEPSEEK_API_KEY) {
        providers.push(['deepseek', () => this.generateWithDeepSeek(systemPrompt, prompt)]);
      }

      for (const [name, run] of providers) {
        try {
          const out = await run();
          if (!out.text.trim()) throw new Error('empty response');
          assistantReply = out.text;
          providerUsed = name;

          // Token usage tracking & tenant balance deduction
          tokensUsed += out.tokens;
          await prisma.tenant.update({
            where: { id: tenantId },
            data: { tokenBalance: { decrement: out.tokens } },
          });
          if (name !== providers[0][0]) console.warn(`[chat] answered by fallback provider '${name}'`);
          break;
        } catch (err: any) {
          console.warn(`[chat] ${name} generation failed:`, err?.message || err);
        }
      }

      // Providers are configured but every one failed: dumping a raw chunk as "the answer"
      // reads as an irrelevant reply, so say plainly that the coach is unavailable instead.
      if (!assistantReply) {
        assistantReply =
          'Maaf, aku lagi susah dihubungi nih. Coba kirim lagi pertanyaanmu sebentar lagi ya.';
      }
    }

    // Dev fallback: no AI provider configured at all (a configured-but-failing provider is handled above)
    if (!assistantReply) {
      if (!contextText.trim()) {
        assistantReply =
          'Hmm, itu belum ada di materi yang kupunya. Coba tanyakan bagian lain dari lesson ini ya.';
      } else if (effectiveAssessmentActive) {
        assistantReply = `Sebagai petunjuk untuk soal ini: Perhatikan konsep pada materi berikut: "${retrievedChunks[0]?.chunkText.slice(0, 100)}...". Coba ingat kembali langkah awalnya, bagaimana hubungan antara variabel atau angka tersebut?`;
      } else {
        assistantReply = `Berdasarkan materi modul Anda: ${retrievedChunks[0]?.chunkText} Semoga penjelasan ini membantu! Apakah ada bagian yang masih perlu diperjelas?`;
      }
    }

    // 4. Fish Audio Voice Synthesis (Optional ?voice=true)
    if (voiceRequested && assistantReply) {
      const fishKey = process.env.FISH_AUDIO_API_KEY;
      if (fishKey) {
        // Re-verify tenant balance before invoking external TTS API
        const currentTenant = await prisma.tenant.findUnique({
          where: { id: tenantId },
          select: { tokenBalance: true },
        });
        if (currentTenant && currentTenant.tokenBalance > 0) {
          finalAudioUrl = await this.generateVoiceFishAudio(assistantReply, baseUrl);
          if (finalAudioUrl) {
            // Conservative fixed estimation: Fish Audio TTS external API does not return token usage metadata.
            // Charge fixed 50 tokens per synthesized voice clip.
            const ttsCost = 50;
            tokensUsed += ttsCost;
            await prisma.tenant.update({
              where: { id: tenantId },
              data: { tokenBalance: { decrement: ttsCost } },
            });
          }
        }
      }
    }

    // 5. Save Assistant Message
    const assistantMsg = await prisma.chatMessage.create({
      data: {
        sessionId: session.id,
        sender: ChatSender.assistant,
        content: assistantReply,
        sourceContentIds,
        audioUrl: finalAudioUrl,
      },
    });

    return {
      message_id: assistantMsg.id,
      session_id: session.id,
      sender: 'assistant',
      content: assistantMsg.content,
      response: assistantMsg.content, // alias for frontend / python sdk compatibility
      socratic_guardrail: effectiveAssessmentActive,
      guardrail_trigger: guardrailTrigger,
      source_content_ids: assistantMsg.sourceContentIds,
      audio_url: assistantMsg.audioUrl,
      voice_audio_url: assistantMsg.audioUrl, // alias for frontend / python sdk compatibility
      tokens_used: tokensUsed,
      provider: providerUsed,
      created_at: assistantMsg.createdAt.toISOString(),
    };
  }

  private hasAnyProvider(): boolean {
    return this.ai !== null || Boolean(process.env.DEEPSEEK_API_KEY);
  }

  private async generateWithGemini(systemPrompt: string, prompt: string): Promise<{ text: string; tokens: number }> {
    if (!this.ai) throw new Error('Gemini is not configured');
    const contents = `${systemPrompt}\n\n${prompt}`;

    // Bounded wait: a hung call must not hold the learner's request open indefinitely.
    const res = await Promise.race([
      this.ai.models.generateContent({ model: 'gemini-2.5-flash', contents, config: { temperature: 0.7 } }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Gemini generation timed out after 45s')), 45000)
      ),
    ]);
    const text = res.text || '';
    // usageMetadata.totalTokenCount, or a conservative ~4 chars/token estimate if absent.
    const tokens = res.usageMetadata?.totalTokenCount ?? Math.max(1, Math.ceil((contents.length + text.length) / 4));
    return { text, tokens };
  }

  /** DeepSeek is OpenAI-compatible; model defaults to the current `deepseek-flash`. */
  private async generateWithDeepSeek(systemPrompt: string, prompt: string): Promise<{ text: string; tokens: number }> {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) throw new Error('DeepSeek is not configured');
    const baseUrl = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: process.env.DEEPSEEK_MODEL || 'deepseek-flash',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt },
          ],
          stream: false,
          temperature: 0.7,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`DeepSeek HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
      }
      const data: any = await res.json();
      const text: string = data?.choices?.[0]?.message?.content || '';
      const tokens: number =
        data?.usage?.total_tokens ?? Math.max(1, Math.ceil((systemPrompt.length + prompt.length + text.length) / 4));
      return { text, tokens };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Get session details and message history
   */
  async getSession(tenantId: string, sessionId: string) {
    const session = await prisma.chatSession.findUnique({
      where: { id: sessionId },
      include: {
        learner: true,
        messages: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!session || session.tenantId !== tenantId) {
      return null;
    }

    return {
      session_id: session.id,
      learner_id: session.learner.externalRef,
      scope: session.scope,
      title: session.title,
      created_at: session.createdAt.toISOString(),
      messages: session.messages.map((m) => ({
        id: m.id,
        sender: m.sender,
        content: m.content,
        source_content_ids: m.sourceContentIds,
        audio_url: m.audioUrl,
        created_at: m.createdAt.toISOString(),
      })),
    };
  }

  /**
   * Fish Audio TTS integration helper.
   * Fetches real audio stream from Fish Audio API and persists bytes to public/audio/<uuid>.mp3.
   * If FISH_AUDIO_API_KEY is not configured, returns null (no fake URLs).
   */
  private async generateVoiceFishAudio(text: string, baseUrl?: string): Promise<string | null> {
    const fishKey = process.env.FISH_AUDIO_API_KEY;
    if (!fishKey) {
      // Dev / unconfigured mode: do not generate audio and do not return fake URLs
      return null;
    }

    try {
      const res = await fetch('https://api.fish.audio/v1/tts', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${fishKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text,
          format: 'mp3',
        }),
      });

      if (!res.ok) {
        console.warn(`Fish Audio TTS request failed with HTTP ${res.status}: ${await res.text().catch(() => '')}`);
        return null;
      }

      // NOTE: Audio files in public/audio/ will accumulate continuously over time.
      // Followup task: Implement an automated cleanup strategy/retention policy (e.g. cron job or TTL-based purging for stale audio files).
      const audioDir = path.join(process.cwd(), 'public', 'audio');
      await fs.promises.mkdir(audioDir, { recursive: true });

      const fileId = randomUUID();
      const filename = `${fileId}.mp3`;
      const filePath = path.join(audioDir, filename);

      // Stream response body to disk
      if (res.body) {
        await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(filePath));
      } else {
        const buffer = Buffer.from(await res.arrayBuffer());
        await fs.promises.writeFile(filePath, buffer);
      }

      const audioPath = `/public/audio/${filename}`;
      return baseUrl ? `${baseUrl.replace(/\/+$/, '')}${audioPath}` : audioPath;
    } catch (err) {
      console.warn('Fish audio request failed:', err);
      return null;
    }
  }

  /**
   * Check if a learner message substantially matches an assessment question prompt (Option A)
   */
  private checkPromptOverlap(userText: string, promptText: string): boolean {
    const cleanUser = userText.toLowerCase().replace(/[^\w\s]/g, ' ').trim();
    const cleanPrompt = promptText.toLowerCase().replace(/[^\w\s]/g, ' ').trim();

    if (!cleanUser || !cleanPrompt) return false;

    // Direct substring match if substantial
    if (cleanPrompt.length >= 15 && cleanUser.includes(cleanPrompt)) return true;
    if (cleanUser.length >= 15 && cleanPrompt.includes(cleanUser)) return true;

    // Token set overlap
    const userWords = new Set(cleanUser.split(/\s+/).filter((w) => w.length >= 3));
    const promptWords = cleanPrompt.split(/\s+/).filter((w) => w.length >= 3);

    if (promptWords.length === 0 || userWords.size === 0) return false;

    let matchCount = 0;
    for (const pw of promptWords) {
      if (userWords.has(pw)) {
        matchCount++;
      }
    }

    const ratio = matchCount / promptWords.length;
    // Over 40% of prompt keywords match, or 4+ distinct matching keywords
    return (ratio >= 0.4 && matchCount >= 2) || matchCount >= 4;
  }
}

export const chatService = new ChatService();
