# 大厅角色卡返回现场恢复实施计划

## 1. 评审门禁

- 确认本次只实施 Frontend；当前大厅无 API 分页，不扩大为分页接口改造。
- 确认快照只保存 UI 条件、ID 顺序摘要与定位标量，不保存完整角色 DTO或收藏状态。
- 确认实现前任务仍保持 `planning`；本规划审核通过后再 `task.py start`。

## 2. 实施顺序

1. **恢复状态 helper**：实现 document token、version/TTL 校验、sessionStorage + 内存降级、最近快照覆盖、读取/消费与返回意图标记；刷新后 token 不匹配即废弃，所有存储异常吞掉并安全降级。
2. **卡片锚点接线**：为卡片根元素提供稳定、无敏感信息的角色 ID 定位标记；复用 `onImageSettled` 作为有限二次校准信号。
3. **进入前捕获**：`CharacterGallery` 在详情确认进入聊天的同步阶段保存 sort、query、展平已加载 IDs、邻卡、scrollY 和锚点 rect，再沿用 `chatEntryPath` 导航。
4. **初始条件与缓存策略**：Gallery 首次 state 从有效返回快照初始化；为 `useCharactersQuery` 增加最窄的“本次恢复挂载不强制 refetch”参数，普通挂载行为不变。
5. **布局恢复**：查询缓存/列表 DOM 准备好后在 layout effect 按锚点 → 邻卡 → scrollY 恢复；恢复前隐藏实际列表但保留布局，有限 deadline 解锁；图片结算后最多校准一次。
6. **统一退出路径**：聊天页顶部按钮、Telegram 返回键和 history 返回路径使用同一恢复意图。核对付费墙、自定义语音等聊天子路由，避免中途误消费快照。
7. **条件重置**：用户主动切换 sort、搜索条件或从其他入口进入大厅时不应用旧快照；恢复消费后不再次触发。
8. **模块事实更新**：实施完成并验证后更新 `frontend.business.character-lobby` 的当前状态、关键链路与验证方式；不在规划阶段提前声称已实现。

## 3. 可执行验证

不默认新建测试文件，运行现有质量门禁：

```bash
pnpm --filter @miniapp/frontend typecheck
pnpm --filter @miniapp/frontend test
pnpm --filter @miniapp/frontend lint
pnpm --filter @miniapp/frontend build
```

静态检查：

- 无新增 `any`、组件直接 fetch、数据库类型、其他应用 import、新 CSS 或新依赖。
- 快照不含完整角色 DTO、收藏状态、initData、token 或聊天正文。
- 所有计时器、RAF 和事件监听在 unmount 时清理。
- 恢复重试/二次校准次数有界，无滚动 effect 循环。

## 4. 人工验证矩阵

1. 推荐/最新 × 空搜索/有搜索词，分别下滑至少两屏进入聊天并返回。
2. 顶部返回、Telegram BackButton、Android/iOS 系统返回手势或浏览器 back。
3. 进入前目标卡分别位于视口顶部、中部、底部；返回后相对位置近似一致。
4. 深列表与多批已加载数据；目标不在首批时不得从顶部重新加载/逐页闪现。
5. 聊天中收藏切换、经充值或自定义语音子页回到聊天后再退出，位置与最新收藏均正确。
6. 锚点下架、邻卡存在/不存在、列表顺序局部变化、窗口宽度/方向变化。
7. sessionStorage 抛错、快照 JSON 损坏/过期、弱网/离线、角色 query 失败。
8. 快速进入退出 A，再进入退出 B，B 的现场覆盖 A；已消费快照不在主动进大厅时复用。
9. 刷新大厅、从“聊天/创作/我的”底部导航进入大厅，不恢复旧位置。
10. Telegram WebView 与普通移动浏览器，320px、常见宽度、安全区、reduced motion。

## 5. 发布与回滚

- Preview 真机完成上述关键矩阵后再合并；无需 backend/shared/database 先行步骤。
- 观察首页错误、返回白屏/跳顶反馈和导航失败；发现停止条件立即回滚 Vercel deployment。
- 回滚不清理客户端 key；旧版本忽略该 key。若需 forward-fix，提升 snapshot version 即可使旧值失效。
