import { prisma } from '../lib/db.js';
import { configStore } from '../infrastructure/redis/UpstashConfigStore.js';
import type { AIConfigSourceData } from '../types/config.js';

export class RuntimeConfigService {
  private memoryCache: {
    aiConfigSource: AIConfigSourceData | null;
    expiresAt: number;
  } = { aiConfigSource: null, expiresAt: 0 };

  // Local memory cache TTL (short to minimize stale data when Redis updates)
  private readonly MEMORY_TTL_MS = 10 * 1000;
  // Redis cache TTL
  private readonly REDIS_TTL_SEC = 60;

  async getAiConfigSource(): Promise<AIConfigSourceData> {
    const now = Date.now();

    // 1. Check L1 Memory Cache
    if (this.memoryCache.aiConfigSource && now < this.memoryCache.expiresAt) {
      return this.memoryCache.aiConfigSource;
    }

    // 2. Check L2 Redis Cache
    let config = await configStore.getConfig('ai_config_source');

    if (config) {
      this.updateMemoryCache(config, now);
      return config;
    }

    // 3. Check L3 Database (Supabase)
    const dbRow = await prisma.miniappRuntimeConfig.findUnique({
      where: { key: 'ai_config_source' },
    });

    if (dbRow && dbRow.value) {
      config = dbRow.value as unknown as AIConfigSourceData;

      // Asynchronously update Redis (fire-and-forget)
      configStore.setConfig('ai_config_source', config, this.REDIS_TTL_SEC).catch(console.error);

      // Update memory cache
      this.updateMemoryCache(config, now);
      return config;
    }

    // 4. Ultimate Fallback (Default to environment variables)
    return this.getFallbackEnvConfig();
  }

  private updateMemoryCache(config: AIConfigSourceData, now: number) {
    this.memoryCache.aiConfigSource = config;
    this.memoryCache.expiresAt = now + this.MEMORY_TTL_MS;
  }

  private getFallbackEnvConfig(): AIConfigSourceData {
    const url = process.env.OPENAI_API_BASE_URL || 'https://api.openai.com/v1/chat/completions';
    const key = process.env.OPENAI_API_KEY || '';
    const model = process.env.OPENAI_MODEL || 'gpt-3.5-turbo';

    return {
      tier_mapping: {
        tier_1: 'channel_default',
        tier_2: 'channel_default',
        tier_3: 'channel_default',
        tier_4: 'channel_default',
      },
      channels: {
        channel_default: [
          {
            id: 'step_1',
            provider: 'openai',
            url: url,
            key: key,
            model: model,
          },
        ],
      },
    };
  }
}

export const runtimeConfigService = new RuntimeConfigService();
