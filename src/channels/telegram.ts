import TelegramBot from 'node-telegram-bot-api';
import { Channel, IncomingMessage } from './types.js';
import { logger } from '../logger.js';

export class TelegramChannel implements Channel {
  readonly name = 'Telegram';
  readonly type = 'telegram';
  private bot: TelegramBot;
  private messageHandler?: (msg: IncomingMessage) => void;

  constructor(token: string) {
    this.bot = new TelegramBot(token, { polling: true });
  }

  async initialize(): Promise<void> {
    logger.info('Telegram bot initialized');
    
    this.bot.on('message', (msg) => {
      if (!this.messageHandler) return;
      
      const incoming: IncomingMessage = {
        id: msg.message_id.toString(),
        channel: 'telegram',
        chatId: msg.chat.id.toString(),
        chatName: msg.chat.title || msg.chat.username || 'Private',
        senderId: msg.from?.id.toString() || 'unknown',
        senderName: msg.from?.username || msg.from?.first_name || 'Unknown',
        content: msg.text || '',
        timestamp: new Date(msg.date * 1000),
        isFromMe: false,
        isGroup: msg.chat.type === 'group' || msg.chat.type === 'supergroup',
      };
      
      this.messageHandler(incoming);
    });
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    await this.bot.sendMessage(chatId, text);
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandler = handler;
  }
}
