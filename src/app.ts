import Fastify from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { objectiveRoutes } from './modules/objectives/routes.js';
import { contentItemRoutes } from './modules/content-items/routes.js';
import { assessmentItemRoutes } from './modules/assessment-items/routes.js';
import { eventRoutes } from './modules/events/routes.js';
import { learnerRoutes } from './modules/learners/routes.js';
import { adminRoutes } from './modules/admin/routes.js';

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

  // Health check route
  app.get('/health', async () => {
    return {
      status: 'ok',
      service: 'getlearn-core',
      timestamp: new Date().toISOString(),
    };
  });

  // Register feature modules
  await app.register(adminRoutes);
  await app.register(objectiveRoutes);
  await app.register(contentItemRoutes);
  await app.register(assessmentItemRoutes);
  await app.register(eventRoutes);
  await app.register(learnerRoutes);

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
