import { buildApp } from './app.js';
import { config } from './config/env.js';

async function start() {
  try {
    const app = await buildApp();
    await app.listen({ port: config.port, host: '0.0.0.0' });
    console.log(`🚀 getlearn.ai Core Server running on http://localhost:${config.port}`);
    console.log(`📚 Swagger documentation available at http://localhost:${config.port}/docs`);
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
