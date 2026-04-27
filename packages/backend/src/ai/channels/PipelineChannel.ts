import type { IAIChannel, OpenAIMessage } from '../ports/IAIChannel.js';
import type { AIProfileConfig } from '../../types/config.js';

export class PipelineChannel implements IAIChannel {
  constructor(
    private pipelineId: string,
    private steps: AIProfileConfig[]
  ) {}

  /**
   * 将可读流包装为 AsyncGenerator，负责处理 SSE 协议的数据解析
   */
  private async *readFetchStream(
    reader: ReadableStreamDefaultReader<Uint8Array>
  ): AsyncGenerator<string> {
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    try {
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
    } finally {
      reader.cancel().catch(() => {});
    }
  }

  /**
   * 3-Stage Timeout 托管流，负责竞速与中断
   */
  private async *managedStream(
    stream: AsyncGenerator<string, void, unknown>,
    ttftMs: number,
    interChunkMs: number,
    totalMs: number,
    abortController: AbortController
  ): AsyncGenerator<string> {
    const startTime = Date.now();
    let hasReceivedFirstToken = false;

    try {
      while (true) {
        const now = Date.now();
        const elapsed = now - startTime;
        const remainingTotal = totalMs - elapsed;

        // Stage 3: 总超时检查 (循环开始时)
        if (remainingTotal <= 0) {
          console.warn(`[PipelineChannel] Stream ended due to Total Timeout`);
          return;
        }

        // 确定当前阶段的超时上限
        const stepTimeoutMs = hasReceivedFirstToken ? interChunkMs : ttftMs;
        const effectiveTimeoutMs = Math.min(stepTimeoutMs, remainingTotal);

        let timer: NodeJS.Timeout;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error('TIMEOUT_RACE'));
          }, effectiveTimeoutMs);
        });

        try {
          // Race: 等待下一个数据块 vs 超时
          const result = await Promise.race([stream.next(), timeoutPromise]);
          clearTimeout(timer!);

          if (result.done) {
            break;
          }

          if (!hasReceivedFirstToken) {
            console.info(
              `[PipelineChannel] ManagedStream: First Token Received after ${Date.now() - startTime}ms`
            );
            hasReceivedFirstToken = true;
          }

          yield result.value;
        } catch (error: any) {
          clearTimeout(timer!);

          if (error.message === 'TIMEOUT_RACE') {
            const currentElapsed = Date.now() - startTime;
            const isTotalTimeout = currentElapsed >= totalMs - 10;

            if (isTotalTimeout) {
              // Stage 3: 总超时 -> 成功退出 (截断保留)
              console.warn(`[PipelineChannel] Stream ended due to Total Timeout (Race)`);
              return;
            }

            if (!hasReceivedFirstToken) {
              // Stage 1: 首字超时 (TTFT) -> 立即终止网络请求并抛出异常，触发重试切换
              const reason = `TTFT timeout exceeded (${ttftMs}ms)`;
              console.info(`[PipelineChannel] Step Failed: TTFT Timeout`);

              // 关键: 立即中止原 fetch 请求
              abortController.abort(new Error(reason));
              throw new Error(reason);
            } else {
              // Stage 2: 块间超时 -> 成功退出 (截断保留)
              console.warn(`[PipelineChannel] Stream ended due to Inter-chunk Timeout`);
              return;
            }
          } else {
            throw error;
          }
        }
      }
    } finally {
      // 保证资源清理
      if (stream.return) {
        stream.return().catch(() => {});
      }
    }
  }

  async *streamGenerate(
    messages: OpenAIMessage[],
    context?: Record<string, any>
  ): AsyncGenerator<string> {
    for (let i = 0; i < this.steps.length; i++) {
      const profile = this.steps[i];
      if (!profile) continue;

      // 为当前节点调用创建一个独立的 AbortController
      const abortController = new AbortController();

      // 将外层传入的 context.signal 链接到当前 Controller
      if (context?.signal) {
        context.signal.addEventListener('abort', () => {
          abortController.abort(context.signal.reason);
        });
      }

      console.info(
        `[PipelineChannel] Executing pipeline step ${i + 1}/${this.steps.length} [Model: ${profile.model}]`
      );

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
          // 传递 signal，允许我们在内部超时或者外部取消时立即掐断请求
          signal: abortController.signal,
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`API Error: ${response.status} ${response.statusText} - ${errorText}`);
        }

        if (!response.body) {
          throw new Error('Empty response body');
        }

        // 1. 获取底层并解析 SSE 协议为干净的内容流
        const rawStream = this.readFetchStream(response.body.getReader());

        // 2. 获取超时配置 (可从 profile 中读取或提供默认值)
        const ttftMs = profile.firstchunk_timeout || 7000;
        const interChunkMs = context?.timeoutConfig?.interChunkMs || 4000;
        const totalMs = profile.total_timeout || 60000;

        // 3. 将其封装进入限流层 managedStream
        const managed = this.managedStream(
          rawStream,
          ttftMs,
          interChunkMs,
          totalMs,
          abortController
        );

        let hasYielded = false;
        for await (const chunk of managed) {
          hasYielded = true;
          yield chunk;
        }

        if (hasYielded) {
          console.info(`[PipelineChannel] Pipeline step ${i + 1} success`);
          return;
        } else {
          // 如果流为空，当做失败处理以便触发重试
          throw new Error(`Empty response stream (model=${profile.model})`);
        }
      } catch (error: any) {
        // 在捕获异常时，确保请求已经被正确中止 (防止僵尸请求堆积)
        abortController.abort(error);

        console.warn(`[PipelineChannel] Step ${i + 1} failed: ${error.message || String(error)}`);

        if (i === this.steps.length - 1) {
          console.error(`[PipelineChannel] Pipeline execution failed after all attempts`);
          throw error;
        }

        // 继续下一次循环，即切换到下个 Step 重试
        console.info(`[PipelineChannel] Switching to next step due to failure`);
      }
    }
  }
}
