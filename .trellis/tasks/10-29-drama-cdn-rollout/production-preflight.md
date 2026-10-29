# PR #525 合 dev 后的生产发布前检查

日期：2026-10-29。仅本地适配与远端只读检查；没有暂存／提交／推送／新 PR／main 合并／配置发布／CDN 修改／数据库迁移／实验开流。生产媒体验证只读取一部对象的两个 1024 字节范围；源签名为 120 秒短期能力，不记录 URL、对象路径或凭据。

## 发布基线

- PR #525 于 2026-10-29T09:46:20Z 合入 dev，merge SHA `46159929949e9637859ceed70a2403cdece51fcb`。这只包含原 TEST Preview 适配；本任务20%生产适配仍需独立提交和合 dev。
- main 为 `b9d2441841267bcb2b3f21cc584184997ed17ba2`。Railway生产API部署 `d7e6e15a-95b1-4971-8248-7550be7e314f` 为 SUCCESS，来源 main/该 SHA；6个现有服务均为 SUCCESS，无 staged changes。
- main 已由 PR #543／#544 包含角色互动和统一计时。不能把三点提交差异中的角色提交直接当成新生产迁移需求；main 与 dev 两端实际文件差异为29文件，主要是PR #525。正式合 main 前重新核对 refs 和实际合并结果。
- 新工作区 `/Users/qj/.codex/worktrees/drama-cdn-rollout/ST_miniAPP`，分支 `codex/drama-cdn-rollout`，基于上述 dev。原 Bunny 工作区及其既有证据均保留。

## 生产目标和配置

Railway项目 `gallant-insight` / `ce38c0c0-88cd-407a-9c04-06124cd42e97`；environment `production` / `f03d6c61-84e3-434d-a81a-0ae209167ef5`；API `stminiapp` / `8bd593b7-7c40-4ab6-8808-c0863f27a22a`。只读配置确认 DATABASE_ENV=production、Supabase目标=wbtsfzozlmurljvglhpn、鉴权旁路未启用。Bunny五个配置键均未设置，不能宣称生产CDN已准备好。DRAMA_TIMING_PERSIST_ENABLED=true是旧值；当前已部署路由不再据此写分析库，本次不恢复写入。

Vercel项目 `st-miniapp-frontend` / production：当前配置 NEXT_PUBLIC_DRAMA_TIMING_MODE=unified，API目标为对应production服务。这里只确认配置，不能代替新版本实际bundle和日志往返。正式实验需要legacy完整start／终态并冻结版本；本次没有修改此变量。只保留慢启动的Loki流和快速成功5%明细均不能作为总体分母。

## 生产私有源有界实测

只选择一部2,680,080字节生产对象，其路径SHA256为 `979cb8ed400f4b00a4702ec39cf140952bbe2cb24cb2bc008b125a4835736c18`，不保存原路径或源签名。

- 起始1024字节：206，Content-Range与对象大小一致，SHA256 `266de5fe53464212a13f5a0de34db1166c4bc19465fe655121b714eec2e0a246`。
- 72%位置1024字节：206，Content-Range与对象大小一致，SHA256 `2d19ce19fc9d677d3df59b1512765168a32751b44ba3bba82fe5c7b356a5ebdd`。
- 同一对象公开路径返回400，未暴露私有内容。
- 这只证明本次生产源对象的Range与私有路径行为，不证明Bunny、热缓存权限、用户首帧或5秒目标。没有整文件读取、下载或Storage内容写入。

## 尚未通过的生产门禁

1. 用户提供控制台链接后再次只读核对：账号Pull Zones列表只有 `stminiappvid20261028` / 6882359 / `stminiappvid20261028.b-cdn.net`。默认origin为生产域名的 `__cdn_experiment_deny__` 阻断路径；实际规则为旧Single video experiment、Block outside Preview TEST、Preview TEST drama origin三条。最后一条仅将 `/preview-test/*` 动态映射到TEST项目，阻断规则拒绝其他路径；旧单视频规则使用历史临时能力，不能作为生产通用回源。Token鉴权页面存在受保护密钥字段，未读取、修改或轮换。由这些当前证据可确认：尚无独立生产Zone，不能直接套用该节点。
   建议准备独立Zone `stminiapp-drama-production`（最终名称以平台可用性为准），签名Key独立；默认源固定生产项目的阻断路径，只放行 `/production/*` 并以对象级短期源签名回源。创建／规则／配置写入需在明确操作清单后执行，本轮未执行。
2. 待生产Zone可用后，在受控客户端对同对象做源/CDN起始与中段小段字节比较；热缓存下未签名／篡改／过期／替换对象必须拒绝。任一失败不开流。
3. 新生产适配先走 PR → dev 验证，审核后合 main并保持开关false；兼容后端就绪，再验Frontend和完整Pino统计窗口。正式发布前重新核对实际SHA及全部服务。
4. iOS／Android真实Telegram的起播、未缓冲快进、失败保留、关闭重新取址仍需验收。模拟通过不替代真机。
5. 完成上述门禁后另行执行20%开流，记录实际起点；12小时首次比较尚未开始。

精确变量形状、分流与恢复步骤见 `ops/drama-cdn-rollout.md`。无新增数据库对象或本次数据库迁移。
