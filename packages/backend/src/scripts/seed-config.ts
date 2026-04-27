import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';

// Load environment variables from .env
dotenv.config();

const prisma = new PrismaClient();

const initialConfig = {
  tier_mapping: {
    free: 'channel_default',
    vip: 'channel_default',
  },
  channels: {
    channel_default: [
      {
        id: 'step_1',
        provider: 'openai',
        url: process.env.OPENAI_API_BASE_URL || 'https://openrouter.ai/api/v1/chat/completions',
        key: process.env.OPENAI_API_KEY || '',
        model: process.env.OPENAI_MODEL || 'google/gemini-3-flash-preview',
      },
    ],
  },
};

async function main() {
  console.log('🚀 Seeding runtime config to Supabase...');

  // Create table if it doesn't exist to bypass `prisma db push` issues with other tables
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS public.runtime_config (
      key TEXT PRIMARY KEY,
      value JSONB,
      description TEXT,
      version INTEGER DEFAULT 1,
      updated_at TIMESTAMPTZ(6) DEFAULT now(),
      text_value TEXT
    );
  `);

  const result = await prisma.runtime_config.upsert({
    where: { key: 'ai_config_source' },
    update: {
      value: initialConfig,
      description: 'AI Channel routing configuration',
    },
    create: {
      key: 'ai_config_source',
      value: initialConfig,
      description: 'AI Channel routing configuration',
    },
  });

  console.log('✅ Seed success!');
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((e) => {
    console.error('❌ Seed error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
