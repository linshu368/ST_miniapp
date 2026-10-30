# 角色数据、权限、审核与上下文版本验证

范围：本地独立分支。未连接生产/TEST 数据库，未发布、未读取用户业务数据。

## 已完成的真实数据库验证

命令：

```bash
CREATOR_TEST_CONTAINER=st-creator-integration-test-20261030 bash scripts/test-creator-characters-local.sh
```

使用 PostgreSQL 17、Docker `network=none`、无主机端口，虚构数据。脚本复用已有分支测试的引擎基线，并逐文件执行真实历史开轮、回复格式、分支、点赞和本次 cover/core/versions 迁移。最近通过库：`creator_core_test_20421`。数据库迁移不由预览接口模拟替代。

覆盖并通过：

- 同一客户端 UUID 创建重试不覆盖稿；另一个作者不能读取/复用该 ID；保存重复请求幂等，旧 revision 的不同内容返回冲突。
- 草稿/首次公开待审不进大厅；私密已知 ID 不能被他人直接取得使用资格。运营环境权限有效。
- 公开角色修改待审时保留原已批准 runtime；保存新稿会废止旧待审快照，旧审核 revision 不能放行新稿。
- 公开转私密移出大厅；曾用/曾收藏者仍可使用，取消收藏/删除一个会话不清除持久资格；无资格的人不能读聚合社交信息。私密再次公开必须重新审核。
- 真实 `start_chat_history_turn_with_current_postprocess` 首次写轮次时固定卡级版本；空会话不固定、开场白可更新。另一空会话在更新后首次发言固定新版本。
- 已开聊读原 prompt，作者旧试聊也读原草稿版；真实重生成、`fork_chat_session` 及分支继续聊均沿用源版本。
- 人为回滚真实开轮事务后，history 和会话绑定一起撤销；版本不可修改，匿名/普通认证角色无源码表和关键 RPC 权限。
- 官方角色不进入新版本机制，运营下架后旧会话保持既有读取行为。

本 SQL 验证覆盖版本 CAS 与真实事务回滚；没有将多连接负载测试描述为已完成。

## 应用验证

- Backend typecheck：通过（包含版本接入后的实际调用签名）。
- Admin typecheck：通过。
- 针对性 backend 回归 5 文件、75 项通过：`generate.lifecycle.test.ts`、`conversation-context.test.ts`、`generate.test.ts`、`conversations-branch.test.ts`、`character-social.test.ts`。
- 生命周期新增覆盖：先真实 startTurn 再按 session 读取卡；首轮使用绑定版的新开场白；绑定版不可用时终结新轮且不调用供应商。
- 修复初次回归发现的接缝：权限工具不提前初始化 Prisma，避免无 DB 的既有路由测试因导入失败；本地明确开启的 DEV_AUTH_BYPASS 身份可读取私密详情。生产匿名公开详情行为保留。

## 实现边界与复用入口

- Shared `api/creator-characters.ts`：完整草稿/附件、封面资产 ID、发布状态、CAS 请求与固定 Markdown 组装。
- Backend `routes/creator-characters.ts` + `features/creator/repository.ts`：owner CRUD、提交/撤大厅、运营环境校验和版本审核。
- `features/creator/access.ts` / runtime RPC：公共大厅发现与已授权使用分开；收藏、社交、建会话与引擎读卡已适配。
- Admin「创作者审核」独立页：待审队列、全文/附件预览、理由、提交版本、环境确认、写入防重复。
- 正式库仍需按顺序应用迁移后再部署相应代码；真实运营账号/存储/供应商链路由主任务单独记录，不能用这份隔离结果宣称线上已验证。

## 静态预设选择增量验证

- 四套目录仅向用户端提供 ID、标题、适用场景和效果。正文来自 backend 私有 UTF-8 文件，客户端请求只能选择白名单 ID，详情 DTO 不返回组装后的完整规则。
- 保存时按目录固定顺序拼接所选规则，再接自定义预设和附件，最后接背景；发布与审核复用保存时的 runtime。改变静态资源本身不会更新已保存卡或已开聊版本。
- 幂等键仅比较客户端草稿与封面意图，排除服务端派生 runtime；相同请求遇到新部署的静态文本也不会覆盖之前成功保存的内容。
- 共享契约 11 项、后端目录解析 2 项通过。目录解析测试以 SHA256 比较读取内容和私有文件，不输出规则正文。Shared typecheck 通过。
- 真实 PG17 全套 core 回归再次通过：`creator_core_test_20735`，覆盖新增的派生 runtime 改变后的保存重试。
- Backend 整体验证交由主任务收尾；本次检查发现的并行计费/润色测试类型接缝已反馈对应负责人。
