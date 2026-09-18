import { FastifyReply, FastifyRequest } from 'fastify';
import { unkeyService } from '../services/unkey.service.js';
import { prisma } from '../lib/prisma.js';

export async function authMiddleware(req: FastifyRequest, reply: FastifyReply) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return reply.status(401).send({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Missing or malformed Authorization header. Expected Bearer <token>.',
      },
    });
  }

  const token = authHeader.replace('Bearer ', '').trim();
  const verification = await unkeyService.verify(token);

  if (verification.code === 'RATE_LIMITED') {
    if (verification.ratelimit) {
      reply.header('X-RateLimit-Limit', verification.ratelimit.limit);
      reply.header('X-RateLimit-Remaining', verification.ratelimit.remaining);
      reply.header('X-RateLimit-Reset', verification.ratelimit.reset);
    }
    return reply.status(429).send({
      error: {
        code: 'RATE_LIMITED',
        message: verification.error || 'Rate limit exceeded. Please retry later.',
      },
    });
  }

  if (!verification.valid || !verification.tenantId) {
    return reply.status(401).send({
      error: {
        code: 'UNAUTHORIZED',
        message: verification.error || 'Invalid API key',
      },
    });
  }

  const tenant = await prisma.tenant.findUnique({
    where: { id: verification.tenantId },
  });

  if (!tenant) {
    return reply.status(401).send({
      error: {
        code: 'TENANT_NOT_FOUND',
        message: 'The tenant associated with this API key does not exist.',
      },
    });
  }

  req.tenantId = tenant.id;
  req.tenant = tenant;
}
