# 证据与边界

## 输入

- 用户在原因分析后明确要求开始优化页面路由加载显示、请求等待及聊天详情专项。
- 原始对比与专项原因分析位于用户指定E盘参考目录；仓库仅记录安全汇总，不复制日志/业务行。
- 本机安全聚合：chat-conversation-latency-evidence-20261125.json，位于会话附件目录。

## 关键数据

/chat/:id导航3933.5ms/N925；Android4316.835/N778、iOS3219.8/N135。SPA挂载ready分别1836.815/1914.3ms，独立P95不能相减。
conversation_detail逻辑全程整体1662.82ms/N15130；Android1688.765、iOS1550ms。用途混合，不作为entry专属P95。Androidheaders1287.7/body597.635/queue25.5；iOS1250/512.45/7ms。
Railway165条详情诊断：52条正常entry抽样中位129ms，3条慢entry1115/1517/1127ms；慢例分别recover987、page1346、page1030ms。采样集合不能算全量P95。
Sentry路由GET4247ms、长动画帧772ms是样本事实；未证明其占总体3.933秒的固定比例。

## 当前事实与文档差异

Railway生产部署3be49a86-42e6-42a9-8ac4-258b6ac60b72的SHA为c046f213d3752d10bb7172ff8df221a4c96c63ea，包含7f8df915的并行读取。旧docs“尚未部署”标签过时。
源码确认会话入口prefetch=false；聊天page与Splash各有返回/characters预取；角色详情默认critical；entry-phase文档级，quiet-window仅Android；已有页内ready必须新增保护，不泛化修改全站调度。
当前Git分支fix_request_speed，工作区起始干净；不新建worktree，不操作其他任务。

## 仍需上线证据

没有同次visit完全分解的路由/网络/正文/commit预算；没有地域和线路控制实验；不指认CDN/机房或SQL为唯一根因。迁移/投影生产覆盖未查询，不做数据库结论。

缓存实施核查：query-client默认staleTime=30秒，useCharacterQuery原聊天调用未覆盖；会话行已使用60秒。因此额外角色刷新主要出现在数据年龄30–60秒的列表→聊天交接，不是每次进入都重复请求。此次聊天与行统一60秒；详情仍按viewer/session隔离。私有历史自身staleTime=0与创建缓存豁免保持。
