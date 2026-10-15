# 验证记录（2026-10-15，本地）

## 已通过

- Shared：15 文件、147 测试；包含 P0 EOF、单选项、坏项残余、变体/别名、围栏、UTF-16 坐标、旧版本和新配置拒绝路径。
- Reply renderer：30 测试；真实 Markdown/可信树渲染验证卡片和单选项点击、单换行围栏隔离与普通代码不产生交互。
- Admin：12 文件、99 测试；配置编辑/保存往返、脏状态、环境隔离和历史差异。
- Backend：82 文件、648 测试（排除既有 integration suite）。
- pnpm -r typecheck；Admin build；Frontend build（含 Next lint/类型）；迁移命名、bash -n、git diff --check。
- Trellis task validate / module_knowledge check；module-updates.json 是待审核载荷，未 archive/apply。

## 本地 PostgreSQL 17.11

独立临时实例，仅 Unix socket，不开放网络。采用现有 text_postprocess_t2 harness，按 postgres 非超级用户作为 migration owner、qj 为本地 adversarial admin。
新 migration 已连续重放两次；source draft/publish/rollback、artifact v1/v2/v3、配置身份绑定、未知字段/错误类型/长度/重复别名/缺字段拒绝及私有 ACL 均通过。原有 text_postprocess_t2.run() 返回 ok，发布/回滚、不可变、当前版本绑定、并发锁等待、旧数据兼容等原专项回归通过，最终 text_postprocess_t2 ok。
完整 run-text-postprocess-t2.sh 在既有 20261013_platform_instruction_slot_windows 前置表缺失处中止（harness 缺 app_core.miniapp_user_settings 等），不是本次 recovery validator 失败。本地用 /private/tmp/run-rich-reply-local.sh 临时副本排除了该 migration、session-scoped/dynamic migration 及 dynamic 场景；其余脚本原样，完成富文本专项。未将此结果记为完整 instruction-slot 迁移链通过。新 migration 的 SQL CASE 括号错误在本地验证时发现并修复，修复后上述专项通过。

## 待人工环境验收

1. TEST 确认目标和前置形状/owner/ACL，单文件执行 20261015_rich_reply_recovery_config.sql。
2. 部署全部 artifact v3 消费者，再在 Admin 开启「解析与兜底」，调整标题/副标题。若旧 CSS 用伪元素覆盖标题，移除对应覆盖后再观察文案。
3. 选择两份新兜底样本，确认单选项可点击，EOF/变体/围栏组合无协议乱码；普通代码与正文不变。
4. 验证只读身份、环境切换、配置错误保留、保存不发布、发布历史/回滚、request unknown 恢复；在 Telegram 真机与窄屏验证流式结束/单次发送。未实际执行这些登录态/真机场景。
5. Production 单独迁移/部署/配置发布和验收。旧快照不回填；回退应用前先发布不含 rich_reply 的旧 source，保留数据库兼容扩展。

本次没有远端写入、迁移、部署或配置发布；未暂存、提交、推送。
