import type { IChannelRegistry } from './ports/IChannelRegistry.js';
import type { IAIChannel } from './ports/IAIChannel.js';
import { PipelineChannel } from './channels/PipelineChannel.js';
import { runtimeConfigService } from '../services/RuntimeConfigService.js';

export class ChannelRegistry implements IChannelRegistry {
  async getChannel(channelId: string): Promise<IAIChannel | undefined> {
    const config = await runtimeConfigService.getAiConfigSource();
    const steps = config.channels?.[channelId];

    if (!steps || steps.length === 0) {
      // Fallback configuration if channel is not found
      return this.getEnvFallbackChannel(channelId);
    }

    return new PipelineChannel(channelId, steps);
  }

  private getEnvFallbackChannel(channelId: string): IAIChannel {
    const url = process.env.OPENAI_API_BASE_URL || 'https://api.openai.com/v1/chat/completions';
    const key = process.env.OPENAI_API_KEY || '';
    const model = process.env.OPENAI_MODEL || 'gpt-3.5-turbo';

    const steps = [
      {
        id: 'step_1',
        provider: 'openai',
        url: url,
        key: key,
        model: model,
      },
    ];

    return new PipelineChannel(channelId, steps);
  }
}

export const channelRegistry = new ChannelRegistry();
