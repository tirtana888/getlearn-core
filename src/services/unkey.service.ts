import { verifyKey, Unkey } from '@unkey/api';
import { config } from '../config/env.js';
import { prisma } from '../lib/prisma.js';

export interface IssueKeyOptions {
  ratelimit?: {
    type?: 'fast' | 'consistent';
    limit?: number;
    refillRate?: number;
    refillInterval?: number;
  };
}

export interface VerificationResult {
  valid: boolean;
  tenantId?: string;
  error?: string;
  code?: 'NOT_FOUND' | 'FORBIDDEN' | 'USAGE_EXCEEDED' | 'RATE_LIMITED' | string;
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

    // 2. Unkey Verification if configured
    if (this.unkeyClient) {
      try {
        const verifyPayload = config.unkeyApiId
          ? { key: apiKey, apiId: config.unkeyApiId }
          : apiKey;
        const { result, error } = await verifyKey(verifyPayload);
        if (error) {
          return { valid: false, error: error.message };
        }
        if (result.code === 'RATE_LIMITED') {
          return {
            valid: false,
            code: 'RATE_LIMITED',
            error: 'Rate limit exceeded. Please retry later.',
            ratelimit: result.ratelimit,
          };
        }
        if (result.valid && result.meta && typeof result.meta.tenantId === 'string') {
          return {
            valid: true,
            tenantId: result.meta.tenantId,
            ratelimit: result.ratelimit,
          };
        }
        return {
          valid: false,
          code: result.code,
          error: result.code === 'USAGE_EXCEEDED'
            ? 'Key usage limit exceeded'
            : (result.code || 'Key does not contain valid tenant metadata'),
          ratelimit: result.ratelimit,
        };
      } catch (err: any) {
        return { valid: false, error: err.message };
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
      const ratelimitConfig = options?.ratelimit ? {
        type: options.ratelimit.type ?? ('fast' as const),
        limit: options.ratelimit.limit ?? config.rateLimitRequests,
        refillRate: options.ratelimit.refillRate ?? config.rateLimitRequests,
        refillInterval: options.ratelimit.refillInterval ?? config.rateLimitDurationMs,
      } : {
        type: 'fast' as const,
        limit: config.rateLimitRequests,
        refillRate: config.rateLimitRequests,
        refillInterval: config.rateLimitDurationMs,
      };

      const created = await this.unkeyClient.keys.create({
        apiId: config.unkeyApiId,
        prefix: 'gl',
        meta: { tenantId },
        name: `Key for ${tenantName}`,
        ratelimit: ratelimitConfig,
      });
      if (created.result?.key) {
        return created.result.key;
      }
      if (created.error) {
        throw new Error(`Failed to issue key via Unkey: ${created.error.message}`);
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
