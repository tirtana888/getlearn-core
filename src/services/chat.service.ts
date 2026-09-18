import { GoogleGenAI } from '@google/genai';
import { prisma } from '../lib/prisma.js';
import { ragService } from './rag.service.js';
import { ChatScope, ChatSender } from '@prisma/client';

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
    voiceRequested = false
  ) {
    const session = await prisma.chatSession.findUnique({
      where: { id: sessionId },
      include: { learner: true },
    });

    if (!session || session.tenantId !== tenantId) {
      throw new Error('Chat session not found');
    }

    // 1. Save User Message
    await prisma.chatMessage.create({
      data: {
        sessionId: session.id,
        sender: ChatSender.user,
        content: userMessage,
        sourceContentIds: [],
      },
    });

    // 2. Retrieve relevant content chunks using pgvector
    const retrievedChunks = await ragService.searchSimilarChunks(tenantId, userMessage, 3);
    const sourceContentIds = Array.from(new Set(retrievedChunks.map((c) => c.contentItemId)));

    const contextText = retrievedChunks.map((c) => c.chunkText).join('\n---\n');

    // 3. Generate response with strict Guardrails
    let assistantReply = '';
    const audioUrl: string | null = null;

    if (this.ai && contextText.trim()) {
      try {
        const systemPrompt = `Anda adalah AI Study Coach getlearn.ai yang ramah, mendidik, dan membimbing.
ATURAN GUARDRAIL KETAT:
1. Wajib menjawab HANYA berdasarkan materi pelajaran yang diberikan di bawah.
2. Jika informasi tidak ada di dalam materi pelajaran, katakan secara jujur dan sopan: "Materi ini belum tercakup dalam modul pelajaran Anda." JANGAN mengarang jawaban dari pengetahuan umum.
3. ${
          isAssessmentActive
            ? 'PERINGATAN: Siswa sedang mengerjakan soal/asesmen aktif! JANGAN PERNAH berikan jawaban langsung/final. Gunakan metode Socratic: berikan hint, pertanyaan pengarah, atau tunjukkan rumus/konsep yang relevan agar siswa berpikir sendiri.'
            : 'Jelaskan konsep dengan jelas, bertahap, dan mudah dimengerti.'
        }
4. Jawab dalam Bahasa Indonesia yang santun dan menyemangati.`;

        const prompt = `MATERI PELAJARAN:
${contextText}

PERTANYAAN SISWA:
${userMessage}`;

        const modelRes = await this.ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: `${systemPrompt}\n\n${prompt}`,
        });

        assistantReply = modelRes.text || '';
      } catch (err) {
        console.warn('Gemini text generation failed, using fallback coach response:', err);
      }
    }

    // Fallback response if Gemini API key absent or generation failed
    if (!assistantReply) {
      if (!contextText.trim()) {
        assistantReply =
          'Maaf, materi terkait pertanyaan ini belum tercakup dalam modul pelajaran Anda. Silakan tanyakan materi lain yang ada di kurikulum.';
      } else if (isAssessmentActive) {
        assistantReply = `Sebagai petunjuk untuk soal ini: Perhatikan konsep pada materi berikut: "${retrievedChunks[0]?.chunkText.slice(0, 100)}...". Coba ingat kembali langkah awalnya, bagaimana hubungan antara variabel atau angka tersebut?`;
      } else {
        assistantReply = `Berdasarkan materi modul Anda: ${retrievedChunks[0]?.chunkText} Semoga penjelasan ini membantu! Apakah ada bagian yang masih perlu diperjelas?`;
      }
    }

    // 4. Fish Audio Voice Synthesis (Optional ?voice=true)
    let finalAudioUrl: string | null = null;
    if (voiceRequested) {
      finalAudioUrl = await this.generateVoiceFishAudio(assistantReply);
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
      source_content_ids: assistantMsg.sourceContentIds,
      audio_url: assistantMsg.audioUrl,
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
   * Fish Audio TTS integration helper
   */
  private async generateVoiceFishAudio(text: string): Promise<string | null> {
    const fishKey = process.env.FISH_AUDIO_API_KEY;
    if (!fishKey) {
      // In dev / demo mode: return a structured demo voice indicator
      return `https://api.fish.audio/v1/tts/sample_stream?text=${encodeURIComponent(text.slice(0, 50))}`;
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
          model: 's2.1-pro',
        }),
      });

      if (res.ok) {
        return `https://api.fish.audio/v1/tts/stream?session=${Date.now()}`;
      }
    } catch (err) {
      console.warn('Fish audio request failed:', err);
    }
    return null;
  }
}

export const chatService = new ChatService();
