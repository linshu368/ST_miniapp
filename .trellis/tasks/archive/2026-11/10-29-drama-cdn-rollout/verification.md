# 当前实现与验证记录

2026-10-29；当前工作区 `/Users/qj/.codex/worktrees/drama-cdn-rollout/ST_miniAPP`，分支 `codex/drama-cdn-rollout`，基于 dev `46159929949e9637859ceed70a2403cdece51fcb`。PR #525 已合dev；本任务生产20%适配仍为未提交内容。未stage／commit／push／新建PR／main合并／部署或生产配置写入，20%开关与12小时计时均未启动。

## 当前内容

生产专用回源和20%稳定分组，服务端实验用户HMAC去重；起播／未缓冲seek／真实五秒快照／恢复根链；每次新播放确认当前地址及关闭恢复；有界只读日志比较。三个新增实现文件为delivery helper、seek观察器和比较脚本，无新表／迁移／依赖／监控服务／测试文件。

适配保留最新dev的v3唯一阶段helper、home/detail归属、Faro质量窗口与接收接口不写分析库；seek不投startup。unified中实验结果全量保留，正式实验还须核验legacy完整start／终态窗口，不能用采样日志或仅慢启动Loki当总分母。

## 最终验证

- Shared：17文件，189 passed。
- Backend：108文件passed／2 skipped，1073 passed／18 skipped。integration缺TEST凭据按既有规则跳过，没有远端集成执行。
- Frontend：63文件，627 passed，含播放相关3文件107项。旧原工作区的media-cache五条断言失败已由上游修复，本轮全前端通过。
- UI：最终完整 `pnpm test:ui --grep @drama` 44 passed（2.1分钟），覆盖390／320两种尺寸、关闭后重新取址、重试保留位置、迟到响应、首播后的独立快进和现有交互。这里只证明固定虚构场景的程序行为。
- `pnpm -r typecheck`、`pnpm -r --if-present build`通过；Frontend/Admin构建成功。UI前置调整后再次运行UI包typecheck通过。
- Frontend lint、imports／legacy／migration guards通过，保留原有img、bundle体积和Browserslist警告。
- 本轮TS／TSX／JSON及已改Markdown的Prettier检查通过；diff空白检查、任务上下文验证通过。
- 模块更新载荷3项单独验证通过，并按最新dev更新预期摘要、三方保留上游知识。完整module检查仍因既有drama-experience缺“当前状态”标题失败，未扩大范围修复旧模块或索引。上下文校验另提示大型backend spec注入会截断；本任务inline已读相应章节。
- 原工作区43项拟提交内容的摘要复核全部未变；旧evidence.json、experiment-closed.png及主目录其他dirty／untracked不纳入本分支。

## 过程中的失败与解决

首次误用了当前Vitest不支持的minWorkers选项，移除后正常执行。相关测试与类型检查同时冷启动时有一条模块导入超过原5秒预算；后续独立低并发完整Backend全部通过，没有放宽时限。

首次UI冷编译首页耗时62秒，完成预热后三条正式入口均200、旧实验入口404。该轮未生成完整报告，一条现有剧场用例媒体停在readyState=1；随后会话不可恢复且自动端口被另一工作区使用。没有终止他人进程；等端口释放后核对fixture root为本工作区，原剧场用例两尺寸按原时限均通过（2 passed）。

完整UI复验首轮43 passed／1 failed；“已在追的继续看”在首帧仍0秒时立即暂停，没建立历史即选集。仅在既有用例显式等待真实currentTime>0再暂停，满足已开始观看的前置；播放器业务、断言和时限不改。定向1 passed（4.1秒），随后最终完整44 passed。

## 生产边界与剩余门禁

仅只读核对生产配置与部署，并读取一部生产私有对象的起始／中段各1024字节：两次206与Content-Range正确，公开路径不可读。实际Bunny账号只有旧TEST用途Zone 6882359；默认生产域名阻断源不代表生产媒体回源，动态视频规则仍指向TEST。生产Frontend配置当前为unified，尚未修改。

生产Bunny专用Zone／签名／热缓存拒绝／源与CDN字节比对，以及真实Telegram iOS／Android起播、未缓冲快进和关闭恢复均未完成。没有生产实验样本，不能宣称每次5秒目标达成。准确证据与下一步见production-preflight.md，发布和首次比较见ops/drama-cdn-rollout.md。

本次为可靠关闭，两个分组都不复用旧播放地址预取，详情预取与后端对象签名缓存保持；新增取址等待由address_wait实测。实验ID／HMAC key需全实例一致并在关闭后保留；日志送达、保留和完整导出仍须验收。后续按最终审核包审批提交、推送及PR，不自动启用生产。
