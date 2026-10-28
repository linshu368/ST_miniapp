# 修复 VIP 提醒 Cron 本地 tsx 启动

## Goal

让 development 与 production 的 VIP 到期提醒 Railway Cron 使用镜像内实际存在的项目级
`tsx` 可执行文件启动，避免镜像构建成功后实例在业务日志初始化前崩溃。

## Requirements

- 只调整 `stminiapp-vip-reminder-cron` 的启动命令，不改变调度、数据库变量、业务开关或提醒语义。
- 启动命令必须与 `ops/docker/Dockerfile.backend` 的运行时依赖布局一致，使用
  `./node_modules/.bin/tsx`，不得依赖全局安装。
- 同步更新 Railway IaC、运维文档和既有回归断言，防止后续 apply 恢复错误命令。
- 不新增 Dockerfile、依赖、数据库对象、环境变量或并行调度器。

## Acceptance Criteria

- [x] development 与 production 服务配置均使用项目级 `tsx` 路径。
- [x] 新 deployment 构建成功，Cron 保持 `20 * * * *`、Restart Policy `NEVER`。
- [x] 相关 Backend 回归测试、typecheck 与 `git diff --check` 通过。
- [x] 代码 diff 仅包含 IaC、运维文档、既有测试和本 Trellis 任务记录。

## Notes

- 真实故障：deployment `f77e5da9-f6d7-49a6-b89b-6b028d867fba` 构建成功，但实例在无业务日志时进入 `CRASHED`。
- 最小方案复用支付 Cron 已采用的项目级二进制路径；拒绝新增专用 Dockerfile或修改 `tini`。
- 一次性 Cron 正常退出不是故障；本次修复针对启动命令解析失败。
