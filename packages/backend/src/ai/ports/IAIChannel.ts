export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface IAIChannel {
  streamGenerate(messages: OpenAIMessage[], context?: Record<string, any>): AsyncGenerator<string>;
}
