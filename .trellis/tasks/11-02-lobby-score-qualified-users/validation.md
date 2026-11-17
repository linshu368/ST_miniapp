# 本地验证（2026-11-02）

- 基于origin/main b54ea341，独立worktree/branch codex/lobby-score-qualified-users。未提交推送，未迁移/重算生产。
- 规划与最终SQL均经独立审核，无阻断问题。
- 固定验收：`ST_LOBBY_SCORE_BENCHMARK=1 pnpm test:lobby-ranking`，4文件65项通过（55原评分/排序/参数，10真实SQL与容量场景）。
- 本机隔离Postgres17，40万虚构轮次、1万虚构用户，实际生产聚合SQL EXPLAIN ANALYZE耗时1828.397ms，planning0.755ms，shared hit8168 blocks，temp read32667/write23117 blocks。存在排序/物化临时IO；该量级本机约1.83秒，非线上时延承诺，不新建索引/提升work_mem。查询仍只在独立后台连接执行。
- Backend全量116文件1209项通过；Shared18文件229项通过；Backend typecheck通过。
- legacy/static/migration命名/diff检查结果见最终补充。默认backend test排除integration，固定命令显式开本机Docker，绝不读取项目env或远端连接。
- 真实生产只读采集chat_history列结构确认现代列存在，不读取用户聊天内容。没有线上用户数据回放、生产重算或浏览器布局改动。
- 限制：旧记录缺独立完成时刻时以创建时间近似；沿用合格用户的原始发起轮次口径（含失败占位），本轮未扩大成生成质量清洗。筛选后部分卡可能不足20个合格用户，按原冷启动处理。

最终补充：Backend typecheck、变更TS文件ESLint/Prettier、legacy guard、迁移命名检查、git diff --check均通过；一次性PG17容器已清理。独立最终审核确认SQL测试与模块载荷一致，无阻断，module_knowledge apply完成。无前端/运营端产品代码与shared契约变化，不新增浏览器测试；重复性验证入口已加入现有验收README。
