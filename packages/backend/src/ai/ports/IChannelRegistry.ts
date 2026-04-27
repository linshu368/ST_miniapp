import type { IAIChannel } from './IAIChannel.js';

export interface IChannelRegistry {
  getChannel(channelId: string): Promise<IAIChannel | undefined>;
}
