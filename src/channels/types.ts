export interface Channel {
  readonly name: string;
  readonly type: string;
  initialize(): Promise<void>;
  sendMessage(chatId: string, text: string): Promise<void>;
  onMessage(handler: (msg: IncomingMessage) => void): void;
}

export interface IncomingMessage {
  id: string;
  channel: string;
  chatId: string;
  chatName?: string;
  senderId: string;
  senderName: string;
  content: string;
  timestamp: Date;
  isFromMe: boolean;
  isGroup: boolean;
}
