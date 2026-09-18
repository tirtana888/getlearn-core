import { prisma } from '../src/lib/prisma.js';

async function main() {
  console.log('Connecting to PostgreSQL and creating vector extension...');
  await prisma.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS vector;');
  const result: any = await prisma.$queryRawUnsafe("SELECT extname, extversion FROM pg_extension WHERE extname = 'vector';");
  console.log('✅ pgvector extension is active:', result);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
