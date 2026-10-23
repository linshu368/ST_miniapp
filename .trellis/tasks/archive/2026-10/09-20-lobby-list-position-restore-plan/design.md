# 大厅角色卡返回现场恢复技术设计

## 1. 设计原则

1. **最小侵入**：仅改 Frontend 大厅与聊天返回接线，新增一个小型 lobby restore helper；不改 API、shared、backend、数据库和视觉。
2. **单一数据真相**：角色列表与收藏仍归 React Query；恢复快照只记录 UI 条件、列表身份摘要和定位信息，不保存完整 DTO。
3. **一次性恢复意图**：只为“大厅 → 角色聊天 → 大厅”链路服务；恢复成功或判定不可恢复后立即消费，避免主动进入大厅时误跳。
4. **锚点优先、偏移兜底**：以角色卡视口相对位置恢复；卡不存在时依次尝试邻卡和滚动偏移。

## 2. 状态模型

新增短生命周期 `LobbyReturnSnapshot`（具体字段名实施时可微调）：

```ts
interface LobbyReturnSnapshot {
  version: 1;
  documentToken: string;
  createdAt: number;
  sort: LobbySort;
  query: string;
  anchorCharacterId: string;
  neighborCharacterIds: string[];
  loadedCharacterIds: string[];
  anchorViewportTop: number;
  scrollY: number;
  viewportWidth: number;
}
```

- 存储：同标签页 `sessionStorage` 保存快照，同时保留模块内存中的 `documentToken`；不使用 localStorage，避免跨会话恢复。sessionStorage 不可用时，本次 SPA 文档内以内存快照降级。
- 刷新隔离：只有快照 `documentToken` 与当前内存 token 一致才可恢复。浏览器刷新/新文档会生成新 token，即使 sessionStorage 仍在也会废弃旧快照，满足“不跨刷新恢复”。
- TTL：有限有效期（建议 2 小时）且 schema version 严格校验；损坏、过期、账号/文档重启导致 token 不匹配时直接丢弃。
- `loadedCharacterIds` 是顺序摘要，不复制角色 DTO。当前等于已渲染的过滤后结果；若未来变成 infinite query，则等价于已加载 pages 展平后的 IDs。
- `neighborCharacterIds` 保存锚点前后少量卡片，用于锚点下架后的最近有效定位。

## 3. 数据流与时序

### 3.1 进入聊天前

1. `CharacterGallery` 已知当前 `sort/query/filtered`。
2. 用户在详情 Sheet 点击“进入角色”时，同步读取目标卡 DOM rect 与 `window.scrollY`，写入最近一次快照，再执行现有 `router.push(chatEntryPath(id))`。
3. 写存储失败不阻断进入聊天，只失去增强恢复能力。

### 3.2 退出聊天

- 新增/扩展统一 `returnToLobby` helper：确认当前文档存在已 armed 的最近快照，然后导航到 `/`。
- 聊天顶部按钮、Telegram BackButton 均调用此 helper。
- 系统返回手势不一定经过点击 handler，因此快照在进入聊天前即 armed；大厅挂载时校验同文档 token、有效期与大厅→聊天来源。顶部/Telegram 使用 `router.push('/')` 的现状可最小保持，或经实施验证统一为不会破坏充值回跳 history 的导航方式。
- 不在聊天页任意 unmount 时清快照，因为充值、自定义语音等聊天子链路会暂时离开聊天，不能误判为退出大厅链路。

### 3.3 大厅恢复

1. `CharacterGallery` 初始 state 同步读取有效快照，以快照的 `sort/query` 首次渲染，避免先渲染推荐首屏再切条件。
2. 恢复挂载对对应 `useCharactersQuery` 跳过一次 `refetchOnMount: 'always'`，先用现有 React Query 内存数据/已持久数据还原顺序；普通进入保持原对账策略。
3. 在 `useLayoutEffect` 中等待查询数据可渲染且已加载集合覆盖锚点（分页版本需等待已有 pages hydrate/补齐，不从第一页覆盖）。恢复期间列表容器保持不可见但占位，避免顶部闪现；设置有限 deadline，超时安全显示当前列表。
4. 查找 anchor DOM，执行：`targetY = currentScrollY + currentAnchorTop - savedAnchorViewportTop`。找不到则按 `neighborCharacterIds` 顺序定位；仍找不到使用 clamp 后的 `scrollY`。
5. 定位完成后显示列表并消费快照。目标图片/布局结算回调允许在短窗口内最多一次二次校准，禁止无限抖动。

## 4. 分页/无限滚动兼容

当前大厅无分页，不在本任务中增加后端分页。设计通过以下约束支持“深度/分页后返回”：

- 查询 cache 是已加载卡片/pages 的真相，路由切换期间不清除对应 query key。
- 快照记录进入前展平顺序和锚点/邻卡 ID；恢复逻辑不得默认目标在第一页。
- 若实施分支已出现 infinite query，恢复门禁先检查 cached `pageParams/pages` 是否覆盖锚点；内存 cache 尚在则直接渲染，丢失时按已知 pageParams 有限补齐，完成前不展示首屏。
- 补页失败或达到有限 deadline 后降级到最近已加载邻卡/有效偏移，不无限重试、不白屏。

## 5. 收藏与局部更新

- 收藏 mutation 沿用现有 favorite query key/cache；快照不记录收藏布尔值，因此返回自然展示最新状态。
- 角色元数据整体重排在一次恢复期间暂缓覆盖；恢复消费后，下一次正常进入/显式条件切换继续执行现有 fresh 对账。
- 若锚点下架，邻卡定位保证上下文尽可能接近，不恢复已失效的卡片数据。

## 6. 可靠性设计

| 故障模型                        | 处理                                                     |
| ------------------------------- | -------------------------------------------------------- |
| sessionStorage 不可用/损坏/超额 | 内存镜像兜底；否则无声降级现有大厅，不阻断导航           |
| React Query cache 被回收        | 使用既有持久角色数据；有限等待查询成功，失败后展示错误态 |
| 弱网或 refetch 失败             | 恢复挂载不依赖新请求；无无限重试                         |
| 锚点下架/排序变化               | 邻卡 → clamp scrollY 三级降级                            |
| 图片晚到/响应式列数变化         | 固定宽高优先稳定布局，必要时一次锚点二次校准             |
| 快速连续点击/返回               | 单槽快照后写覆盖前写；`enteringRef` 继续防重复进入       |
| 恢复流程卡住                    | 有限 deadline 后解除隐藏并消费无效快照                   |

超时适用于恢复等待；重试仅允许已有查询层的安全 GET 且有限。无写入幂等、事务、补偿、限流或容量基础设施需求：本功能无服务端写入，快照单槽且仅保存 ID/标量，容量有界。可观测性以开发/人工回归为主，不记录搜索词、完整列表或用户敏感数据到日志/遥测。

## 7. 最小充分方案与拒绝项

- 新增 1 个聚焦 helper（状态校验、保存、读取、消费、统一返回意图）；修改 Gallery/Card 接线与聊天返回调用点。
- 不新增 Zustand store：状态不需跨任意组件长期订阅，sessionStorage + 内存镜像足够。
- 不复制完整列表、不做全局 React Query persist、不接 Redux、不引入虚拟列表/滚动库。
- 不为假设中的未来分页修改 shared/backend；只定义缓存准备门禁。
- 不依赖浏览器自动 scroll restoration，因为它不包含 sort/query/loaded list 条件。

## 8. 演进、发布与恢复

- 纯前端兼容变更，无数据迁移和发布顺序依赖；Preview 验证后正常发布。
- 快照带 version，未来字段变更可直接废弃旧版本；旧客户端不受影响。
- 停止条件：出现大厅不可滚动、返回白屏、恢复死循环、普通进入误跳或聊天退出失败。
- 回滚：回退前端 deployment 即可；sessionStorage 的未知 key 对旧代码无影响。forward-fix 可提升 version 使旧快照立即失效。
