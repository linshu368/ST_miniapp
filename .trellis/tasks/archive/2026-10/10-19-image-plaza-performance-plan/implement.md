# 执行与验证计划

## 门禁与顺序

1. 用户已授权按规划实施；激活现有任务。先实现独立前端优化，排序/迁移阶段保留 TEST 结构、容量和生产审批门禁。
2. 实现前补读 frontend API/state、UI、quality，backend reliability/security，shared API/change-management，database migrations/RLS 专题及其源文档。
3. 先量测，再独立实现滚动、本地预览、详情反馈；排序按 shared→TEST 加列/一次初始化/索引 migration→repository/route→frontend 推进。固定初始序位替代每页窗口重排。
4. 确认 TEST 连接后才采集结构；MCP 不读业务行。性能实验使用获准的合成数据，不导出生产数据。
5. 跨层完成后执行消费者校验、build、真机回归。实施改变数据库行为时同步 `G:/JobLib/ST_miniapp/README.md`、`G:/JobLib/ST_miniapp/docs/ARCHITECTURE.md` 及相关 spec；本次不提前把设计写成现状。

## 可重复验证矩阵

| 范围          | 场景与判定                                                                                                                                                                                                                          |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 排序          | A/B/C 模型数量 100/10/1、热度跨数量级，含空热度、同分同时间和 1/2/10 赞；初始化完整轮次均衡，有赞按点赞/时间/id且不受固定序位影响，零赞沿固定序位；覆盖获赞/取消至零赞及无序位新作品获赞，过滤不重排模型轮次。                      |
| 分页          | 空/边界/满/末页，静态全集无重漏；页大小不整除模型数量、页中有赞转零赞、跨轮继续、模型耗尽；字面特殊字符搜索和现有标签规则；跨 sort/筛选/版本游标拒绝，旧协议兼容单独验证。                                                          |
| 动态排名      | 页间点赞/取消/新增/下架，记录实时游标限制；去重不冒充快照。失效页链不再混接，刷新恢复。                                                                                                                                             |
| 初始化/数据库 | 初始化失败原子回滚、重复执行保护、并发分享/导入边界、序位唯一正数与新增 NULL、删除空洞/热度修改不重编号；权限无扩大。TEST 1x/10x 及并发 EXPLAIN、首页/深页/搜索、索引点赞写成本，无在线窗口排名。                                   |
| 滚动          | 底部与上滑 >120px 各轮询 30 次；图片延迟/失败、多产物、发送、终态、切会话、键盘/横竖屏/reduced motion；历史不强拉，无变化不重复 smooth。                                                                                            |
| 详情          | feed 进入/深链/返回、冷热缓存、原图慢/失败/签名过期；缩略图不中断，401/404 不被 placeholder 掩盖。                                                                                                                                  |
| 点赞          | 成功、4xx/5xx、超时但服务端成功、连续点击、两作品并发；字段级回滚不覆盖另一作品，所有 feed key 和详情一致；反馈 p95 ≤100ms，成功无需额外确认 GET，不立即重拉全部 feed 页；记录鉴权/RPC/锁等待与端到端 p50/p95，量化服务端优化收益。 |
| 用同款        | 成功一次创建并命中缓存导航；离线/超时/下架提示，不自动重试非幂等创建。                                                                                                                                                              |
| 参考图        | 合法/超限/非法 MIME、读取失败、慢网/失败；A 未完成选 B、移除、切模型/会话、卸载，晚到不覆盖；上传中禁止生成。重复选择/移除 20 次检查 URL 释放与内存趋势。                                                                           |
| 消费者        | schema round-trip、route 校验、frontend key/cursor 透传，所有包 typecheck；无跨应用 import、数据库行类型泄露。                                                                                                                      |

性能：同一设备/WebView、固定网络和冷热缓存条件，基线与修改后每组至少 30 次，记录样本数、中位数、p95、失败数。小样本 p95 仅用于诊断，不冒充生产 SLO。分开记录 API/签名/传输/decode/反馈/导航；跨域 Timing 缺失明确标注。预览 ≤100ms 只计容器与状态反馈，实际图像可见另测；p95 回退 >10% 需复测解释，未解释前阻断发布。

## 验收命令（未来实施）

```text
pnpm --dir "G:/JobLib/ST_miniapp" --filter @miniapp/shared test
pnpm --dir "G:/JobLib/ST_miniapp" --filter @miniapp/backend test
pnpm --dir "G:/JobLib/ST_miniapp" --filter @miniapp/frontend test
pnpm --dir "G:/JobLib/ST_miniapp" -r typecheck
pnpm --dir "G:/JobLib/ST_miniapp" --filter @miniapp/frontend lint
pnpm --dir "G:/JobLib/ST_miniapp" --filter @miniapp/frontend build
pnpm --dir "G:/JobLib/ST_miniapp" --filter @miniapp/admin build
pnpm --dir "G:/JobLib/ST_miniapp" lint:imports
pnpm --dir "G:/JobLib/ST_miniapp" lint:migrations
pnpm --dir "G:/JobLib/ST_miniapp" lint:legacy
git -C "G:/JobLib/ST_miniapp" diff --check
```

执行前核对当前 package scripts；无 build 脚本的包不得编造 build 成功。数据库 runbook 已写入迁移 README，当前没有连接/执行目标，不提供易误用的生产命令。

优先扩展既有测试：`G:/JobLib/ST_miniapp/packages/backend/src/features/image-plaza/repository.list-works.test.ts`、`G:/JobLib/ST_miniapp/packages/backend/src/routes/image-plaza.test.ts`、`G:/JobLib/ST_miniapp/packages/shared/src/__tests__/image-plaza-contracts.test.ts`。已按授权风险范围新增 frontend API 缓存/文件校验回归；上传页面竞态与 SQL 原子性尚需补验证，不能把 helper 测试冒充页面测试。

## 发布与恢复

前端各优化可独立回退；点赞不能用补发反向请求恢复缓存。排序先 TEST 加列/初始化/索引→兼容 backend→frontend→真机→独立批准 production。先内部 Preview，不新建灰度平台。错误率/权限/预算/错引用异常立即停止放量；先回退 UI/backend，序位列/索引保留到无消费者后再单独清理，或 forward-fix。不删除业务数据、不改历史 migration；TEST 序位不直接复制生产。

## 本次规划验证

### 恢复实施基线（2026-10-19）

- 已重新验证 backend 两文件共 12 测试通过；shared Vitest 入口确实缺失。
- frontend typecheck 基线 61 错误，主要是 Vitest 与 workspace reply-renderer 链接缺失。先用 frozen-lockfile 恢复既有依赖，不增加或升级依赖。
- 无浏览器/Telegram 设备与已确认数据库连接，无法采集交互 p95、真实数据库 EXPLAIN；这些作为发布阻断项，不能虚报基线。
- 规划已批准的并发/上传风险回归范围沿用；可按现有 Node Vitest mock-hook 模式新增最小回归文件，不引入 DOM 测试框架。

以下三条为原规划阶段记录；实施最新结果以 verification.md 为准，任务当前 in_progress。真机、性能、数据库实测尚未执行。

- 2026-10-19 重新运行 backend 两个既有文件：`pnpm --dir "G:/JobLib/ST_miniapp/packages/backend" exec vitest run src/features/image-plaza/repository.list-works.test.ts src/routes/image-plaza.test.ts`，2 文件、12 测试通过。
- shared 复核：`pnpm --dir "G:/JobLib/ST_miniapp/packages/shared" exec vitest run src/__tests__/image-plaza-contracts.test.ts`，启动失败，缺少 `G:/JobLib/ST_miniapp/packages/shared/node_modules/vitest/vitest.mjs`。package.json 已声明 Vitest，但本地入口不可用；未安装/升级依赖，未冒称测试通过。
- `git status --short` 仅显示本任务目录未跟踪；`git diff --check` 通过，但该命令不检查未跟踪文件，规划文件另行回读核对。
