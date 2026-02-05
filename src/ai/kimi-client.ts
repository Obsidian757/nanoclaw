import { logger } from '../logger.js';
import type { KimiMessage, KimiResponse } from './types.js';

export { type KimiMessage, type KimiResponse } from './types.js';

export class KimiClient {
  private apiKey: string;
  private baseUrl: string;
  private model: string;

  constructor() {
    this.apiKey = process.env.KIMI_API_KEY || '';
    this.baseUrl = process.env.KIMI_BASE_URL || 'https://api.moonshot.cn/v1';
    this.model = process.env.KIMI_MODEL || 'kimi-k2-5';

    if (!this.apiKey) {
      throw new Error('KIMI_API_KEY environment variable is required');
    }
  }

  async chat(messages: KimiMessage[]): Promise<KimiResponse> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: 0.7,
        max_tokens: 4096,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Kimi API error: ${response.status} - ${error}`);
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
      usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      };
    };
    
    return {
      content: data.choices[0].message.content,
      usage: data.usage,
    };
  }

  async complete(prompt: string, systemPrompt?: string): Promise<string> {
    const messages: KimiMessage[] = [];
    
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    
    messages.push({ role: 'user', content: prompt });
    
    const response = await this.chat(messages);
    return response.content;
  }
}

export const kimi = new KimiClient();
