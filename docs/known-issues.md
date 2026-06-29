# Known Issues

本文件登记已知、已分析根因、但**当前里程碑不修**的问题，避免被重复当作回归。

---

## KI-001 · st-bundle consumer 在占位 Supabase cred 下持续报 `Invalid schema: st_infra`

- **状态**：已知 / 暂不处理（非阻断）
- **登记里程碑**：M4（docker-compose 编排）
- **复现条件**：用 `.env.compose.example` 的占位 Supabase 凭证（`SUPABASE_URL=https://placeholder.supabase.co` 等）`docker compose up` 后，观察 `docker compose logs st-backend`。

### 现象

`st-backend` 容器内 sync-engine 的 **consumer** 每 ~10s（`pollIntervalMs=10000`）打印一条 pino `level:50`（ERROR 级）日志：

```
{"level":50,...,"module":"consumer","err":"Invalid schema: st_infra","msg":"查询 pending 任务失败"}
```

注意：该日志为**中文 message + 数字 level**，英文 token 级 grep（`ERROR/FATAL/panic/...`）无法命中；需用 `grep '"level":50'` 才能发现。

### 影响范围

- **仅 `st-backend` 容器**：M4 验收实测 `backend / frontend / nginx` 三者 `level:50` 计数均为 **0**，`st-backend` 为 19（随运行时长线性累积）。
- **不影响健康判定**：HEALTHCHECK 只探 ST(8000) + provision-api(9091)，二者与 consumer 解耦；四容器仍全部 `(healthy)`。
- **不影响 M4 烟雾测试**：`/`、`/api/payment/plans`、`/tavern/`、`/provision-api/health` 四条全绿（200/200/302/200）。
- **不造成崩溃/重启**：consumer 捕获错误后继续轮询，进程不退出、不 crash-loop。

### 根因

1. 冻结的 **M1 st-bundle 镜像**在 `/home/node/app/data`（镜像 `VOLUME`）内**预置了 2 个 `tg_*` 用户目录**。
2. docker-compose 使用 named volume `st-mongo-data` 挂载该路径；Docker 在**首次挂载空卷时会用镜像内容初始化卷**，于是这 2 个目录被复制进卷。
3. sync-engine **watcher** 因此越过「未发现 `tg_*` 目录则 warn 并提前退出」的分支，进入第 6 步**启动 consumer**。
4. consumer 周期性查询 Supabase 的 `st_infra` schema 的 pending 任务表；在**占位 cred**下，PostgREST/Supabase 拒绝该 schema → 返回 `Invalid schema: st_infra`。
5. M4 红线「禁止真实密钥落盘」要求只用占位值，使该错误成为**确定性产物**。

结论：此问题**由「冻结 M1 镜像 + 占位凭证」的组合必然产生，并非 M4 编排（docker-compose / Dockerfile.frontend）引入**。M4 的环境注入（`PROVISION_API_BIND_HOST=0.0.0.0`、各 env）均正确。

### 云端预期行为

在真实云端部署中注入**真实 Supabase 凭证**（test/prod 凭证组，且 `st_infra` schema 已在 PostgREST 暴露）后：

- consumer 查询成功，`level:50` 日志消失；
- watcher / consumer 进入正常的反向同步工作流。

即：该错误是**本地占位凭证专属噪声**，不会出现在配置正确的云端环境。

### 处置时机

- **M4 不修**：修复需「真实凭证（违反红线）」或「改动冻结的 M1 st-bundle / sync-engine（越权）」，二者均超出 M4 授权范围。
- **M6 后回看**：在云端凭证与 schema 暴露策略定稿后复核；评估是否需要 (a) consumer 在 schema 不可用时降噪到 warn + 退避重试，或 (b) 启动时按数据目录是否含真实用户决定是否拉起 consumer。届时若仍需改动 st-bundle，归入对应里程碑处理。
