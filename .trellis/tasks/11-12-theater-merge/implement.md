# 实施计划

1. 底栏：`nav-icons.tsx` 加对话图标；`bottom-nav-shell.tsx` 换 `NAV_ITEMS`、`/watch` 常隐藏；`bottom-nav.tsx` 去掉角色栏目记忆、预热候选加 `/chats`；`mobile-performance.ts` 路由类型与预热顺序。
2. 角色：`roleplay-header.tsx` 单栏目名；`roleplay-navigation.ts` 删 view 记忆；`chats/page.tsx`、`recent-conversation-card.tsx` 去掉调用。
3. 短剧 store：`feedReturnId` 非持久字段。
4. 放映页：`drama-home.tsx` 读 browseQueue 快照、卸载写 `feedReturnId`；`drama-home-frame.tsx` 加返回按钮、内容区铺满；`drama-player.tsx` 嵌入式底部安全区；`entry-shell.tsx` 启动框架同步。
5. 剧场：封面进放映（owner=home）；新增「随便看看」条；返回聚焦与金边；追剧空态改切回剧场。
6. 文档：drama-experience、character-lobby、client-ui-foundation 模块说明。

## 验证

```bash
pnpm --filter @miniapp/frontend typecheck
pnpm --filter @miniapp/frontend test
pnpm --filter @miniapp/frontend lint
pnpm lint:complexity
pnpm --filter @miniapp/frontend build
pnpm test:ui --grep "@drama|@roleplay"
```

人工（`pnpm preview:ui`，390×844 与 320×568）：分类下点封面连刷 → 返回聚焦；随便看看 → 返回；观看完整短剧 → 详情返回放映 → 返回剧场；深链 `/watch`；目录失败；秘境/对话再点回顶部；聊天返回对话页。
