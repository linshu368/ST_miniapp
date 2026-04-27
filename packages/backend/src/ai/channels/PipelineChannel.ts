import type { IAIChannel, OpenAIMessage } from '../ports/IAIChannel.js';
import type { AIProfileConfig } from '../../types/config.js';

export class PipelineChannel implements IAIChannel {
  constructor(
    private pipelineId: string,
    private steps: AIProfileConfig[]
  ) {}

  async *streamGenerate(
    messages: OpenAIMessage[],
    context?: Record<string, any>
  ): AsyncGenerator<string> {
    // Phase 1: Single node, standard fetch streaming
    for (let i = 0; i < this.steps.length; i++) {
      const profile = this.steps[i];
      if (!profile) continue;

      try {
        const response = await fetch(profile.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${profile.key}`,
            'HTTP-Referer': 'http://localhost:3000',
            'X-Title': 'ST_miniAPP',
          },
          body: JSON.stringify({
            model: profile.model,
            messages: messages,
            stream: true,
          }),
          signal: context?.signal,
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`API Error: ${response.status} ${response.statusText} - ${errorText}`);
        }

        if (!response.body) {
          throw new Error('Empty response body');
        }

        // Node.js fetch response.body is a ReadableStream
        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // Keep the last incomplete line in buffer

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed === 'data: [DONE]') continue;
            if (trimmed.startsWith('data: ')) {
              try {
                const data = JSON.parse(trimmed.slice(6));
                const content = data.choices?.[0]?.delta?.content;
                if (content) {
                  yield content;
                }
              } catch (e) {
                // Ignore parse errors for incomplete chunks
              }
            }
          }
        }

        // If we reach here successfully, we don't need to retry
        return;
      } catch (error) {
        console.error(`[PipelineChannel] Step ${i + 1} failed:`, error);
        if (i === this.steps.length - 1) {
          throw error; // Last step failed
        }
        // Otherwise continue to next step (retry)
      }
    }
  }
}
