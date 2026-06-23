# 前端 UI 重构留痕

**时间**：2026-06-24  
**目标**：使用成熟的 UI 组件库（shadcn/ui）重构 MiniApp 前端界面，提升视觉与交互体验，彻底替换硬编码的 raw HTML 标签与零散的 Tailwind 样式，同时保持与 ST（SillyTavern）引擎的代码绝对隔离。

---

## 1. 现状与问题分析

- 之前的前端页面（如充值、个人中心、设置等）大量使用原生的 `<button>`、`<div>` 并手写大量零散的 Tailwind 类。
- 缺乏统一的设计系统，维护成本高，样式不易复用。
- 用户要求：不自己手写生成按钮，使用好看的 UI 组件，且“不止是支付”页面，需要对整个 MiniApp 前端（Profile, Settings 等）进行规范化重构。
- 约束：绝对不修改 `st_` 相关或 ST 原始仓库代码。

## 2. 改造方案

- **UI 组件库选择**：项目中已部分引入了 `shadcn/ui`（已有 `Button` 和 `Sheet`），我们将继续深入使用 `shadcn/ui` + `Radix UI`。由于它是无头组件库，样式通过 Tailwind 定义在本项目中，完全可控，且能提供极佳的现代 UI 质感。
- **重构范围**：
  1. 个人中心页（Profile）
  2. 支付与充值页（Recharge, Orders, Pending）
  3. 用户设置页（Settings）
  4. 其他公共交互组件（对话页内的非 ST UI 元素等）
- **步骤**：
  1. 补齐所需的 shadcn 组件（如 Card, Badge, Avatar, Skeleton, Separator, Dialog 等）。
  2. 逐页面替换原生标签，统一为 shadcn 规范。
  3. 优化现有的颜色与质感体系（适配深色模式，提升“星尘”相关资产的视觉反馈）。

## 3. 开发过程记录

### 阶段一：补齐基础设施组件 (Done)

- [x] 检查并引入基础 `shadcn/ui` 组件（Card, Badge, Input, Switch, Avatar, Dialog, Skeleton 等）。
- [x] 确保前端项目的 `components.json` 和工具类准备就绪。

### 阶段二：重构支付与钱包模块 (Done)

- [x] 重构 `profile/recharge/page.tsx`（充值页）
- [x] 重构 `profile/recharge/[orderId]/page.tsx`（支付结果等待页）
- [x] 重构 `profile/orders/page.tsx`（订单列表页）

### 阶段三：重构个人中心与设置模块 (Done)

- [x] 重构 `profile/page.tsx`（主个人页）
- [x] 重构 `profile/settings/page.tsx`（设置页）

### 阶段四：重构画廊与角色面板 (Done)

- [x] 重构 `components/characters/character-gallery.tsx`（大厅列表，搜索，前往许愿池）
- [x] 重构 `components/characters/character-detail-sheet.tsx`（角色详情与抽屉）

### 阶段五：验证与联调

- [x] 确认 UI 更换后，各业务流程（含 Telegram 原生 hooks）正常工作。
- [x] 确认未影响任何 ST 的 iframe / 原生功能（刻意避开 `chat/composer.tsx` 的复杂行内 ST-Hue 样式）。
