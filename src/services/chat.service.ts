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
      ? `Halo! Saya AI Study Coach Anda. Berdasarkan catatan progres belajar Anda, saya siap mendampingi Anda mendalami materi "${focusObjectiveLabel}". Ada konsep atau bagian yang ingin kita bahas bersama hari ini?`
      : 'Halo! Saya AI Study Coach getlearn Anda. Ada materi pelajaran atau konsep yang ingin kita diskusikan hari ini?';

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
    let retrievedChunks: Awaited<ReturnType<typeof ragService.searchSimilarChunks>> = [];
    const lastSources = isShortFollowUp
      ? [...history].reverse().find((m) => m.sender === ChatSender.assistant && m.sourceContentIds.length > 0)
          ?.sourceContentIds
      : undefined;
    if (lastSources && lastSources.length > 0) {
      const allowed = scopedContentIds ? lastSources.filter((id) => scopedContentIds!.includes(id)) : lastSources;
      if (allowed.length > 0) {
        retrievedChunks = await ragService.searchSimilarChunks(tenantId, retrievalQuery, 4, activeThreshold, allowed);
      }
    }
    if (retrievedChunks.length === 0) {
      retrievedChunks = await ragService.searchSimilarChunks(
        tenantId,
        retrievalQuery,
        4,
        activeThreshold,
        scopedContentIds
      );
    }
    const sourceContentIds = Array.from(new Set(retrievedChunks.map((c) => c.contentItemId)));

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

    if (this.ai && contextText.trim()) {
      try {
        const systemPrompt = `Anda adalah AI Study Coach getlearn.ai yang ramah, mendidik, dan membimbing.
ATURAN GUARDRAIL KETAT:
1. Wajib menjawab HANYA berdasarkan materi pelajaran yang diberikan di bawah.
2. Jika informasi tidak ada di dalam materi pelajaran, katakan secara jujur dan sopan: "Materi ini belum tercakup dalam modul pelajaran Anda." JANGAN mengarang jawaban dari pengetahuan umum.
3. ${
          effectiveAssessmentActive
            ? 'PERINGATAN: Siswa sedang mengerjakan soal/asesmen aktif! JANGAN PERNAH berikan jawaban langsung/final. Gunakan metode Socratic: berikan hint, pertanyaan pengarah, atau tunjukkan rumus/konsep yang relevan agar siswa berpikir sendiri.'
            : 'Jelaskan konsep dengan jelas, bertahap, dan mudah dimengerti.'
        }
4. Jawab dalam Bahasa Indonesia yang santun dan menyemangati.`;

        const transcript = history
          .map((m) => `${m.sender === ChatSender.user ? 'SISWA' : 'COACH'}: ${m.content.slice(0, 600)}`)
          .join('\n');

        const prompt = `MATERI PELAJARAN:
${contextText}
${transcript ? `\nRIWAYAT PERCAKAPAN (untuk memahami konteks pertanyaan lanjutan):\n${transcript}\n` : ''}
PERTANYAAN SISWA:
${userMessage}`;

        // Bounded wait: a hung Gemini call must not hold the learner's request open indefinitely.
        const modelRes = await Promise.race([
          this.ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: `${systemPrompt}\n\n${prompt}`,
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Gemini generation timed out after 45s')), 45000)
          ),
        ]);

        assistantReply = modelRes.text || '';

        // Token usage tracking & tenant balance deduction
        // @google/genai provides usageMetadata.totalTokenCount
        const genTokens = modelRes.usageMetadata?.totalTokenCount 
          ?? Math.max(1, Math.ceil((`${systemPrompt}\n\n${prompt}`.length + assistantReply.length) / 4)); // Conservative estimate if usageMetadata is absent

        tokensUsed += genTokens;
        await prisma.tenant.update({
          where: { id: tenantId },
          data: { tokenBalance: { decrement: genTokens } },
        });
      } catch (err) {
        console.warn('Gemini text generation failed:', err);
        // With Gemini configured, dumping a raw chunk as "the answer" reads as an irrelevant
        // reply, so say plainly that the coach is unavailable instead.
        assistantReply =
          'Maaf, AI Study Coach sedang sulit dijangkau. Silakan coba kirim pertanyaanmu lagi sebentar lagi.';
      }
    }

    // Fallback response if Gemini API key absent or generation failed
    if (!assistantReply) {
      if (!contextText.trim()) {
        assistantReply =
          'Maaf, materi terkait pertanyaan ini belum tercakup dalam modul pelajaran Anda. Silakan tanyakan materi lain yang ada di kurikulum.';
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
      created_at: assistantMsg.createdAt.toISOString(),
    };
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
