# 技术设计：短剧前端列表/播放页与底部导航

## 1. `lib/api/drama.ts`（新建）

参照 `lib/api/favorites.ts` 的简洁模式（不需要 `characters.ts` 那种 localStorage 持久化缓存，短剧列表不需要离线快照）：

```ts
'use client';

import { useQuery } from '@tanstack/react-query';
import type { DramaSummary, DramaDetail } from '@miniapp/shared';
import { apiClient } from './client';

export const dramaKeys = {
  all: ['dramas'] as const,
  list: () => [...dramaKeys.all, 'list'] as const,
  detail: (id: string) => [...dramaKeys.all, 'detail', id] as const,
};

async function fetchDramas(): Promise<DramaSummary[]> {
  return apiClient<DramaSummary[]>('/api/dramas');
}

async function fetchDramaDetail(id: string): Promise<DramaDetail> {
  return apiClient<DramaDetail>(`/api/dramas/${encodeURIComponent(id)}`);
}

export function useDramaListQuery() {
  return useQuery({ queryKey: dramaKeys.list(), queryFn: fetchDramas });
}

export function useDramaDetailQuery(id: string) {
  return useQuery({
    queryKey: dramaKeys.detail(id),
    queryFn: () => fetchDramaDetail(id),
    enabled: Boolean(id),
  });
}
```

- 播放地址是现签的短期链接，**不做跨请求缓存静态化**：详情页的 `staleTime` 不设得过长，避免用户停留很久后拿到的是已过期链接但 React Query 还在用缓存——具体数值实现时参考签名 TTL（见子任务 `10-21-drama-api-contract-backend` 设定的 TTL），`staleTime` 应明显短于 TTL，或者干脆不设 `staleTime`（走默认），靠用户重新进入详情页触发重新请求。
- 不引入新的 fetch 封装；`apiClient` 复用现有 `lib/api/client.ts`。

## 2. `components/nav/bottom-nav.tsx`（扩展，不重写）

```ts
import { Home, MessageCircle, Sparkles, User, Clapperboard } from 'lucide-react'; // 图标按原型风格定，这里先用占位图标

const NAV_ITEMS = [
  { href: '/', label: '大厅', Icon: Home },
  { href: '/dramas', label: '短剧', Icon: Clapperboard },
  { href: '/chats', label: '聊天', Icon: MessageCircle },
  { href: '/create', label: '创作', Icon: Sparkles },
  { href: '/profile', label: '我的', Icon: User },
] as const;
```

- `grid-cols-4` 改成 `grid-cols-5`；`max-w-[390px]` 的整体宽度和单个 tab 的间距在 5 列下需要人工验证一遍（移动端窄屏下是否还能点中、文字是否挤压），这是现有常量驱动的小改动，不是重写组件。
- 短剧 tab 的位置（放在大厅后、聊天前，还是放在最后）等原型视觉确认后再定，本设计先放在大厅后面——因为方案文档把它定位为和"刷到内容"相关的功能，语义上离大厅更近；如果用户看了原型后有不同意见，调整顺序只是常量数组里挪一行，不是架构变更。
- `HIDDEN_PREFIXES` 是否需要给 `/dramas/[id]` 播放页加一条（沉浸式播放时隐藏底部导航）：参照 `/chat/[characterId]` 的做法——该路径在 `(main)/layout.tsx` 之外完全跳过主布局，而不是走 `HIDDEN_PREFIXES`。短剧播放页是否需要同样"脱离主布局"取决于播放体验要不要全屏沉浸；本轮 MVP 先不做全屏播放器，播放页仍在主布局内、保留底部导航，`HIDDEN_PREFIXES` 不需要新增条目。如果后续原型要求沉浸式播放，再按 `/chat/[characterId]` 的模式调整。

## 3. `app/(main)/dramas/page.tsx`（新建）

- 用 `useDramaListQuery()` 取列表；状态覆盖：
  - `isLoading`：骨架屏/简单 loading 态（复用现有大厅列表的 loading 视觉语言，不新发明一套）。
  - `isError`：错误提示 + 重试（复用现有错误态组件模式）。
  - 数据为空数组：empty 态文案（例如"短剧正在上架中"）。
  - 正常渲染：卡片列表，每张卡片展示 `title`、`cover_url`（为 `null` 时用占位图，复用现有角色卡片的占位图处理方式）、`tags`（`length === 0` 时不渲染标签行，或渲染"标签生成中"轻量占位，和 PRD 约定一致）。
- 点击卡片跳转 `/dramas/[id]`。

## 4. `app/(main)/dramas/[id]/page.tsx`（新建）

- 用 `useDramaDetailQuery(id)` 取详情；`videos` 数组按顺序展示（MVP 不做多集导航 UI，有多条就简单列出，点哪条播哪条）。
- 原生 `<video>` 标签播放 `play_url`；`playable=false` 的条目不渲染 `<video>`，改为"暂不可播放"提示文案 + 不可点击的占位态。
- 简介为空时渲染"简介整理中"占位文案，和列表页标签占位逻辑保持一致的文案语气。
- `<video>` 加载失败（签名链接过期等）要有 `onError` 处理，展示明确的错误提示而不是浏览器默认的损坏图标。

## 5. 数据流

```
features: useDramaListQuery / useDramaDetailQuery（lib/api/drama.ts）
        │ React Query，走现有 apiClient（X-Init-Data 由现有拦截器统一处理，不单独实现鉴权）
        ▼
GET /api/dramas, GET /api/dramas/:id（子任务 10-21-drama-api-contract-backend）
        │
dramas/page.tsx（列表）、dramas/[id]/page.tsx（详情+播放）
        │
components/nav/bottom-nav.tsx（第 5 个 tab 入口）
```

## 6. 风险与边界

- **占位态遗漏**：标签/简介/封面/`playable=false` 四类占位态容易漏掉其中一类（尤其是封面图，现在恒为 `null`）。实现时逐条对照 PRD 的 Acceptance Criteria 清单验证，不能只测"有数据的正常路径"。
- **5 列导航挤压**：现有 `BottomNav` 的尺寸常量是为 4 列调的，改 5 列后最窄机型（安全区 + 小屏）下图标/文字是否还能正常显示需要人工在移动浏览器实测，不能只看桌面浏览器窗口缩放模拟。
- **签名链接时效**：用户在列表页停留较久再点进详情页，或者在详情页停留超过签名 TTL 后才点播放，可能遇到链接已过期。MVP 先不做"播放失败自动重新请求签名"的复杂重试逻辑，只要求失败时有清晰的错误提示（用户刷新页面即可重新拿到新链接），这是经评估后选择的最小方案，不是遗漏。

## 7. 复用评估

- 复用现有 `apiClient`、React Query 配置、Tailwind/shadcn 组件、现有列表/详情页的 loading/error/empty 态视觉模式（具体参照大厅或聊天历史列表页的现成实现，不新发明一套状态展示组件）。
- 不引入新的状态管理（不需要 Zustand，短剧数据没有跨组件共享的客户端状态）、不引入新的视频播放库（原生 `<video>` 足够覆盖 MVP 的单文件播放需求）。
