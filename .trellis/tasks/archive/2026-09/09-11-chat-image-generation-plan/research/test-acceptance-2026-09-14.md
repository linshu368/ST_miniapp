# Test 环境与本地验收记录（2026-09-14）

## 验收基线

- 分支/工作树：`feat_image_chat`，基线 HEAD `ee4fd66`；本记录覆盖当前未提交 T4/T6/T8 工作树。
- 用户已确认 `20260914_chat_message_images.sql` 在 test 执行；本机不读取业务行、不代替远端 shape/锁/权限验收。
- 功能开关保持 `image_generation_enabled=false`，production 未发布。

## 本地自动化结果

| 检查                               | 结果                                                                  |
| ---------------------------------- | --------------------------------------------------------------------- |
| shared typecheck/test              | 通过；7 files / 43 tests                                              |
| backend typecheck/test             | 通过；46 files / 401 tests                                            |
| frontend typecheck/test/lint/build | 通过；16 files / 72 tests；0 lint warning；Next production build 成功 |
| `pnpm -r typecheck`                | 通过（shared/backend/frontend/admin/cs-platform）                     |
| migration/legacy guard             | `pnpm lint:migrations`、`pnpm lint:legacy` 通过                       |
| module knowledge                   | `module_knowledge.py check` 通过                                      |
| patch whitespace                   | `git diff --check` 通过（仅 Windows LF→CRLF 提示）                    |

已知仓库基线工具问题：

- `pnpm lint:imports` 在 Windows 上因 package script 将 `--rule '{}'` 作为字符串传给 ESLint 而退出 2；不是本次图片代码命中 import 规则。
- 根 `pnpm format:check` 会报告约 550 个既有文件格式漂移；本次改动路径已单独执行 Prettier。

## 源码故障矩阵核验

- 配置/secret 缺失：路由 fail closed 为 503，不创建 attempt；secret 不进入 runtime config/响应。
- 输入：shared 与 route 共用 1~200 字校验；自定义提交不调用 description API。
- 并发：DB partial unique 限制同 message active attempt/current；claim 使用 `FOR UPDATE SKIP LOCKED`。
- 恢复：DeepSeek 翻译期间保持 leased，可在租约过期后恢复；写入 provider dispatch 边界后不再自动重领。
- 模糊失败：Grok POST 网络/超时收口 `failed_unknown`，不自动二次出图、不扣费。
- 下载：仅 HTTPS，每次 redirect 重新校验，拒绝私网/loopback，限制 redirect、MIME 与流式累计字节。
- 计费：Storage 后调用原子 RPC；明确余额竞争失败删除对象；结算响应未知不覆盖 ready/不删除对象，保留 storing 待幂等对账。
- 日志：记录 ID、阶段、状态、字节与耗时；不记录中文稿、英文 prompt、secret、图片正文或 provider 临时 URL。

## 必须在 test 环境补录的外部证据

以下项目受凭证、真实部署或设备限制，**尚未通过，不得把 T7/T8 写成上线完成**：

1. DeepSeek 默认写稿与两路翻译、Grok 成功/明确失败/429/模糊超时的真实接口回归。
2. 202/402/409/422/503 HTTP 映射、Storage 上传/读取/删除补偿、wallet/ledger/attempt 对拍。
3. claim 多实例、provider 前重启恢复、settlement RPC 重放、锁等待、RLS/grants、rollback guard。
4. 图 1~9、窄屏/软键盘/safe area/reduced motion、图片在语音上方、旧 ready + latest failed。
5. Telegram Android/iOS/desktop Dialog 关闭、焦点恢复与系统长按保存差异。

## 发布顺序、停止与恢复

1. test migration/bucket（已执行，证据待补）→ test secret/runtime config → backend → frontend → 开开关 smoke。
2. 完成上述真实验收后，production 依次执行 migration/bucket → secret/config → backend → frontend；开关仍保持关闭。
3. 小流量开启并监控成功率、P95、429、计费/ready 不一致和孤儿对象。
4. 5 分钟成功率 <90%、P95 >90 秒、连续计费不一致、孤儿持续增长或 provider 429 >10% 时立即关新受理；runner 收口已接单任务。必要时关闭 `IMAGE_WORKER_ENABLED` 并只读盘点。
5. 回滚应用不删除 attempt/ledger；数据库异常使用后续 migration forward-fix，不改写已执行 migration。
