# 阶段 3：Bridge 完整化 — 编码计划

> 产出时间：2026-06-24
> 依赖文档：ARCHITECTURE.md / SPIKE_RESULT.md / 决议依据.md
> 依赖顺序：3.1 → (3.2 ‖ 3.3) → 3.4

---

## 决策记录（已确认）

| 决策项                           | 结论                                                                              |
| -------------------------------- | --------------------------------------------------------------------------------- |
| `selectCharacter` action payload | `{ avatar: string }` — ST 侧角色稳定标识                                          |
| 对话页路由                       | `/tavern/[characterId]`，URL 中 characterId = 平台 DB id，页面内 resolve → avatar |
| 握手简化                         | 两段：`handshake` → `ready`（移除 `context-ready`）                               |
| `currentCharacterId` 类型        | `number \| null`（ST `this_chid` 索引）                                           |
| `generation:streaming` 节流      | `setInterval(1000)`，interval 内有 token 则推一次 event                           |
| `spike-probe.ts`                 | git rm，保留独立分支引用                                                          |
| bridge-protocol 消费方式         | `transpilePackages`（方式 A，零 dist/ 构建）                                      |

---

## 子任务 3.1：bridge-protocol 补完

**目标**：将 stub 骨架补全为包含完整 action/event schema、类型映射、运行时注册表的契约包。

### 3.1.1 修订握手为两段 + boundUserId nullable

**文件**：修改 `packages/bridge-protocol/src/handshake.ts`

**改动**：

- `HandshakePhase` 改为 `'handshake' | 'ready'`
- `HandshakePhaseSchema` 对应修改
- `HandshakeMeta.boundUserId` 改为 `string | null`
- `HandshakeMetaSchema.boundUserId` 改为 `z.string().nullable()`
- `ActionRequiredPhase` 类型跟随简化

**验证**：`pnpm --filter @miniapp/bridge-protocol typecheck`

---

### 3.1.2 修订 mirror-state currentCharacterId 类型

**文件**：修改 `packages/bridge-protocol/src/mirror-state.ts`

**改动**：

- `STMirrorState.currentCharacterId` 改为 `number | null`
- `STMirrorStateSchema.currentCharacterId` 改为 `z.number().nullable()`

**验证**：typecheck

---

### 3.1.3 定义 7 个 Action schema

**新建文件**（每个文件导出 `payloadSchema` / `resultSchema` / `meta`）：

#### `packages/bridge-protocol/src/actions/select-character.ts`

```typescript
import { z } from 'zod';
import type { ActionMeta } from './types.js';

export const SelectCharacterPayloadSchema = z.object({
  avatar: z.string(),
});

export const SelectCharacterResultSchema = z.object({
  characterId: z.number(),
  chatId: z.string().nullable(),
});

export const selectCharacterMeta: ActionMeta = {
  name: 'selectCharacter',
  payloadSchema: SelectCharacterPayloadSchema,
  resultSchema: SelectCharacterResultSchema,
  requiredPhase: 'ready',
  waitable: true,
};
```

#### `packages/bridge-protocol/src/actions/open-chat.ts`

```typescript
payload: {
  fileName: string;
} // 不含 .jsonl 扩展名
result: {
  chatId: string;
}
requiredPhase: 'ready';
waitable: true;
```

#### `packages/bridge-protocol/src/actions/new-chat.ts`

```typescript
payload: {
} // 无参数
result: {
  chatId: string;
}
requiredPhase: 'ready';
waitable: true;
```

#### `packages/bridge-protocol/src/actions/rename-chat.ts`

```typescript
payload: {
  oldFileName: string;
  newName: string;
}
result: {
  newFileName: string;
}
requiredPhase: 'ready';
waitable: true;
```

#### `packages/bridge-protocol/src/actions/delete-chat.ts`

```typescript
payload: {
  fileName: string;
  avatar: string;
}
result: {
  switchedToChatId: string | null;
} // 若删除的是当前 chat，返回切换后的 chatId
requiredPhase: 'ready';
waitable: true;
```

#### `packages/bridge-protocol/src/actions/change-model.ts`

```typescript
payload: {
  provider: string;
  modelName: string;
} // provider = chat_completion_source
result: {
  appliedModel: string;
}
requiredPhase: 'ready';
waitable: true;
```

#### `packages/bridge-protocol/src/actions/get-ready-state.ts`

```typescript
payload: {
}
result: {
  phase: 'handshake' | 'ready';
}
requiredPhase: 'handshake'; // 握手后即可调用
waitable: false; // 不入 buffer，立即响应
```

#### `packages/bridge-protocol/src/actions/types.ts`（辅助）

```typescript
import type { z } from 'zod';
import type { HandshakePhase } from '../handshake.js';

export interface ActionMeta {
  name: string;
  payloadSchema: z.ZodType;
  resultSchema: z.ZodType;
  requiredPhase: HandshakePhase;
  waitable: boolean;
}
```

**验证**：typecheck

---

### 3.1.4 定义 13 个 Event schema

**新建文件**（每个文件导出 `payloadSchema` / `meta`）：

#### `packages/bridge-protocol/src/events/types.ts`

```typescript
import type { z } from 'zod';

export interface EventMeta {
  name: string;
  payloadSchema: z.ZodType;
}
```

#### Event 清单（逐个文件）：

| 文件名                    | event name             | payload 字段                                                      |
| ------------------------- | ---------------------- | ----------------------------------------------------------------- |
| `app-ready.ts`            | `app:ready`            | `{}`                                                              |
| `character-changed.ts`    | `character:changed`    | `{ characterId: number; avatar: string; chatId: string \| null }` |
| `chat-changed.ts`         | `chat:changed`         | `{ chatId: string; messageCount: number }`                        |
| `chat-created.ts`         | `chat:created`         | `{ chatId: string }`                                              |
| `chat-deleted.ts`         | `chat:deleted`         | `{ fileName: string }`                                            |
| `chat-renamed.ts`         | `chat:renamed`         | `{ oldFileName: string; newFileName: string }`                    |
| `generation-started.ts`   | `generation:started`   | `{ type: string }`                                                |
| `generation-streaming.ts` | `generation:streaming` | `{ phase: 'streaming' }`                                          |
| `generation-completed.ts` | `generation:completed` | `{ chatId: number; messageCount: number }`                        |
| `generation-stopped.ts`   | `generation:stopped`   | `{}`                                                              |
| `generation-ended.ts`     | `generation:ended`     | `{ chatLength: number }`                                          |
| `model-changed.ts`        | `model:changed`        | `{ model: string; provider: string }`                             |
| `settings-updated.ts`     | `settings:updated`     | `{}`                                                              |

**验证**：typecheck

---

### 3.1.5 构建 ActionName / EventName 联合类型 + 映射

**新建**：`packages/bridge-protocol/src/actions/registry.ts`

```typescript
// 导入所有 action meta
// 导出：
export type ActionName =
  | 'selectCharacter'
  | 'openChat'
  | 'newChat'
  | 'renameChat'
  | 'deleteChat'
  | 'changeModel'
  | 'getReadyState';

export type ActionPayloadMap = {
  selectCharacter: z.infer<typeof SelectCharacterPayloadSchema>;
  openChat: z.infer<typeof OpenChatPayloadSchema>;
  // ...
};

export type ActionResultMap = {
  selectCharacter: z.infer<typeof SelectCharacterResultSchema>;
  // ...
};

export const actionRegistry: Record<ActionName, ActionMeta> = {
  selectCharacter: selectCharacterMeta,
  // ...
};
```

**新建**：`packages/bridge-protocol/src/events/registry.ts`

```typescript
export type EventName = 'app:ready' | 'character:changed' | 'chat:changed' | ... ;

export type EventPayloadMap = {
  'app:ready': {};
  'character:changed': { characterId: number; avatar: string; chatId: string | null };
  // ...
};

export const eventRegistry: Record<EventName, EventMeta> = { ... };
```

**修改**：`packages/bridge-protocol/src/actions/index.ts` — 重写为导出所有 action + registry
**修改**：`packages/bridge-protocol/src/events/index.ts` — 重写为导出所有 event + registry

---

### 3.1.6 强类型化 BridgeRequest / BridgeResponse / BridgeEvent

**文件**：修改 `packages/bridge-protocol/src/messages.ts`

**改动**：

- `BridgeRequest<A extends ActionName>` — `payload: ActionPayloadMap[A]`
- `BridgeResponse<A extends ActionName>` — `data?: ActionResultMap[A]`
- `BridgeEvent<E extends EventName>` — `payload: EventPayloadMap[E]`
- 保留宽松版 `BridgeRequestAny` / `BridgeResponseAny` / `BridgeEventAny`（用于解析阶段，payload 为 unknown）

---

### 3.1.7 实现 parseBridgeMessage + 消息大小工具

**新建**：`packages/bridge-protocol/src/parser.ts`

```typescript
export function parseBridgeMessage(raw: unknown): ParseResult;
export function checkMessageSize(data: string): void; // throw MESSAGE_TOO_LARGE
```

- `parseBridgeMessage` 先验 envelope schema，再按 `type` 路由到具体 schema
- 返回 discriminated union 或 throw

---

### 3.1.8 实现 BridgeError 类

**新建**：`packages/bridge-protocol/src/bridge-error.ts`

```typescript
export class BridgeError extends Error {
  readonly code: BridgeErrorCode;
  readonly context?: Record<string, string | number | boolean>;
  readonly requestId?: string;

  constructor(code: BridgeErrorCode, message: string, opts?: { requestId?: string; context?: ... }) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    // ...
  }

  toPayload(): BridgeErrorPayload { ... }
}
```

---

### 3.1.9 更新 index.ts 总导出

**文件**：修改 `packages/bridge-protocol/src/index.ts`

**新增导出**：

- `./parser.js`
- `./bridge-error.js`
- actions/events 的 registry + 各 action/event 的 schema

**最终验证**：`pnpm --filter @miniapp/bridge-protocol typecheck` 通过

---

## 子任务 3.2：st-extension handlers/forwarders 实现

**目标**：将 spike 阶段的探测代码替换为生产级 bridge-server，包含握手、action handlers、event forwarders。

**前置**：3.1 全部完成

### 3.2.1 bridge-server 骨架

**新建**：`packages/st-extension/src/bridge-server.ts`

**职责**：

- `window.addEventListener('message', handler)` 监听来自 parent 的消息
- 信封校验（channel / protocolVersion / size limit）
- 按 `type` 路由：`request` → action dispatcher / `ping` → pong 回复
- action dispatcher：查 `actionRegistry` → 校验 payload schema → 调对应 handler → 构建 response 回发
- 错误归一化：任何 handler throw 都 catch 转为 `BridgeResponse { success: false, error }`

**关键函数**：

```typescript
export function createBridgeServer(parentOrigin: string): BridgeServer;

interface BridgeServer {
  start(): void;
  stop(): void;
  sendEvent<E extends EventName>(name: E, payload: EventPayloadMap[E]): void;
  sendHandshake(phase: HandshakePhase, meta?: HandshakeMeta): void;
  getCurrentPhase(): HandshakePhase;
}
```

---

### 3.2.2 两段握手实现

**新建**：`packages/st-extension/src/handshake.ts`

**流程**：

1. IIFE 加载 → 立即发 `handshake(phase='handshake')`，meta 携带：
   - `stCommit`：编译期常量 `__ST_COMMIT__`（tsup define 注入）
   - `extensionBuildId`：`__BUILD_ID__`
   - `supportedActions`：从 `actionRegistry` 取 keys（编译期确定）
   - `supportedEvents`：从 `eventRegistry` 取 keys
   - `boundUserId`：从 ST cookie/session 获取（`null` 若无法识别）
2. 监听 `eventSource.on(APP_READY)` → 发 `handshake(phase='ready')`
3. 内部状态跟踪当前 phase，供 `getReadyState` handler 查询

**boundUserId 获取方式**：

```typescript
// ST 通过 accountStorage 管理用户身份
const ctx = SillyTavern.getContext();
const userId = ctx.accountStorage?.currentUser?.id ?? null;
```

> 注：若 accountStorage 机制不可靠，可降级为读 cookie。此处存在少量不确定性，实施时需验证。

---

### 3.2.3 mirror-state 快照构建

**新建**：`packages/st-extension/src/mirror-state.ts`

```typescript
export function buildMirrorState(): STMirrorState {
  const ctx = SillyTavern.getContext();
  return {
    userId: boundUserId, // 握手时确定
    currentCharacterId: ctx.characterId ?? null, // number | null
    currentChatId: ctx.getCurrentChatId() ?? null,
    currentPresetName: ctx.getPresetManager()?.getSelectedPresetName() ?? null,
    generationPhase: currentGenerationPhase, // 内部状态机维护
    messageCount: ctx.chat?.length ?? 0,
    lastUpdatedAt: Date.now(),
  };
}
```

---

### 3.2.4 handler: selectCharacter

**新建**：`packages/st-extension/src/handlers/select-character.ts`

```typescript
export async function handleSelectCharacter(
  payload: SelectCharacterPayload
): Promise<SelectCharacterResult> {
  const ctx = SillyTavern.getContext();
  const index = ctx.characters.findIndex((c) => c.avatar === payload.avatar);
  if (index < 0) {
    throw new BridgeError(
      'BRIDGE_EXEC_PRECONDITION_FAILED',
      `Character not found: ${payload.avatar}`
    );
  }

  await ctx.selectCharacterById(index, { switchMenu: false });
  ctx.saveSettingsDebounced();

  return {
    characterId: index,
    chatId: ctx.getCurrentChatId() ?? null,
  };
}
```

**注意**：用 `selectCharacterById` + `saveSettingsDebounced` 而非 `/go` 命令。原因：`/go` 按 name 模糊匹配可能有重名风险；`selectCharacterById` + 手动 save 更精确。`active_character` 不更新的问题在我们的场景中可接受（iframe 不会被刷新，ST 会话内索引稳定）。

---

### 3.2.5 handler: openChat

**新建**：`packages/st-extension/src/handlers/open-chat.ts`

```typescript
export async function handleOpenChat(payload: OpenChatPayload): Promise<OpenChatResult> {
  const ctx = SillyTavern.getContext();
  await ctx.openCharacterChat(payload.fileName);
  return { chatId: ctx.getCurrentChatId()! };
}
```

---

### 3.2.6 handler: newChat

**新建**：`packages/st-extension/src/handlers/new-chat.ts`

```typescript
export async function handleNewChat(): Promise<NewChatResult> {
  const ctx = SillyTavern.getContext();
  await ctx.executeSlashCommandsWithOptions('/newchat');
  return { chatId: ctx.getCurrentChatId()! };
}
```

---

### 3.2.7 handler: renameChat

**新建**：`packages/st-extension/src/handlers/rename-chat.ts`

```typescript
export async function handleRenameChat(payload: RenameChatPayload): Promise<RenameChatResult> {
  const ctx = SillyTavern.getContext();
  await ctx.renameChat(payload.oldFileName, payload.newName);
  return { newFileName: payload.newName };
}
```

---

### 3.2.8 handler: deleteChat

**新建**：`packages/st-extension/src/handlers/delete-chat.ts`

```typescript
export async function handleDeleteChat(payload: DeleteChatPayload): Promise<DeleteChatResult> {
  const ctx = SillyTavern.getContext();
  const currentChatId = ctx.getCurrentChatId();
  const isCurrentChat = currentChatId === payload.fileName;

  // 直接调用 REST API 删除
  await fetch('/api/chats/delete', {
    method: 'POST',
    headers: ctx.getRequestHeaders(),
    body: JSON.stringify({
      chatfile: `${payload.fileName}.jsonl`,
      avatar_url: payload.avatar,
    }),
  });

  // 手动 emit 事件（ST 内部 deleteCharacterChatByName 未在 getContext 暴露）
  await ctx.eventSource.emit(ctx.eventTypes.CHAT_DELETED, payload.fileName);

  // 若删除的是当前 chat，切到最新 chat
  let switchedToChatId: string | null = null;
  if (isCurrentChat) {
    const chatsResp = await fetch('/api/characters/chats', {
      method: 'POST',
      headers: ctx.getRequestHeaders(),
      body: JSON.stringify({ avatar_url: payload.avatar }),
    });
    const chats = Object.values(await chatsResp.json()) as Array<{ file_name: string }>;
    if (chats.length > 0) {
      const latest = chats[0]!.file_name.replace('.jsonl', '');
      await ctx.openCharacterChat(latest);
      switchedToChatId = latest;
    }
  }

  return { switchedToChatId };
}
```

---

### 3.2.9 handler: changeModel

**新建**：`packages/st-extension/src/handlers/change-model.ts`

```typescript
export async function handleChangeModel(payload: ChangeModelPayload): Promise<ChangeModelResult> {
  const ctx = SillyTavern.getContext();
  const { provider, modelName } = payload;

  // DOM select 映射表
  const selectorMap: Record<string, string> = {
    openai: '#model_openai_select',
    claude: '#model_claude_select',
    makersuite: '#model_google_select',
    openrouter: '#model_openrouter_select',
    // 按需扩展
  };

  const selector = selectorMap[provider];
  if (!selector) {
    throw new BridgeError('BRIDGE_EXEC_PRECONDITION_FAILED', `Unknown provider: ${provider}`);
  }

  // 修改设置对象
  const settingsKey = `${provider}_model`;
  (ctx.chatCompletionSettings as Record<string, unknown>)[settingsKey] = modelName;

  // 触发 DOM change 驱动联动逻辑
  const $ = (window as any).jQuery;
  $(selector).val(modelName).trigger('change');

  return { appliedModel: ctx.getChatCompletionModel() };
}
```

---

### 3.2.10 handler: getReadyState

**新建**：`packages/st-extension/src/handlers/get-ready-state.ts`

```typescript
export function handleGetReadyState(): GetReadyStateResult {
  return { phase: bridgeServer.getCurrentPhase() };
}
```

---

### 3.2.11 event forwarders

**新建**：`packages/st-extension/src/forwarders/index.ts`

**职责**：注册 ST 事件监听 → 转发为 bridge event

```typescript
export function registerForwarders(server: BridgeServer): void {
  const ctx = SillyTavern.getContext();
  const et = ctx.eventTypes;

  // character:changed — selectCharacter handler 完成后主动 emit（不在此注册）

  // chat 系列
  ctx.eventSource.on(et.CHAT_CHANGED, (chatId: string) => {
    server.sendEvent('chat:changed', {
      chatId,
      messageCount: ctx.chat?.length ?? 0,
    });
  });

  ctx.eventSource.on(et.CHAT_CREATED, () => {
    server.sendEvent('chat:created', { chatId: ctx.getCurrentChatId()! });
  });

  ctx.eventSource.on(et.CHAT_DELETED, (fileName: string) => {
    server.sendEvent('chat:deleted', { fileName });
  });

  ctx.eventSource.on(et.CHAT_RENAMED, (oldFileName: string, newFileName: string) => {
    server.sendEvent('chat:renamed', { oldFileName, newFileName });
  });

  // generation 系列
  ctx.eventSource.on(et.GENERATION_STARTED, (_type: string, _opts: unknown, dryRun: boolean) => {
    if (dryRun) return;
    server.sendEvent('generation:started', { type: _type });
    setGenerationPhase('started');
  });

  // generation:streaming — 节流 1s
  let streamingInterval: ReturnType<typeof setInterval> | null = null;
  let hasNewToken = false;

  ctx.eventSource.on(et.STREAM_TOKEN_RECEIVED, () => {
    hasNewToken = true;
    if (!streamingInterval) {
      setGenerationPhase('streaming');
      server.sendEvent('generation:streaming', { phase: 'streaming' });
      streamingInterval = setInterval(() => {
        if (hasNewToken) {
          server.sendEvent('generation:streaming', { phase: 'streaming' });
          hasNewToken = false;
        }
      }, 1000);
    }
  });

  ctx.eventSource.on(et.MESSAGE_RECEIVED, (chatId: number) => {
    clearStreamingInterval();
    setGenerationPhase('finished');
    server.sendEvent('generation:completed', {
      chatId,
      messageCount: ctx.chat?.length ?? 0,
    });
  });

  ctx.eventSource.on(et.GENERATION_STOPPED, () => {
    clearStreamingInterval();
    setGenerationPhase('aborted');
    server.sendEvent('generation:stopped', {});
  });

  ctx.eventSource.on(et.GENERATION_ENDED, (chatLength: number) => {
    clearStreamingInterval();
    server.sendEvent('generation:ended', { chatLength });
    // 延迟回 idle，让 UI 有时间展示完成状态
    setTimeout(() => setGenerationPhase('idle'), 500);
  });

  // model
  ctx.eventSource.on(et.CHATCOMPLETION_MODEL_CHANGED, () => {
    server.sendEvent('model:changed', {
      model: ctx.getChatCompletionModel(),
      provider: ctx.chatCompletionSettings.chat_completion_source,
    });
  });

  // settings
  ctx.eventSource.on(et.SETTINGS_UPDATED, () => {
    server.sendEvent('settings:updated', {});
  });

  function clearStreamingInterval() {
    if (streamingInterval) {
      clearInterval(streamingInterval);
      streamingInterval = null;
      hasNewToken = false;
    }
  }
}
```

---

### 3.2.12 重写 entry.ts

**文件**：修改 `packages/st-extension/src/entry.ts`

```typescript
import { createBridgeServer } from './bridge-server';
import { initHandshake } from './handshake';
import { registerForwarders } from './forwarders/index';

declare const __BUILD_ID__: string;
declare const __ST_COMMIT__: string;

function init(): void {
  const server = createBridgeServer('*'); // parentOrigin — MVP 阶段用 '*'，后续收紧
  server.start();

  initHandshake(server, {
    buildId: __BUILD_ID__,
    stCommit: __ST_COMMIT__,
  });

  registerForwarders(server);
}

if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}
```

---

### 3.2.13 删除 spike-probe.ts

```bash
git rm packages/st-extension/src/spike-probe.ts
```

保留在 `spike/phase2` 分支作为参考。

---

### 3.2.14 更新构建配置

**文件**：修改 `packages/st-extension/tsup.config.ts`

**改动**：

- `define` 新增 `__ST_COMMIT__`（从环境变量或固定字符串读取）
- 确认 `noExternal: [/.*/]` 仍然正确（bridge-protocol 新增的 action/event 文件都会被打包）

```typescript
define: {
  __BUILD_ID__: JSON.stringify(new Date().toISOString().slice(0, 19)),
  __ST_COMMIT__: JSON.stringify(process.env.ST_COMMIT ?? 'vendored'),
},
```

**最终验证**：

```bash
pnpm --filter @miniapp/st-extension typecheck
pnpm --filter @miniapp/st-extension build
# 检查 dist/entry.global.js 生成且 postbuild 拷贝成功
```

---

## 子任务 3.3：frontend lib/bridge 实现

**目标**：实现 bridge-client 运行时——状态机、RPC、事件订阅、React hooks。

**前置**：3.1 全部完成

### 3.3.1 添加 bridge-protocol 依赖 + transpilePackages

**修改**：`packages/frontend/package.json`

```json
"dependencies": {
  "@miniapp/bridge-protocol": "workspace:*",
  // ...existing
}
```

**修改**：`packages/frontend/next.config.mjs`

```javascript
transpilePackages: ['@miniapp/shared', '@miniapp/bridge-protocol'],
```

---

### 3.3.2 bridge-client 核心

**新建**：`packages/frontend/src/lib/bridge/bridge-client.ts`

**职责**：

- 管理 iframe `contentWindow` 引用
- `sendRequest<A>(action, payload)` → Promise\<result\>（30s 超时）
- 内部维护 `pendingRequests: Map<requestId, { resolve, reject, timer }>`
- `window.addEventListener('message')` 接收 response / event / handshake
- 信封校验（channel / protocolVersion / size）
- event 分发到订阅者

**核心 API**：

```typescript
export class BridgeClient {
  constructor(iframeRef: () => HTMLIFrameElement | null, options?: BridgeClientOptions);
  start(): void;
  stop(): void;
  sendAction<A extends ActionName>(
    action: A,
    payload: ActionPayloadMap[A]
  ): Promise<ActionResultMap[A]>;
  onEvent<E extends EventName>(name: E, cb: (payload: EventPayloadMap[E]) => void): () => void;
  getStatus(): BridgeStatus;
}
```

---

### 3.3.3 状态机

**新建**：`packages/frontend/src/lib/bridge/state-machine.ts`

**状态**：`IDLE | IFRAME_LOADING | HANDSHAKED | READY | DISCONNECTED`

**转换**：

- `IDLE → IFRAME_LOADING`：iframe 开始加载
- `IFRAME_LOADING → HANDSHAKED`：收到 `handshake(phase='handshake')` 且校验通过
- `HANDSHAKED → READY`：收到 `handshake(phase='ready')`
- `* → DISCONNECTED`：总超时 60s / iframe navigated / contentWindow 不可达
- `DISCONNECTED → IFRAME_LOADING`：reconnect()（可选，MVP 不实现）

**输出**：

```typescript
export type BridgeStatus = 'idle' | 'loading' | 'handshaked' | 'ready' | 'disconnected';
export type BridgeStateMachine = {
  getStatus(): BridgeStatus;
  transition(event: StateMachineEvent): void;
  onStatusChange(cb: (status: BridgeStatus) => void): () => void;
};
```

---

### 3.3.4 握手校验

**新建**：`packages/frontend/src/lib/bridge/handshake.ts`

**职责**：

- 收到 `handshake(phase='handshake')` 时：
  - 校验 `protocolVersion === 1`
  - 校验 `meta.boundUserId` 与平台已知 userId 一致（或 null 时报 `BRIDGE_HANDSHAKE_USER_MISSING`）
  - 存储 `meta.supportedActions` / `meta.supportedEvents`
  - 状态机 → HANDSHAKED
- 收到 `handshake(phase='ready')` 时：
  - flush buffer 中 `requiredPhase: 'ready'` 的请求
  - 状态机 → READY

---

### 3.3.5 请求缓冲队列

**新建**：`packages/frontend/src/lib/bridge/buffer.ts`

```typescript
export class RequestBuffer {
  private queue: BufferedRequest[] = [];
  private readonly limit = 32;

  enqueue(request: BufferedRequest): void; // 超限 → throw BUFFER_OVERFLOW
  flush(phase: HandshakePhase): BufferedRequest[];
  clear(): void;
}
```

- 当 action 的 `requiredPhase` 高于当前 phase → 入 buffer
- 当 `waitable: false` → 直接 reject `ACTION_NOT_AVAILABLE_IN_PHASE`，不入 buffer
- phase 提升时 flush 对应请求

---

### 3.3.6 platformAction 入口

**新建**：`packages/frontend/src/lib/bridge/platform-action.ts`

```typescript
export async function platformAction<A extends ActionName>(
  action: A,
  payload: ActionPayloadMap[A]
): Promise<ActionResultMap[A]> {
  const client = getBridgeClient();

  // 检查 supportedActions
  if (!client.isActionSupported(action)) {
    throw new BridgeError('BRIDGE_CALL_ACTION_NOT_SUPPORTED', `Action not supported: ${action}`);
  }

  return client.sendAction(action, payload);
}
```

业务组件调用示例：

```typescript
const result = await platformAction('selectCharacter', { avatar: 'luna.png' });
```

---

### 3.3.7 st-mirror store

**新建**：`packages/frontend/src/stores/st-mirror.ts`

```typescript
import { create } from 'zustand';
import type { STMirrorState } from '@miniapp/bridge-protocol';

type STMirrorStore = STMirrorState & {
  updatePartial: (patch: Partial<STMirrorState>) => void;
  reset: () => void;
};

const initialState: STMirrorState = {
  userId: '',
  currentCharacterId: null,
  currentChatId: null,
  currentPresetName: null,
  generationPhase: 'idle',
  messageCount: 0,
  lastUpdatedAt: 0,
};

export const useSTMirrorStore = create<STMirrorStore>((set) => ({
  ...initialState,
  updatePartial: (patch) => set((state) => ({ ...state, ...patch, lastUpdatedAt: Date.now() })),
  reset: () => set(initialState),
}));
```

**bridge-client 内部**在收到 event 时调用 `useSTMirrorStore.getState().updatePartial(...)` 更新对应字段。

---

### 3.3.8 React hooks

**新建**：`packages/frontend/src/lib/bridge/hooks.ts`

```typescript
/** 获取 bridge 连接状态 */
export function useBridgeStatus(): BridgeStatus;

/** 订阅 ST 事件 */
export function useSTEvent<E extends EventName>(
  eventName: E,
  callback: (payload: EventPayloadMap[E]) => void
): void;

/** 选择性读取 mirror state */
export function useSTMirror<T>(selector: (state: STMirrorState) => T): T;
```

实现：

- `useBridgeStatus`：订阅状态机的 statusChange
- `useSTEvent`：`useEffect` 内调 `bridgeClient.onEvent(name, cb)`，卸载时取消订阅
- `useSTMirror`：直接用 zustand 的 selector pattern `useSTMirrorStore(selector)`

---

### 3.3.9 统一导出

**新建**：`packages/frontend/src/lib/bridge/index.ts`

```typescript
export { BridgeClient } from './bridge-client';
export { platformAction } from './platform-action';
export { useBridgeStatus, useSTEvent, useSTMirror } from './hooks';
export type { BridgeStatus } from './state-machine';
```

---

### 3.3.10 验证

```bash
pnpm --filter frontend typecheck
pnpm --filter frontend build
```

---

## 子任务 3.4：iframe 宿主 + 对话页路由

**目标**：在根 layout 持久挂载 ST iframe，实现对话页路由与 iframe 可见性联动。

**前置**：3.2 + 3.3 全部完成

### 3.4.1 ST iframe 组件

**新建**：`packages/frontend/src/components/bridge/st-iframe.tsx`

```tsx
'use client';

import { useRef, useEffect } from 'react';
import { useBridgeContext } from './bridge-provider';

export function STIframe() {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const { registerIframe, isVisible } = useBridgeContext();

  useEffect(() => {
    if (iframeRef.current) {
      registerIframe(iframeRef.current);
    }
  }, [registerIframe]);

  return (
    <iframe
      ref={iframeRef}
      src="/tavern/"
      className={
        isVisible
          ? 'fixed inset-0 z-10 w-full h-full'
          : 'fixed inset-0 w-0 h-0 opacity-0 pointer-events-none'
      }
      sandbox="allow-scripts allow-same-origin allow-forms"
      title="SillyTavern"
    />
  );
}
```

**关键设计**：

- 始终 mounted，不随路由卸载
- 通过 className 切换可见性（不用 `display:none` 避免某些浏览器暂停 iframe）
- `sandbox` 限制最小权限

---

### 3.4.2 BridgeProvider

**新建**：`packages/frontend/src/components/bridge/bridge-provider.tsx`

```tsx
'use client';

import { createContext, useContext, useRef, useCallback, useMemo } from 'react';
import { BridgeClient } from '@/lib/bridge';
import { usePathname } from 'next/navigation';

type BridgeContextValue = {
  client: BridgeClient;
  registerIframe: (el: HTMLIFrameElement) => void;
  isVisible: boolean;
};

const BridgeContext = createContext<BridgeContextValue | null>(null);

export function BridgeProvider({ children }: { children: React.ReactNode }) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const pathname = usePathname();
  const isVisible = pathname.startsWith('/tavern/');

  const client = useMemo(
    () => new BridgeClient(() => iframeRef.current, { totalTimeout: 60_000 }),
    []
  );

  const registerIframe = useCallback(
    (el: HTMLIFrameElement) => {
      iframeRef.current = el;
      client.start();
    },
    [client]
  );

  const value = useMemo(
    () => ({ client, registerIframe, isVisible }),
    [client, registerIframe, isVisible]
  );

  return <BridgeContext.Provider value={value}>{children}</BridgeContext.Provider>;
}

export function useBridgeContext() {
  const ctx = useContext(BridgeContext);
  if (!ctx) throw new Error('useBridgeContext must be used within BridgeProvider');
  return ctx;
}
```

---

### 3.4.3 挂载到根 layout

**修改**：`packages/frontend/src/app/providers.tsx`

在现有 Providers 内部新增：

```tsx
import { BridgeProvider } from '@/components/bridge/bridge-provider';
import { STIframe } from '@/components/bridge/st-iframe';

// 在 return 中包裹：
<BridgeProvider>
  {children}
  <STIframe />
</BridgeProvider>;
```

---

### 3.4.4 对话页路由

**新建**：`packages/frontend/src/app/tavern/[characterId]/page.tsx`

```tsx
'use client';

import { useEffect } from 'react';
import { useParams } from 'next/navigation';
import { platformAction } from '@/lib/bridge';
import { useSTMirror } from '@/lib/bridge';
// 自研工具栏、侧边栏组件（后续实现）

export default function TavernChatPage() {
  const { characterId } = useParams<{ characterId: string }>();
  const generationPhase = useSTMirror((s) => s.generationPhase);

  useEffect(() => {
    // 从平台 API 获取该角色的 avatar
    // 然后发送 bridge action
    async function switchCharacter() {
      const avatar = await resolveAvatarByPlatformId(characterId);
      if (avatar) {
        await platformAction('selectCharacter', { avatar });
      }
    }
    switchCharacter();
  }, [characterId]);

  return (
    <div className="relative w-full h-full">
      {/* iframe 通过 BridgeProvider 的 isVisible 已经可见 */}
      {/* 自研工具栏覆盖在 iframe 上方 */}
      <div className="absolute top-0 left-0 right-0 z-20">{/* Toolbar placeholder */}</div>
    </div>
  );
}

async function resolveAvatarByPlatformId(id: string): Promise<string | null> {
  // 调用 backend API 或从 React Query cache 获取角色信息
  // 返回角色的 avatar 文件名
  return null; // placeholder
}
```

---

### 3.4.5 ui-store 扩展

**修改**：`packages/frontend/src/stores/ui-store.ts`

**新增字段**：

```typescript
activeCharacterAvatar: string | null;    // 当前对话页的角色 avatar
setActiveCharacterAvatar: (avatar: string | null) => void;
```

---

### 3.4.6 集成验证

**手动验证清单**（开发环境）：

- [ ] ST 服务启动（docker-compose），扩展加载无报错
- [ ] 前端 `/` 大厅正常渲染
- [ ] 点击角色卡 → 跳转 `/tavern/42` → iframe 可见
- [ ] 控制台可见 handshake(phase=handshake) 消息发出
- [ ] APP_READY 后 handshake(phase=ready) 消息发出
- [ ] `selectCharacter` action 发送 → ST 切角色 → response 返回
- [ ] 返回大厅 → iframe 隐藏 → ST 内部状态不丢失
- [ ] 发送消息 → generation:started / streaming / completed 事件正常转发
- [ ] st-mirror store 更新正确

---

## 风险与注意事项

| 风险                                                    | 缓解                                                                                               |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `boundUserId` 获取方式不确定（accountStorage 可能为空） | 3.2.2 实施时优先验证 `ctx.accountStorage?.currentUser?.id`；不可用则降级读 cookie；最差情况传 null |
| `changeModel` 的 DOM selector 映射不完整                | 3.2.9 只映射平台实际使用的 provider（openai 为主），其他 provider 返回 PRECONDITION_FAILED         |
| iframe sandbox 限制可能阻断 ST 某些功能                 | 3.4.1 先用宽松 sandbox，集成测试时逐步收紧                                                         |
| `parentOrigin: '*'` 不安全                              | MVP 阶段可接受，后续 3.4 阶段收紧为实际域名                                                        |
| 旧 `/chat/[sessionId]` 路由仍存在                       | 阶段 3 不删除，仅废弃标注；阶段 4 统一清理                                                         |

---

## 工作量总估

| 子任务                   | 预估                         | 关键路径             |
| ------------------------ | ---------------------------- | -------------------- |
| 3.1 bridge-protocol 补完 | 1.5 天                       | 是（阻塞 3.2 + 3.3） |
| 3.2 st-extension 实现    | 2 天                         | 是（阻塞 3.4）       |
| 3.3 frontend lib/bridge  | 1.5 天                       | 是（阻塞 3.4）       |
| 3.4 iframe 宿主 + 路由   | 1.5 天                       | 终点                 |
| **总计**                 | **~5 天**（3.2 与 3.3 并行） |                      |

---

## 执行顺序

```
Day 1-2:  3.1（全部 9 个子项）
Day 2-3:  3.2（与 3.3 并行启动）
Day 2-3:  3.3（与 3.2 并行）
Day 4-5:  3.4（依赖 3.2 + 3.3 完成）
Day 5:    集成验证 + 修复
```
