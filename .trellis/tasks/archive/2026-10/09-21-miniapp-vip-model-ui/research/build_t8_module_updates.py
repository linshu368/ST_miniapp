#!/usr/bin/env python3
"""Build module-updates.json for VIP T8. Does not apply or archive."""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / ".trellis/scripts"))
from module_knowledge import baseline_check  # noqa: E402

TASK = ".trellis/tasks/09-21-miniapp-vip-model-ui/"
VERIFIED_AT = "2026-09-24"
HISTORICAL_TASK = {
    ".trellis/spec/admin/app/modules/infrastructure/admin-client-auth.md": ".trellis/tasks/09-11-batch-lab-frontend-workbench/",
    ".trellis/spec/backend/app/modules/infrastructure/runtime-data-security.md": ".trellis/tasks/09-11-batch-lab-integration-spec/",
    ".trellis/spec/database/supabase/modules/business/conversation-storage.md": ".trellis/tasks/09-11-batch-lab-integration-spec/",
    ".trellis/spec/database/supabase/modules/infrastructure/schema-security.md": ".trellis/tasks/09-11-batch-lab-integration-spec/",
    ".trellis/spec/shared/contracts/modules/business/conversation-contracts.md": ".trellis/tasks/09-11-batch-lab-integration-spec/",
}

MODULES = {
    "admin.business.operations": ".trellis/spec/admin/app/modules/business/operations.md",
    "frontend.business.conversation-ui": ".trellis/spec/frontend/app/modules/business/conversation-ui.md",
    "frontend.business.engagement-support": ".trellis/spec/frontend/app/modules/business/engagement-support.md",
    "frontend.business.wallet-payment": ".trellis/spec/frontend/app/modules/business/wallet-payment.md",
    "frontend.infrastructure.client-ui-foundation": ".trellis/spec/frontend/app/modules/infrastructure/client-ui-foundation.md",
    "backend.business.conversation-generation": ".trellis/spec/backend/app/modules/business/conversation-generation.md",
    "backend.business.engagement-support": ".trellis/spec/backend/app/modules/business/engagement-support.md",
    "backend.business.voice-message": ".trellis/spec/backend/app/modules/business/voice-message.md",
    "backend.business.wallet-payment": ".trellis/spec/backend/app/modules/business/wallet-payment.md",
    "backend.infrastructure.runtime-data-security": ".trellis/spec/backend/app/modules/infrastructure/runtime-data-security.md",
    "shared.business.conversation-contracts": ".trellis/spec/shared/contracts/modules/business/conversation-contracts.md",
    "shared.business.engagement-support-contracts": ".trellis/spec/shared/contracts/modules/business/engagement-support-contracts.md",
    "shared.business.wallet-payment-contracts": ".trellis/spec/shared/contracts/modules/business/wallet-payment-contracts.md",
    "database.business.billing-payment": ".trellis/spec/database/supabase/modules/business/billing-payment.md",
    "database.business.conversation-storage": ".trellis/spec/database/supabase/modules/business/conversation-storage.md",
    "database.infrastructure.schema-security": ".trellis/spec/database/supabase/modules/infrastructure/schema-security.md",
}

SUMMARIES = {
    "admin.business.operations": "记录 Admin VIP策略复用草稿发布，不直写 runtime_config",
    "frontend.business.conversation-ui": "记录模型入口迁到顶部胶囊，以及媒体免费序号的两种展示口径",
    "frontend.business.engagement-support": "记录 VIP 到期详情和单条消息已读",
    "frontend.business.wallet-payment": "记录 VIP 页、充值互斥选择和服务端权益展示",
    "frontend.infrastructure.client-ui-foundation": "记录 VIP 状态继续走现有 React Query client，不新增状态库",
    "backend.business.conversation-generation": "记录 VIP 折扣快照、模型权限和高级图片门禁",
    "backend.business.engagement-support": "记录到期提醒脚本、单条详情和按 id 已读",
    "backend.business.voice-message": "记录语音免费预留与失败释放",
    "backend.business.wallet-payment": "记录 VIP 订单履约、签到加成和原路退款",
    "backend.infrastructure.runtime-data-security": "记录 VIP 策略只通过 runtime-config 读取",
    "shared.business.conversation-contracts": "记录模型折扣、图片档位和免费额度契约",
    "shared.business.engagement-support-contracts": "记录 vip_expiry 通知与单条已读目标",
    "shared.business.wallet-payment-contracts": "记录 VIP 商品、状态和支付订单快照契约",
    "database.business.billing-payment": "记录会员、履约、免费额度和退款表",
    "database.business.conversation-storage": "记录语音和图片 attempt 的计费快照列",
    "database.infrastructure.schema-security": "记录 VIP migration 的单文件、RLS 和 Production 未执行边界",
}

EVIDENCE = {
    "admin.business.operations": [
        "packages/admin/src/components/VipStrategyView.tsx",
        "packages/admin/src/lib/vipStrategyForm.ts",
        "packages/shared/src/api/vip-strategy.ts",
    ],
    "frontend.business.conversation-ui": [
        "packages/frontend/src/components/chat/chat-top-bar.tsx",
        "packages/frontend/src/components/chat/chat-model-switcher.tsx",
        "packages/frontend/src/components/chat/chat-message-image.tsx",
        "packages/frontend/src/lib/vip/presentation.ts",
    ],
    "frontend.business.engagement-support": [
        "packages/frontend/src/app/(main)/profile/messages/[id]/page.tsx",
        "packages/frontend/src/app/(main)/profile/messages/page.tsx",
        "packages/frontend/src/lib/vip/presentation.ts",
    ],
    "frontend.business.wallet-payment": [
        "packages/frontend/src/app/(main)/vip/page.tsx",
        "packages/frontend/src/app/(main)/profile/page.tsx",
        "packages/frontend/src/lib/api/vip.ts",
        "packages/frontend/src/components/payment/vip-plan-card.tsx",
    ],
    "frontend.infrastructure.client-ui-foundation": [
        "packages/frontend/src/lib/api/client.ts",
        "packages/frontend/src/lib/api/vip.ts",
    ],
    "backend.business.conversation-generation": [
        "packages/backend/src/routes/models.ts",
        "packages/backend/src/routes/conversations.ts",
        "packages/backend/src/routes/images.ts",
        "packages/backend/src/features/generation/",
    ],
    "backend.business.engagement-support": [
        "packages/backend/src/routes/notifications.ts",
        "packages/backend/src/scripts/send-vip-expiry-reminders.ts",
        ".railway/railway.ts",
    ],
    "backend.business.voice-message": [
        "packages/backend/src/routes/voice.ts",
        "packages/backend/src/features/voice/",
        "packages/shared/migrations/20260922_media_feature_free_trials.sql",
    ],
    "backend.business.wallet-payment": [
        "packages/backend/src/routes/payment.ts",
        "packages/backend/src/routes/wallet.ts",
        "packages/backend/src/routes/vip.ts",
        "packages/backend/src/features/payment/",
    ],
    "backend.infrastructure.runtime-data-security": [
        "packages/backend/src/platform/runtime-config.ts",
        "packages/backend/src/platform/vip-strategy.ts",
    ],
    "shared.business.conversation-contracts": [
        "packages/shared/src/api/models.ts",
        "packages/shared/src/api/images.ts",
        "packages/shared/src/api/feature-free-trials.ts",
    ],
    "shared.business.engagement-support-contracts": [
        "packages/shared/src/api/notifications.ts",
        "packages/shared/src/api/vip.ts",
    ],
    "shared.business.wallet-payment-contracts": [
        "packages/shared/src/api/payment.ts",
        "packages/shared/src/api/vip.ts",
        "packages/shared/src/api/wallet.ts",
    ],
    "database.business.billing-payment": [
        "packages/shared/migrations/20260921_vip_billing_schema.sql",
        "packages/shared/migrations/20260921_vip_payment_fulfillment.sql",
        "packages/shared/migrations/20260921_wallet_debit_refund.sql",
        "packages/shared/migrations/20260924_vip_plans_price_1_and_2_yuan.sql",
    ],
    "database.business.conversation-storage": [
        "packages/shared/migrations/20260922_media_feature_free_trials.sql",
        "packages/shared/migrations/20260914_chat_message_images.sql",
    ],
    "database.infrastructure.schema-security": [
        "packages/shared/migrations/20260921_vip_billing_schema.sql",
        "packages/shared/migrations/20260923_vip_expiry_reminder_dispatch.sql",
        "docs/ARCHITECTURE.md",
    ],
}


def set_meta(text: str, key: str, value: str) -> str:
    lines = text.splitlines()
    end = lines.index("---", 1)
    prefix = f"{key}:"
    for index in range(1, end):
        if lines[index].startswith(prefix):
            lines[index] = f"{key}: {value}"
            return "\n".join(lines) + ("\n" if text.endswith("\n") else "")
    insert_at = end
    for index in range(1, end):
        if lines[index].startswith("last_verified_at:"):
            insert_at = index
            break
    lines.insert(insert_at, f"{key}: {value}")
    return "\n".join(lines) + ("\n" if text.endswith("\n") else "")


def set_section(text: str, name: str, body: str) -> str:
    marker = f"## {name}\n"
    start = text.find(marker)
    if start < 0:
        raise SystemExit(f"missing section {name}")
    rest_at = start + len(marker)
    next_heading = text.find("\n## ", rest_at)
    replacement = marker + "\n" + body.strip() + "\n"
    if next_heading < 0:
        return text[:start] + replacement
    return text[:start] + replacement + text[next_heading:]


def repair_module_files() -> None:
    for path in sorted((ROOT / ".trellis/spec").glob("**/modules/*/*.md")):
        if path.name == "index.md":
            continue
        raw = path.read_bytes()
        text = raw.decode("utf-8-sig")
        relative = path.relative_to(ROOT).as_posix()
        if "last_verified_task:" not in text.split("---", 2)[1]:
            historical = HISTORICAL_TASK.get(relative)
            if not historical:
                raise SystemExit(f"missing historical task for {relative}")
            text = set_meta(text, "last_verified_task", historical)
        encoded = text.encode("utf-8")
        if encoded != raw:
            path.write_bytes(encoded)


def render(module_id: str) -> str:
    path = ROOT / MODULES[module_id]
    text = path.read_text(encoding="utf-8")
    text = set_meta(text, "last_verified_task", TASK)
    text = set_meta(text, "last_verified_at", VERIFIED_AT)
    for name, body in SECTIONS[module_id].items():
        text = set_section(text, name, body)
    return text if text.endswith("\n") else text + "\n"


SECTIONS: dict[str, dict[str, str]] = {
    "admin.business.operations": {
        "职责与边界": "管理模型/运行配置、角色卡、公告、邀请规则、回访赠送，以及 VIP 商品和权益策略。",
        "当前状态": "主要运营页面已集中在 Admin SPA。VIP策略复用现有草稿、发布、版本、回滚和环境隔离，发布前走 shared schema 校验。它不直写 `runtime_config`，也不配置提醒文案、提前天数、时区、语音价格或高级图片供应商。",
        "涉及文件": """| 路径                                                        | 职责           |
| ----------------------------------------------------------- | -------------- |
| `packages/admin/src/components/VipStrategyView.tsx`         | VIP策略表单    |
| `packages/admin/src/lib/vipStrategyForm.ts`                 | VIP策略校验    |
| `packages/admin/src/components/ModelCatalogEditor.tsx`      | 模型配置       |
| `packages/admin/src/components/CharacterCardsView.tsx`      | 角色卡         |
| `packages/admin/src/components/AnnouncementsView.tsx`       | 公告           |
| `packages/admin/src/components/InviteProgramView.tsx`       | 邀请计划       |
| `packages/admin/src/components/OutreachCreditGrantView.tsx` | 回访赠送       |""",
        "关键实现链路": "登录/环境 → VIP策略或既有表单校验 → Admin 发布链路 → 已发布 runtime config。已创建订单、已受理生成和已领取签到继续使用各自快照。",
        "已知缺口与待核验项": "Production 的 VIP 配置发布需要产品在 T9 明确批准。TEST 购买和提醒开关的最近回读记录在任务日志，本文件不把 test 当前价写成代码默认值。",
    },
    "frontend.business.conversation-ui": {
        "当前状态": "自研聊天 UI、SSE、工具箱、语音和图片交互代码已落地。模型入口在角色名下方的引擎胶囊，工具箱不再包含模型行。非 VIP 点标准或旗舰时展示 VIP 路径，价格和权益读接口。语音和初级图片的已生成内容展示本次 attempt 快照，发起或重试按钮展示下一次额度；失败不把下一序号显示成已消耗。图片 telemetry 仍只记录 ID、状态、长度、耗时、价格/尺寸摘要和错误码。",
        "涉及文件": """| 路径                                                           | 职责                                            |
| -------------------------------------------------------------- | ----------------------------------------------- |
| `packages/frontend/src/app/chat/[characterId]/page.tsx`        | 会话页、图片 footer 接线、`chat_image` 充值来源 |
| `packages/frontend/src/components/chat/chat-top-bar.tsx`       | 顶部引擎胶囊                                    |
| `packages/frontend/src/components/chat/chat-model-switcher.tsx`| 模型面板与 VIP 门禁提示                         |
| `packages/frontend/src/components/chat/`                       | 聊天组件                                        |
| `packages/frontend/src/components/chat/chat-message-image.tsx` | 图片面板、结果卡、预览与图片事件调用            |
| `packages/frontend/src/lib/vip/presentation.ts`                | VIP 与媒体展示纯函数                            |
| `packages/frontend/src/lib/image-generation/telemetry.ts`      | 图片生成前端事件 helper 与去重                  |
| `packages/frontend/src/lib/api/conversation-stream.ts`         | SSE client                                      |
| `packages/frontend/src/hooks/use-chat-session.ts`              | 会话生命周期                                    |
| `packages/frontend/src/hooks/use-conversation-turn.ts`         | 发送/重生成编排                                 |
| `packages/frontend/src/lib/recharge-redirect.ts`               | 充值跳转收口                                    |
| `packages/frontend/src/lib/api/images.ts`                      | 图片查询与 mutation                             |""",
        "关键实现链路": "页面接线 → session/turn hooks → SSE 与气泡收敛。顶部胶囊读取模型目录和 VIP 状态；输出中的切换不影响当前回复。图片 query 在存在非终态 attempt 时轮询，成功、失败和额度变化后刷新配置与钱包。图片 402 跳充值传入 `triggerSource: 'chat_image'`。",
        "已知缺口与待核验项": "2026-09-24 VIP 真机验收已通过。图片 runtime 开关仍默认关闭；图稿逐项、Telegram 长按保存和 PostHog Preview 事件不因 VIP 验收视为完成。",
    },
    "frontend.business.engagement-support": {
        "当前状态": "个人中心相关入口与主要查询/变更操作已落地。消息列表点击单条后进入详情并按该 id 已读；VIP 到期详情用通知 metadata 区分即将到期和今日到期，当前权益另读 VIP status。历史正文不因续费改写。",
        "涉及文件": """| 路径                                                                | 职责                   |
| ------------------------------------------------------------------- | ---------------------- |
| `packages/frontend/src/app/(main)/profile/page.tsx`                 | 个人中心               |
| `packages/frontend/src/app/(main)/profile/messages/page.tsx`        | 消息列表               |
| `packages/frontend/src/app/(main)/profile/messages/[id]/page.tsx`   | 消息详情与 VIP 续费    |
| `packages/frontend/src/lib/vip/presentation.ts`                     | 到期文案格式化         |
| `packages/frontend/src/components/profile/`                         | 社区/邀请组件          |
| `packages/frontend/src/lib/api/`                                    | 互动、通知与客服 hooks |""",
        "关键实现链路": "列表 → 单条详情 → 按 id 调用已读 → 返回后刷新未读缓存。到期页的续费入口去 VIP 页，不在详情里改会员状态。",
        "已知缺口与待核验项": "Telegram 社区跳转与真实成员校验仍需按原功能单独验证。VIP 消息详情的 TEST 真机验收已在 2026-09-24 通过。",
    },
    "frontend.business.wallet-payment": {
        "职责与边界": "展示余额、消费、签到、充值套餐、VIP 套餐、订单状态和支付回跳。不在浏览器里决定入账或会员到期。",
        "当前状态": "钱包、VIP 和支付页面使用统一 API hooks。我的页展示总额和专项余额，VIP 与星尘充值入口分列。充值页星尘和 VIP 档位互斥。权益、价格、天数和赠送星尘读取已发布数据；字段缺失时不补默认折扣或金额。",
        "入口与调用者": "用户从个人中心进入钱包、VIP 或充值流程。个人中心「星尘充值」点击同步建立独立充值 Replay context，SDK 启动尝试后发送 `recharge_entry_clicked`。外部支付前暂停 MiniApp 录制，可信回流后恢复。",
        "涉及文件": """| 路径                                                  | 职责                     |
| ----------------------------------------------------- | ------------------------ |
| `packages/frontend/src/app/(main)/profile/page.tsx`   | 个人中心余额与 VIP 入口  |
| `packages/frontend/src/app/(main)/vip/page.tsx`       | VIP 权益与套餐           |
| `packages/frontend/src/app/(main)/profile/recharge/`  | 充值页面                 |
| `packages/frontend/src/app/(main)/profile/orders/`    | 订单页面                 |
| `packages/frontend/src/app/(main)/profile/spending/`  | 消费页面                 |
| `packages/frontend/src/components/payment/vip-plan-card.tsx` | VIP 套餐卡        |
| `packages/frontend/src/lib/api/vip.ts`                | VIP status hooks         |
| `packages/frontend/src/lib/payment/flow-telemetry.ts` | 支付漏斗与入口点击事件   |
| `packages/frontend/src/lib/api/free-quota.ts`         | 额度 hooks               |
| `packages/frontend/src/lib/api/payment.ts`            | 支付 hooks               |""",
        "关键实现链路": "套餐/余额/VIP status query → 创建订单 → 外部支付 → 订单轮询/回跳 → 缓存刷新。购买开关关闭时前端不伪造可购买状态。",
        "已知缺口与待核验项": "2026-09-24 TEST 真机已覆盖 VIP 购买展示和支付入口。Production 购买开关仍未按本任务打开。",
    },
    "frontend.infrastructure.client-ui-foundation": {
        "当前状态": "API 与 server state 已集中，Tailwind/shadcn 作为 UI 基础。VIP status、套餐和消息详情都通过现有 React Query hooks 与 REST client 获取，没有新增 Zustand 会员库。业务侧 PostHog 事件复用 `getReplayLifecycle().capture` 与 shared telemetry schema；缺 PostHog 公开配置、host 非 HTTPS 或 SDK 失败时前端 telemetry no-op。",
        "涉及文件": """| 路径                                                      | 职责                                         |
| --------------------------------------------------------- | -------------------------------------------- |
| `packages/frontend/src/lib/api/client.ts`                 | REST client                                  |
| `packages/frontend/src/lib/api/vip.ts`                    | VIP query/mutation                           |
| `packages/frontend/src/lib/api/`                          | Query hooks                                  |
| `packages/frontend/src/lib/telemetry/`                    | PostHog adapter、lifecycle、masking 与 owner |
| `packages/frontend/src/lib/payment/flow-telemetry.ts`     | 支付/回流事件 helper                         |
| `packages/frontend/src/lib/image-generation/telemetry.ts` | 图片生成事件 helper                          |
| `packages/frontend/src/components/ui/`                    | 公共 UI                                      |
| `packages/frontend/src/stores/`                           | 跨组件客户端状态                             |""",
    },
    "backend.business.conversation-generation": {
        "职责与边界": "负责会话、消息、Prompt、SSE、LLM 生成计费及角色回复图片生成，不承载前端展示。图片生成 PostHog 终态事件是业务收口后的非关键观测，不改变状态机或扣费结果。",
        "当前状态": "自研会话链路已上线。有效 VIP 的文本折扣在受理时写入计费快照；模型目录、选择和生成都由后端校验 VIP 与可用钱包。到期后的高级模型选择回落轻量。图片生成代码已落地但 runtime 开关默认关闭。高级图片要求有效 VIP，初级图片可按已发布上限使用免费次数。结算响应未知不发送成功或失败事件。",
        "入口与调用者": "Frontend 调用 `/api/v1/conversations*`、`/api/v1/models/config`、`POST /api/v1/models/select`，以及 `/api/v1/images/config`、会话图片查询、描述和图片创建端点。",
        "关键实现链路": "聊天链路保持鉴权、原子开轮、SSE 和 history/计费收口。VIP 折扣与钱包分配进入 generation 计费出口，route 不直接改余额。图片链路在受理时区分 basic/advanced；advanced 非 VIP 拒绝。成功转存 Storage 后才原子结算。",
        "关键节点与约束": "流前错误使用 HTTP；响应头发出后使用流内 error。聊天与图片上游适配不得旁路 `features/generation`。已受理快照不因后续折扣或目录改价重算。图片事件不得包含 prompt 正文、图片 URL、Storage path、provider request id 或错误 body。",
        "已知缺口与待核验项": "角色卡更多人设字段和自建预设格式仍待后续任务。图片真实上游、Storage 和生产开放仍待单独验收。VIP 文本折扣和模型门禁的自动化回归已在 backend tests 中覆盖。",
    },
    "backend.business.engagement-support": {
        "当前状态": "主要互动 API 已实现。VIP 到期提醒由独立脚本按 Asia/Shanghai 窗口幂等插入官方通知；`--write` 只有在 `vip_reminders_enabled` 恰好为 true 时才写入。消息详情校验可见性，已读只接受具体 id。",
        "涉及文件": """| 路径                                                         | 职责           |
| ------------------------------------------------------------ | -------------- |
| `packages/backend/src/routes/wishes.ts`                      | 许愿 API       |
| `packages/backend/src/routes/community.ts`                   | 社区奖励       |
| `packages/backend/src/routes/notifications.ts`               | 消息列表详情已读 |
| `packages/backend/src/scripts/send-vip-expiry-reminders.ts`  | 到期提醒脚本   |
| `packages/backend/src/routes/support.ts`                     | 用户客服       |
| `.railway/railway.ts`                                        | development Cron |""",
        "关键实现链路": "提醒脚本先读开关。dry-run 只计数；write 在开关打开时调用数据库幂等插入。通知 route 鉴权后按 id 返回详情，read 缺少 id 时返回 400。",
        "已知缺口与待核验项": "TEST 提醒开关和 development Cron 已在 2026-09-24 任务日志中回读。Production 不声明 Reminder Cron，也未打开 Production 提醒开关。",
    },
    "backend.business.voice-message": {
        "当前状态": "DeepSeek 写稿、MiniMax TTS、Storage 落盘、重生成和当前语音查询已实现。成功免费次数按已发布 `feature_free_trial_limits.voice` 预留，失败释放，不和初级图片共用名额。超过上限后只扣充值钱包。`voice_billing_enabled` 仍单独决定按次扣费是否开启。",
        "关键实现链路": "ownership/配置 → 免费预留或充值钱包预检 → pending → 写稿或自定义文本 → TTS → Storage → ready/failed。失败路径释放预留，不把下一次序号写成已消耗。",
        "数据、契约与外部依赖": "依赖 experience.chat_message_audio、billing.feature_free_trials、Storage、DeepSeek、MiniMax 和 shared voice/免费额度契约。",
        "已知缺口与待核验项": "真实上游时序和移动端音频播放仍按语音功能单独验证。VIP 免费次数规则已有 migration 和任务验收记录。",
    },
    "backend.business.wallet-payment": {
        "职责与边界": "负责余额/消费查询、签到奖励、充值与 VIP 订单、支付回调、对账结算和会员履约。",
        "当前状态": "支付 webhook/return/query/cron 四路结算已统一到幂等出口。VIP 订单在同一履约里延长会员，并按商品快照把赠送星尘记入专项钱包。购买开关关闭时拒绝新建 VIP 订单。有效会员签到按已发布加成额外发放；普通签到只用基础值。bonus 星尘发放仍统一由 `billing.grant_bonus_credits` 完成。",
        "涉及文件": """| 路径                                     | 职责            |
| ---------------------------------------- | --------------- |
| `packages/backend/src/routes/wallet.ts`  | 钱包与签到      |
| `packages/backend/src/routes/payment.ts` | 支付 API        |
| `packages/backend/src/routes/vip.ts`     | VIP 状态与角标  |
| `packages/backend/src/features/payment/` | 支付与履约用例  |
| `packages/backend/src/features/vip/`     | 会员资格读取    |""",
        "关键实现链路": "鉴权/验签 → 订单固化商品快照 → 四路进入同一结算 → 原子履约会员、专项星尘和流水。退款按原扣款拆分幂等恢复两个钱包。",
        "关键节点与约束": "订单、流水、余额口径分离。同一 VIP 订单重复确认只履约一次。应用层禁止手动修改 bonus 余额，也禁止用配置回滚改写已履约期限。",
        "已知缺口与待核验项": "支付 remediation 遗留仍按专项文档推进。Production VIP 购买未打开。代码损坏回退价格是周卡 100 分、月卡 200 分；已发布价格以 runtime config 为准。",
    },
    "backend.infrastructure.runtime-data-security": {
        "职责与边界": "提供配置、Telegram/运营鉴权、域数据库 client、repository、日志和后台任务基座，以及非关键服务端 PostHog capture。不拥有具体业务状态机。",
        "当前状态": "Supabase 按域访问，服务日志使用 Pino。VIP 策略只通过 `platform/runtime-config.ts` 与 `platform/vip-strategy.ts` 读取已发布值；缺失或损坏时按 shared 安全默认回退，不把 test 环境实值写进代码。模型目录由 `platform/model-tiers.ts` 读取 `llm_model_catalog`。PostHog capture 缺 key 或非法 host 时 no-op。",
        "入口与调用者": "支付、模型、签到、媒体免费额度和提醒脚本在执行业务前读取这里的已发布配置。",
        "数据、契约与外部依赖": "读取 `app_core.runtime_config` 与 Upstash 缓存。日志只保留内部 ID、结果摘要、耗时和 `{ err }`，不记录 token、完整 initData、支付 URL 或响应正文。",
        "关键节点与约束": "禁止业务模块散读 `process.env` 代替平台配置。配置回滚不影响已创建订单、已受理生成和已消费免费次数。",
        "验证方式": "Backend runtime-config/vip-strategy tests，以及 shared VIP strategy tests。",
        "已知缺口与待核验项": "Production 配置发布仍要人工确认目标环境。日志规范入口是 `.trellis/spec/backend/app/data-reliability-and-security.md`，仓库中没有 `docs/log_system.md`。",
        "变更记录": """- 2026-09-18：任务 `图片生成 PostHog 接入规划`（`.trellis/tasks/archive/2026-09/09-17-image-generation-posthog-plan/`）记录 PostHog capture 泛化为服务端非关键终态事件；commit：`7ab4a18ac4924d9a23d35dfc6f4f75be0401c9fe`。
- 2026-09-23：任务 `Admin VIP media configuration`（`.trellis/tasks/archive/2026-09/09-23-admin-vip-media-config/`）Admin ?? VIP ??????????????????/????????????；commit：`5413afeaae67e9ef168831ec050d3b8514df33dd`。""",
    },
    "shared.business.conversation-contracts": {
        "职责与边界": "定义会话、SSE、生成配置、语音、图片 attempt、模型目录和图片生成 telemetry 的跨进程数据形状。不包含业务执行，不暴露数据库 row 或 secret。",
        "当前状态": "Backend 与 Frontend 已共同消费统一契约。模型目录携带服务端报价和 VIP 折扣字段；非会员的计费折扣与展示用权益分开。图片契约包含档位、免费额度状态和稳定错误码。telemetry 事件属性只允许 ID、枚举、耗时、状态、计数和价格/尺寸摘要。",
        "入口与调用者": "由 shared 根出口导出，供 backend 路由和 frontend hooks 在编译期与运行时校验。",
        "关键实现链路": "Zod schema → Backend 校验/响应 → Frontend client 解析。新增字段保持可选或有兼容默认，旧消费者不因缺新字段崩溃。",
        "关键节点与约束": "流事件 start/delta/done/error 语义保持兼容。免费额度展示不能代替后端预留结果。telemetry 拒绝正文、支付 URL、initData、token、图片 prompt 和图片 URL。",
        "验证方式": "`pnpm --filter @miniapp/shared test`，以及 backend 与 frontend typecheck。",
        "已知缺口与待核验项": "自建预设契约仍未定义。PostHog Preview 的人工检索不在本次 VIP 验收范围内。",
    },
    "shared.business.engagement-support-contracts": {
        "当前状态": "Frontend、Backend、Admin 与 CS Platform 按各自接口消费。通知契约包含 `vip_expiry`、提醒窗口和动作路径。标记已读的写入目标是消息 id 列表；只有 scope 不是合法写入。",
        "涉及文件": """| 路径                                       | 职责              |
| ------------------------------------------ | ----------------- |
| `packages/shared/src/api/wishes.ts`        | 许愿 DTO          |
| `packages/shared/src/api/community.ts`     | 社区 DTO          |
| `packages/shared/src/api/notifications.ts` | 通知与已读 DTO    |
| `packages/shared/src/api/vip.ts`           | 到期提醒窗口      |
| `packages/shared/src/api/support.ts`       | 客服 DTO          |
| `packages/shared/src/api/cs-platform.ts`   | CS DTO            |""",
        "关键节点与约束": "详情和列表使用同一通知形状。历史提醒正文不是实时会员状态，当前权益走 VIP status。",
    },
    "shared.business.wallet-payment-contracts": {
        "职责与边界": "定义余额、消费、签到、星尘套餐、VIP 商品、订单、结算来源和支付状态。",
        "当前状态": "Backend 与 Frontend 已统一使用。VIP 商品使用整数分、天数和专项赠送；周卡赠送必须为 0。状态契约用 `valid_until` 判定有效，`remaining_days` 只用于展示。损坏回退默认是周卡 100 分 / 7 天、月卡 200 分 / 31 天 / 3000 专项星尘、折扣 0.95。",
        "涉及文件": """| 路径                                   | 职责                  |
| -------------------------------------- | --------------------- |
| `packages/shared/src/api/wallet.ts`    | 钱包与签到 DTO        |
| `packages/shared/src/api/payment.ts`   | 支付与 VIP 套餐 DTO   |
| `packages/shared/src/api/vip.ts`       | VIP 状态与商品条款    |
| `packages/shared/src/api/vip-strategy.ts` | 策略配置 schema    |
| `packages/shared/src/api/telemetry.ts` | replay 事件与 context |""",
        "关键节点与约束": "金额精度、订单终态和 settled_by 联合值必须兼容。订单详情与列表使用同一映射。展示权益和实际计费快照不是同一个字段。telemetry 事件不得携带聊天正文、`pay_url` 或 initData。",
    },
    "database.business.billing-payment": {
        "职责与边界": "维护 billing 域订单、钱包、流水、免费聊天额度、VIP 会员、媒体免费额度、退款，以及 LLM/语音/图片计费原子函数。",
        "当前状态": "支付结算、钱包流水和生成计费对象已在迁移链定义。`billing.vip_memberships`、`vip_purchase_grants`、`feature_free_trials` 和 `wallet_refunds` 由 20260921 起的 additive migration 增加。图片仍只在 Storage 元数据齐全后通过 `billing.settle_image_generation` 原子扣款。六类 bonus 发奖仍统一收口到 `billing.grant_bonus_credits`。",
        "入口与调用者": "Backend payment、wallet、vip、generation、voice 和 image repositories/RPC 使用。",
        "涉及文件": """| 路径                                                                  | 职责                 |
| --------------------------------------------------------------------- | -------------------- |
| `packages/shared/migrations/103_payment_settled_by.sql`               | 结算来源             |
| `packages/shared/migrations/105_voice_billing_atomic.sql`             | 语音原子计费         |
| `packages/shared/migrations/20260911_billing_grant_bonus_credits.sql` | bonus 发奖唯一入口   |
| `packages/shared/migrations/20260914_chat_message_images.sql`         | 图片成功原子结算     |
| `packages/shared/migrations/20260921_vip_billing_schema.sql`          | 会员、免费额度和退款 |
| `packages/shared/migrations/20260921_wallet_debit_refund.sql`         | 原路退款             |
| `packages/shared/migrations/20260921_vip_payment_fulfillment.sql`     | VIP 支付履约         |
| `packages/shared/migrations/20260924_vip_plans_price_1_and_2_yuan.sql`| 已发布价格 forward-fix |""",
        "关键实现链路": "业务 RPC 判定/幂等 → 支付履约、签到、免费预留或退款函数 → wallet ledger → user_wallets。同一订单、同一扣款和同一退款键只生效一次。",
        "已知缺口与待核验项": "任务日志未记录 `20260924_vip_plans_price_1_and_2_yuan.sql` 已在 test 或 Production apply。Production VIP migration 仍等待 T9，不能用 TEST 结论代替。",
    },
    "database.business.conversation-storage": {
        "职责与边界": "维护 experience 域会话、语音和图片 attempt。资金和免费名额账本在 billing，不在本模块重复记账。",
        "当前状态": "会话、语音和图片 attempt 已落地。`20260922_media_feature_free_trials.sql` 为语音和图片 attempt 增加计费快照列，包括 `billing_mode`、`free_trial_ordinal`，图片还有 `image_tier`、`wallet_policy` 和 `vip_valid_until`。这些列记录受理当时的事实，不随后来的 VIP 配置回放。",
        "入口与调用者": "Backend voice、image 和 conversation repositories 写入；Frontend 只通过 HTTP 读取派生状态。",
        "关键实现链路": "受理时把本次序号、价格和档位写入 attempt。成功内容展示该快照；失败释放 billing 预留后，下一次按钮读取新的可用额度。",
        "数据、契约与外部依赖": "依赖 experience.chat_sessions、chat_history、chat_message_audio、chat_message_images，以及 billing 的免费额度和钱包 RPC。",
        "关键节点与约束": "attempt 快照不是钱包余额。应用层不能靠改这些列补发星尘或延长会员。",
        "验证方式": "migration ledger、backend voice/image tests，以及 TEST 媒体免费次数验收记录。",
        "已知缺口与待核验项": "图片生产开关和真实上游验收仍单独跟踪。Production 是否已执行媒体免费 migration 不能用 TEST applied 记录代替。",
        "变更记录": "- 2026-09-14：图片 attempt 存储由 `09-11-chat-image-generation-plan` 核验。后续模块正文曾被清空，本次按当前 migration 补回。",
    },
    "database.infrastructure.schema-security": {
        "当前状态": "八域、RLS/grant 和单文件 migration 纪律仍是唯一来源。VIP 对象放在 billing，通知扩展放在 miniapp_features，提醒函数使用 SECURITY DEFINER 且不向 anon/authenticated 开放执行。`packages/shared/migrations/` 之外没有第二套 migration 目录。",
        "入口与调用者": "GitHub Actions Database Migration 在确认 environment 后一次执行一个文件。应用通过 service role 或 SECURITY DEFINER RPC 访问，不从浏览器直连这些内部函数。",
        "关键实现链路": "前置对象检查 → 短 lock/statement timeout → additive 变更 → 文件内自检。失败在提交前回滚；已提交后用新的 forward-fix，不改历史文件。",
        "数据、契约与外部依赖": "跨 billing、app_core、experience 和 miniapp_features。权限模型以数据库 grant 为准，不靠应用层约定代替 RLS。",
        "关键节点与约束": "test 与 Production 分开执行、分开记录。禁止为了修 VIP 而改写已经 apply 的历史 migration。",
        "验证方式": "`pnpm lint:migrations`、`pnpm test:migration-ledger`，以及每次 apply 后的 shape/grant 回读。",
        "已知缺口与待核验项": "T8 不读取业务行，也不补执行未记录 apply 的价格 migration。Production 发布单属于 T9。",
        "变更记录": "- 2026-09-17：迁移纪律曾由 Batch Lab integration spec 核验。本次只补充 VIP migration 的当前边界。",
    },
}


def main() -> None:
    repair_module_files()
    baseline_check(ROOT)
    updates = []
    for module_id, relative in MODULES.items():
        target = ROOT / relative
        content = render(module_id)
        for evidence in EVIDENCE[module_id]:
            evidence_path = ROOT / evidence
            if not evidence_path.exists():
                raise SystemExit(f"missing evidence {evidence}")
        updates.append(
            {
                "operation": "update",
                "module_id": module_id,
                "target": relative,
                "expected_sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
                "content": content,
                "change_summary": SUMMARIES[module_id],
                "evidence": [
                    ".trellis/tasks/09-21-miniapp-vip-model-ui/task.json",
                    ".trellis/tasks/09-21-miniapp-vip-model-ui/task.md",
                    ".trellis/tasks/09-21-miniapp-vip-model-ui/prd.md",
                    *EVIDENCE[module_id],
                ],
            }
        )
    payload = {"schema_version": 1, "updates": updates}
    destination = ROOT / ".trellis/tasks/09-21-miniapp-vip-model-ui/module-updates.json"
    destination.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {destination} ({len(updates)} updates)")


if __name__ == "__main__":
    main()
