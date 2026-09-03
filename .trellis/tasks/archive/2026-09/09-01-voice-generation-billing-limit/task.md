# 可执行任务拆分：语音生成收费与 300 字限制

## 状态说明

- `Todo`：尚未开始
- `Doing`：实施中
- `Done`：实现与验证均完成
- `Blocked`：依赖未满足

当前整体状态：`planning`。所有任务须在规划最终确认并执行 `task.py start` 后开始。

## Tasks

| ID       | Status | Task                                                                                             | Files / Scope                                                                          | Depends On                   | Verification                                                                           |
| -------- | ------ | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------- |
| VOICE-01 | Todo   | 扩展 Shared 语音契约：billing、limits、hints、300 字语义                                         | `packages/shared/src/api/voice.ts`、导出与测试                                         | -                            | shared typecheck/test；后端和前端无私有公开 DTO                                        |
| VOICE-02 | Todo   | 新增数据库原子语音计费：扣费事实列、唯一约束、runtime config、`charge_voice_usage` RPC、rollback | `packages/shared/migrations/<new>_voice_billing*.sql`                                  | VOICE-01                     | 测试库验证余额边界、bonus 优先、同 attempt 幂等、不同 attempt 分别收费、事务无部分更新 |
| VOICE-03 | Todo   | 实现语音业务配置与 generation 计费适配                                                           | `packages/backend/src/features/voice/voice-billing-config.ts`、`features/generation/*` | VOICE-01, VOICE-02           | 配置/RPC 单测；runtime config 统一入口；backend typecheck                              |
| VOICE-04 | Todo   | 统一默认/自定义文本处理并增加最终 300 字硬闸门                                                   | `features/voice/voice-prompt.ts`、`voice-draft.ts`、`voice-text.ts` 与测试             | VOICE-01, VOICE-03           | 两类输入均处理；300 放行、301 不调用 TTS；不截断                                       |
| VOICE-05 | Todo   | 改造生成编排、状态收口与成功后原子扣费                                                           | `features/voice/generate.ts`、storage helper、`ChatMessageAudioRepository.ts` 与测试   | VOICE-02, VOICE-03, VOICE-04 | ready 必须已扣 15；同 attempt 不重复扣；重新生成各扣 15；失败不扣                      |
| VOICE-06 | Todo   | 语音路由接线：配置响应、余额预检、动态限制、402/409/400                                          | `packages/backend/src/routes/voice.ts` 与路由测试                                      | VOICE-01, VOICE-03, VOICE-05 | 余额不足不创建 attempt/不调用上游；shared 契约一致；`@frontend-ready` 保留             |
| VOICE-07 | Todo   | 聊天消息展示价格及当前消息行内失败提示                                                           | 聊天页、`components/chat/chat-message-voice.tsx` 与测试                                | VOICE-01, VOICE-06           | 价格可见；超限红字与效果图一致且仅影响当前消息；播放体验无回归                         |
| VOICE-08 | Todo   | 自定义页 300 字限制与收费提示                                                                    | 自定义语音页、`src/lib/api/voice.ts` 与测试                                            | VOICE-01, VOICE-06           | 无法写入第 301 字；超长粘贴截断；无组件级 fetch                                        |
| VOICE-09 | Todo   | 钱包缓存刷新与跨层状态一致性                                                                     | frontend voice/wallet React Query 接线与测试                                           | VOICE-05, VOICE-07, VOICE-08 | ready 后余额减 15；失败/超限不变；无轮询刷新风暴                                       |
| VOICE-10 | Todo   | 全链路验收、对账、安全检查、回滚验证与上线门禁                                                   | 全部受影响包、任务记录、必要 spec/docs                                                 | VOICE-01..09                 | PRD AC1–AC14 均有证据；经年确认上线；全量检查通过                                      |

## 依赖图

```text
VOICE-01
  └─> VOICE-02 ─> VOICE-03 ─> VOICE-04 ─> VOICE-05 ─> VOICE-06
                                                          ├─> VOICE-07 ─┐
                                                          └─> VOICE-08 ─┼─> VOICE-09 ─> VOICE-10
```

## PRD 验收映射

| 验收标准                 | 任务                                   |
| ------------------------ | -------------------------------------- |
| AC1 价格可见             | VOICE-01、VOICE-07、VOICE-08           |
| AC2 首次生成收费         | VOICE-02、VOICE-03、VOICE-05、VOICE-06 |
| AC3 重新生成收费         | VOICE-02、VOICE-05                     |
| AC4 余额前置校验         | VOICE-03、VOICE-06                     |
| AC5–AC6 默认 300/301     | VOICE-04、VOICE-05、VOICE-07           |
| AC7 自定义输入硬限制     | VOICE-08                               |
| AC8 自定义处理后二次校验 | VOICE-04、VOICE-05、VOICE-07           |
| AC9 文本处理失败         | VOICE-04、VOICE-05、VOICE-07           |
| AC10 语音生成失败        | VOICE-05、VOICE-07                     |
| AC11 提示生命周期        | VOICE-07                               |
| AC12 安全性              | VOICE-03、VOICE-06、VOICE-10           |
| AC13 回归体验            | VOICE-07、VOICE-08、VOICE-10           |
| AC14 测试环境验证        | VOICE-02、VOICE-09、VOICE-10           |

## Execution Log

- 2026-09-01：完成需求 PRD、技术设计、实施计划与任务拆分；等待最终规划确认。
