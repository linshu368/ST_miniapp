# 实现与验收记录

以下记录对应首次实现与提交前状态（b5a61c45）。后续提交推送已获用户明确授权；PR542合并dev后的行为调整与重新验证以[冲突处理记录](conflict-resolution.md)为准。

## 交付范围

用户批准的六项本地修改均已实现：统一阶段计算、绑定场景、统一release和低基数白名单、补工程看板诊断、实现有门禁的链路收敛、同步规范与操作说明。独立分支 `codex/drama-telemetry-unification`，基线0ca35182（最新dev后继，包含已上线的播放质量监控）。主工作区原有修改未触碰。

核心入口/单调时钟、首帧且playing成功条件、原elapsedMs、媒体src、播放/预取/签名/重试策略不变。新v3保留粗阶段，补四个细分；缺失/逆序不填0，首页/详情与目录起点不再由出口猜测。目录background在owner中记录，避免日志/Faro分类不同；旧版本独立筛选。

## 通过的检查

- Shared全套：17文件、188测试通过；包括计算helper、合法0、缺失/逆序、旧契约兼容及敏感字段拒绝。
- Frontend全套：63文件、610测试通过；最后小幅收敛helper签名/诊断截断判定后，相关owner/observer 40测试再通过；最终Shared188与所有消费者typecheck再通过。
- Backend相关：2文件、22测试通过，覆盖旧开关兼容、诊断不入库、导入/repository双重阻挡、日志失败及原后端分段。
- `pnpm -r typecheck`通过所有包；fresh worktree先生成Prisma Client。
- Frontend默认legacy构建和显式unified构建均通过；统一构建使用本地虚构collector域名，未向Cloud发送合成数据。构建结果确认Grafana/DRAMA release相同。
- release配置3项直接检查通过：实际Vercel SHA覆盖旧标签、非Vercel显式标签共用、缺release时Grafana继续关闭而legacy标签unknown。
- Admin构建通过。Backend没有独立build脚本，由typecheck和相关测试覆盖。
- Frontend lint、legacy guard、migration文件名guard、Prettier、node语法检查和git diff --check通过；原有img/Browserslist/Admin bundle大小警告保留。
- Cloud只读查询：23条新看板源表达式用TEST选择器在Loki执行通过，明细见query-validation.json。此项只证明查询可执行，不证明新数据实收、数值正确或面板渲染。
- 复用既有 `@drama` 页面验收：选中首页换栏目释放视频、首页↔详情续看、失败重试，含窄屏共5项，最终均通过。首轮首次编译57s/41s导致3项超时；预热后失败项2项通过，余1项本地API中断在单独复核中通过（8.3s）。未放宽断言、未改播放器来迁就测试。测试服务已停止。

## 仍未验证或受既有条件限制

- 本轮未发布Backend/Frontend、未更新在线Grafana看板、未修改生产/TEST开关、未写远端数据库或执行迁移，也未提交/推送。
- 新v3和unified的TEST合成往返、真实浏览器/Telegram与生产流量尚未验收；只有查询可执行不能证明替代完成。生产旧客户端、SQL消费者及保留期清理依赖仍待切换前核实。
- Docker daemon未运行，本地Faro→Alloy→Loki容器集成未执行；已同步现有验证脚本的新变量，并完成node语法与Cloud只读表达式检查。
- 本任务3份module-updates载荷独立校验通过。全库Trellis `module_knowledge.py check`仍被基线模块drama-experience.md缺少“当前状态”等必需章节挡住（基线原文件如此，非本轮修改）；本轮不扩展全库文档治理。模块载荷未自动应用/归档，保留最终人工审阅门禁。

## 切换与回滚

先Backend兼容→Frontend默认legacy→TEST/Cloud/真实媒体流程→独立授权unified；只有Faro配置有效才采样详细日志。全量性能统计不采样；慢/所有非成功100%、快成功5%Pino细节不作为全量分母；purpose=diagnostic不进入分析写入/导入。
随后核实旧客户端/消费者，再独立批准关闭旧持久化。表/视图/历史看板/保留期job均保留，不改写历史migration。回滚Frontend构建模式legacy、Backend继续兼容；不得把采样诊断导回分析表。完整操作见docs/drama-playback-timing.md。

## 最终审阅与提交边界

所有产品/规范/源JSON路径及SHA256见review-digest.json；建议一个完整变更单元：`refactor: unify drama timing and engineering monitoring`，文件集合为该摘要列出的27个tracked改动及本任务文档。尚未stage/commit；只有人审最终内容和验证结果后，另获明确提交授权才能提交。之后推送、发布和生产切换仍分别授权。后续模块归档/日志不自动提交。
