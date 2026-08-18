/**
 * [TEMP DEBUG — iframe-latency] ST iframe 端相位打点。
 *
 * 用 Date.now()（与父窗口同设备同一时钟）向父窗口 postMessage 打点，父窗口
 * BridgeClient 收到 type='debug-timing' 后并入 iframe-timing beacon，最终落
 * Railway backend 日志。用于把 selectCharacter 与 ST APP_READY 内部继续细拆。
 *
 * 移除方式：删除本文件 + 各调用点 stTiming(...)。全部以 [iframe-timing] 标注。
 */

import { BRIDGE_CHANNEL, PROTOCOL_VERSION } from '@miniapp/bridge-protocol';

export function stTiming(name: string, info?: string): void {
  try {
    window.parent.postMessage(
      {
        channel: BRIDGE_CHANNEL,
        protocolVersion: PROTOCOL_VERSION,
        type: 'debug-timing',
        name,
        t: Date.now(),
        ...(info !== undefined && { info }),
      },
      '*'
    );
  } catch {
    /* noop */
  }
}
