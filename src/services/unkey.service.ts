import { Unkey } from '@unkey/api';
import * as unkeyErrors from '@unkey/api/models/errors';
import { config } from '../config/env.js';
import { prisma } from '../lib/prisma.js';

export interface IssueKeyOptions {
  ratelimit?: {
    limit?: number;
    duration?: number;
  };
}

export interface VerificationResult {
  valid: boolean;
  tenantId?: string;
  error?: string;
  code?: string;
  ratelimit?: {
    limit: number;
    remaining: number;
    reset: number;
  };
}

export class UnkeyService {
  private unkeyClient: Unkey | null = null;

  constructor() {
    if (config.unkeyRootKey) {
      this.unkeyClient = new Unkey({ rootKey: config.unkeyRootKey });
    }
  }

  async verify(apiKey: string): Promise<VerificationResult> {
    // 1. Configured dev/testing key (strictly disallowed in production; requires explicit config)
    if (config.nodeEnv !== 'production' && config.devApiKey && apiKey === config.devApiKey) {
      // Ensure default tenant exists
      const devTenant = await prisma.tenant.upsert({
        where: { id: 'ten_dev_nusadaya' },
        update: {},
        create: {
          id: 'ten_dev_nusadaya',
          name: 'Nusadaya Academy',
          tokenBalance: 500000,
        },
      });
      return { valid: true, tenantId: devTenant.id };
    }

    // 2. Unkey v2 verification if configured (SDK 2.x targets api.unkey.com, not the retired api.unkey.dev)
    if (this.unkeyClient) {
      try {
        const { data } = await this.unkeyClient.keys.verifyKey({ key: apiKey });

        if (!data.valid) {
          const message =
            data.code === 'RATE_LIMITED'
              ? 'Rate limit exceeded. Please retry later.'
              : data.code === 'USAGE_EXCEEDED'
                ? 'Key usage limit exceeded'
                : data.code || 'Key verification failed';
          return { valid: false, code: data.code, error: message };
        }

        if (!data.meta || typeof data.meta.tenantId !== 'string') {
          return { valid: false, error: 'Key does not contain valid tenant metadata' };
        }

        const appliedLimit = data.ratelimits?.find((r) => r.autoApply) ?? data.ratelimits?.[0];

        return {
          valid: true,
          tenantId: data.meta.tenantId,
          ratelimit: appliedLimit
            ? {
                limit: appliedLimit.limit,
                remaining: appliedLimit.remaining,
                reset: appliedLimit.reset,
              }
            : undefined,
        };
      } catch (err: any) {
        if (err instanceof unkeyErrors.TooManyRequestsErrorResponse) {
          return { valid: false, code: 'RATE_LIMITED', error: 'Rate limit exceeded. Please retry later.' };
        }
        if (err instanceof unkeyErrors.UnkeyError) {
          return { valid: false, error: err.message };
        }
        return { valid: false, error: err.message || 'Unkey verification failed' };
      }
    }

    // 3. Fallback: Lookup key in local dev tenant id direct matching (strictly non-production only)
    if (config.nodeEnv !== 'production') {
      const tenant = await prisma.tenant.findUnique({
        where: { id: apiKey },
      });
      if (tenant) {
        return { valid: true, tenantId: tenant.id };
      }
    }

    return { valid: false, error: 'Invalid API key or Unkey service unconfigured' };
  }

  async issueKey(
    tenantId: string,
    tenantName: string,
    options?: IssueKeyOptions
  ): Promise<string> {
    if (this.unkeyClient && config.unkeyApiId) {
      try {
        const { data } = await this.unkeyClient.keys.createKey({
          apiId: config.unkeyApiId,
          prefix: 'gl',
          meta: { tenantId },
          name: `Key for ${tenantName}`,
          ratelimits: [
            {
              name: 'default',
              limit: options?.ratelimit?.limit ?? config.rateLimitRequests,
              duration: options?.ratelimit?.duration ?? config.rateLimitDurationMs,
              autoApply: true,
            },
          ],
        });
        return data.key;
      } catch (err: any) {
        const message = err instanceof unkeyErrors.UnkeyError ? err.message : err.message || String(err);
        throw new Error(`Failed to issue key via Unkey: ${message}`);
      }
    }

    if (config.nodeEnv === 'production') {
      throw new Error('Cannot issue API key: Unkey service is unconfigured in production');
    }

    // Fallback pseudo-key for dev environments
    return `gl_dev_${tenantId}_${Date.now()}`;
  }
}

export const unkeyService = new UnkeyService();
