import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  databaseUrl: process.env.DATABASE_URL || '',
  devApiKey: process.env.DEV_API_KEY || 'dev-nusadaya-key',
  unkeyRootKey: process.env.UNKEY_ROOT_KEY || '',
  unkeyApiId: process.env.UNKEY_API_ID || '',
};
