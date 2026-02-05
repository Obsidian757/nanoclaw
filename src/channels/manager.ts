import { Channel, IncomingMessage } from './types.js';

export class ChannelManager {
  private channels: Map<string, Channel> = new Map();
  private messageHandler?: (msg: IncomingMessage) => void;

  async registerChannel(channel: Channel): Promise<void> {
    await channel.initialize();
    this.channels.set(channel.type, channel);
    
    channel.onMessage((msg) => {
      if (this.messageHandler) {
        this.messageHandler(msg);
      }
    });
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandler = handler;
  }

  async sendMessage(channelType: string, chatId: string, text: string): Promise<void> {
    const channel = this.channels.get(channelType);
    if (channel) {
      await channel.sendMessage(chatId, text);
    }
  }
}
