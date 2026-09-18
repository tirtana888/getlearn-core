import { verifyKey, Unkey } from '@unkey/api';
import { config } from '../config/env.js';
import { prisma } from '../lib/prisma.js';

export class UnkeyService {
  private unkeyClient: Unkey | null = null;

  constructor() {
    if (config.unkeyRootKey) {
      this.unkeyClient = new Unkey({ rootKey: config.unkeyRootKey });
    }
  }

  async verify(apiKey: string): Promise<{ valid: boolean; tenantId?: string; error?: string }> {
    // 1. Development / Testing Key bypass
    if (config.nodeEnv !== 'production' && apiKey === config.devApiKey) {
      // Ensure default dev tenant exists
      const devTenant = await prisma.tenant.upsert({
        where: { id: 'ten_dev_nusadaya' },
        update: {},
        create: {
          id: 'ten_dev_nusadaya',
          name: 'Nusadaya Academy (Dev)',
          tokenBalance: 500000,
        },
      });
      return { valid: true, tenantId: devTenant.id };
    }

    // 2. Unkey Verification if configured
    if (this.unkeyClient) {
      try {
        const { result, error } = await verifyKey(apiKey);
        if (error) {
          return { valid: false, error: error.message };
        }
        if (result.valid && result.meta && typeof result.meta.tenantId === 'string') {
          return { valid: true, tenantId: result.meta.tenantId };
        }
        return { valid: false, error: 'Key does not contain valid tenant metadata' };
      } catch (err: any) {
        return { valid: false, error: err.message };
      }
    }

    // 3. Fallback: Lookup key in local dev tenant id direct matching
    const tenant = await prisma.tenant.findUnique({
      where: { id: apiKey },
    });
    if (tenant) {
      return { valid: true, tenantId: tenant.id };
    }

    return { valid: false, error: 'Invalid API key or Unkey service unconfigured' };
  }

  async issueKey(tenantId: string, tenantName: string): Promise<string> {
    if (this.unkeyClient && config.unkeyApiId) {
      const created = await this.unkeyClient.keys.create({
        apiId: config.unkeyApiId,
        prefix: 'gl',
        meta: { tenantId },
        name: `Key for ${tenantName}`,
      });
      if (created.result?.key) {
        return created.result.key;
      }
    }
    // Fallback pseudo-key for dev environments
    return `gl_dev_${tenantId}_${Date.now()}`;
  }
}

export const unkeyService = new UnkeyService();
