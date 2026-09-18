import { Tenant } from '@prisma/client';

declare module 'fastify' {
  interface FastifyRequest {
    tenantId: string;
    tenant: Tenant;
  }
}
