import crypto from 'crypto';
import { prisma } from '../lib/prisma.js';
import { eventsService } from './events.service.js';

interface FrappeQuizResultRow {
  name: string;
  question: string;
  question_name: string;
  answer: string;
  is_correct: number;
}

interface FrappeQuizSubmissionDetail {
  name: string;
  member: string;
  quiz: string;
  creation: string;
  result: FrappeQuizResultRow[];
}

export interface SyncResult {
  submissionsSeen: number;
  eventsIngested: number;
  errors: number;
}

export class FrappeSyncService {
  /**
   * Deterministic, one-way, PII-free learner id - never sends the Frappe
   * User docname (which is typically the learner's real email) to getlearn.
   */
  anonymizeLearnerId(member: string): string {
    return 'frappe_' + crypto.createHash('sha256').update(member).digest('hex').slice(0, 32);
  }

  private authHeader(apiKey: string, apiSecret: string): string {
    return `token ${apiKey}:${apiSecret}`;
  }

  async syncTenant(tenantId: string): Promise<SyncResult> {
    const connection = await prisma.frappeConnection.findUnique({ where: { tenantId } });
    if (!connection || !connection.enabled) {
      return { submissionsSeen: 0, eventsIngested: 0, errors: 0 };
    }

    const since = connection.lastSyncedAt ?? new Date(0);
    const result: SyncResult = { submissionsSeen: 0, eventsIngested: 0, errors: 0 };
    let latestCreation = since;

    try {
      const names = await this.fetchSubmissionNamesSince(
        connection.baseUrl,
        connection.apiKey,
        connection.apiSecret,
        since
      );

      for (const name of names) {
        result.submissionsSeen++;
        try {
          const submission = await this.fetchSubmissionDetail(
            connection.baseUrl,
            connection.apiKey,
            connection.apiSecret,
            name
          );

          const creation = new Date(submission.creation);
          if (creation > latestCreation) latestCreation = creation;

          const learnerId = this.anonymizeLearnerId(submission.member);

          for (const row of submission.result || []) {
            if (!row.question_name) continue; // can't map to a canonical item without a stable id
            const ingested = await eventsService.ingestEvent(tenantId, {
              event_id: `frappe_qr_${row.name}`,
              event_type: 'assessment.answered',
              external_learner_id: learnerId,
              occurred_at: submission.creation,
              payload: {
                item_id: row.question_name,
                is_correct: Boolean(row.is_correct),
                raw_response: row.answer,
              },
            });
            if (ingested.status === 'processed') {
              result.eventsIngested++;
            }
          }
        } catch (err: any) {
          result.errors++;
          await this.recordError(tenantId, `submission ${name}: ${err.message || err}`);
        }
      }

      await prisma.frappeConnection.update({
        where: { tenantId },
        data: {
          lastSyncedAt: latestCreation,
          lastSyncError: result.errors > 0 ? `${result.errors} submission(s) failed during last sync` : null,
        },
      });
    } catch (err: any) {
      result.errors++;
      await this.recordError(tenantId, `fetch failed: ${err.message || err}`);
    }

    return result;
  }

  private async recordError(tenantId: string, message: string) {
    await prisma.frappeConnection
      .update({ where: { tenantId }, data: { lastSyncError: message } })
      .catch(() => {});
  }

  private async fetchSubmissionNamesSince(
    baseUrl: string,
    apiKey: string,
    apiSecret: string,
    since: Date
  ): Promise<string[]> {
    const filters = encodeURIComponent(JSON.stringify([['creation', '>', since.toISOString()]]));
    const fields = encodeURIComponent(JSON.stringify(['name']));
    const url =
      `${baseUrl.replace(/\/$/, '')}/api/resource/LMS Quiz Submission` +
      `?filters=${filters}&fields=${fields}&limit_page_length=0&order_by=creation asc`;

    const res = await fetch(url, { headers: { Authorization: this.authHeader(apiKey, apiSecret) } });
    if (!res.ok) {
      throw new Error(`Frappe API error ${res.status} listing LMS Quiz Submission: ${await res.text()}`);
    }
    const data: any = await res.json();
    return (data.data || []).map((r: any) => r.name);
  }

  private async fetchSubmissionDetail(
    baseUrl: string,
    apiKey: string,
    apiSecret: string,
    name: string
  ): Promise<FrappeQuizSubmissionDetail> {
    const url = `${baseUrl.replace(/\/$/, '')}/api/resource/LMS Quiz Submission/${encodeURIComponent(name)}`;
    const res = await fetch(url, { headers: { Authorization: this.authHeader(apiKey, apiSecret) } });
    if (!res.ok) {
      throw new Error(`Frappe API error ${res.status} fetching submission ${name}: ${await res.text()}`);
    }
    const data: any = await res.json();
    return data.data;
  }
}

export const frappeSyncService = new FrappeSyncService();
