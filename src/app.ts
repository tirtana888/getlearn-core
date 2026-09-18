import Fastify from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import path from 'path';
import fastifyStatic from '@fastify/static';
import { objectiveRoutes } from './modules/objectives/routes.js';
import { contentItemRoutes } from './modules/content-items/routes.js';
import { assessmentItemRoutes } from './modules/assessment-items/routes.js';
import { eventRoutes } from './modules/events/routes.js';
import { learnerRoutes } from './modules/learners/routes.js';
import { adminRoutes } from './modules/admin/routes.js';
import { chatRoutes } from './modules/chat/routes.js';
import { analyticsRoutes } from './modules/analytics/routes.js';

export async function buildApp() {
  const app = Fastify({
    logger: true,
  });

  // CORS
  await app.register(cors, {
    origin: '*',
  });

  // Swagger Documentation
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'getlearn.ai Core API',
        description: 'Learner Intelligence Infrastructure canonical API',
        version: '1.0.0',
      },
      servers: [
        {
          url: 'http://localhost:3000',
          description: 'Local Development Server',
        },
      ],
      components: {
        securitySchemes: {
          BearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'APIKey',
          },
        },
      },
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
    },
  });

  // Register static assets
  await app.register(fastifyStatic, {
    root: path.join(process.cwd(), 'public'),
    prefix: '/public/',
  });

  // Audio files route alias (/audio/:filename -> public/audio/:filename)
  app.get('/audio/:filename', async (req, reply) => {
    const { filename } = req.params as { filename: string };
    return reply.sendFile(`audio/${filename}`);
  });

  // Health check route
  app.get('/health', async () => {
    return {
      status: 'ok',
      service: 'getlearn-core',
      timestamp: new Date().toISOString(),
    };
  });

  // Web Frontend Portal Routes
  app.get('/dashboard', async (req, reply) => {
    return reply.sendFile('dashboard/index.html');
  });
  app.get('/dashboard/', async (req, reply) => {
    return reply.sendFile('dashboard/index.html');
  });

  app.get('/superadmin', async (req, reply) => {
    return reply.sendFile('superadmin/index.html');
  });
  app.get('/superadmin/', async (req, reply) => {
    return reply.sendFile('superadmin/index.html');
  });

  app.get('/', async (req, reply) => {
    return reply.redirect('/dashboard');
  });

  // Register feature modules
  await app.register(adminRoutes);
  await app.register(analyticsRoutes);
  await app.register(objectiveRoutes);
  await app.register(contentItemRoutes);
  await app.register(assessmentItemRoutes);
  await app.register(eventRoutes);
  await app.register(learnerRoutes);
  await app.register(chatRoutes);

  // Global Error Handler
  app.setErrorHandler((error, request, reply) => {
    app.log.error(error);
    reply.status(error.statusCode || 500).send({
      error: {
        code: error.code || 'INTERNAL_SERVER_ERROR',
        message: error.message || 'An unexpected error occurred.',
      },
    });
  });

  return app;
}
