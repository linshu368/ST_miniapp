# Cross-Layer Thinking Guide

Before coding a cross-layer feature, map the full flow:

```text
UI / caller -> shared contract -> backend route -> feature/service -> repository -> Supabase -> response -> UI
```

Check each boundary:

- What is the exact input and output type?
- Is the type defined in `packages/shared/src/api/*`?
- Where is validation performed?
- Which layer owns defaults and normalization?
- What happens for empty, null, invalid, unauthorized, and upstream-failure cases?
- Which tests prove the round trip?

ST_miniapp-specific reminders:

- Application packages must not import each other.
- Frontend/admin/CS must not use DB row types.
- LLM billing must not bypass `features/generation`.
- Runtime config must not bypass `platform/runtime-config.ts`.
- Route readiness is visible through `@frontend-ready`.
- Session Replay / 支付观测：浏览器 `NEXT_PUBLIC_POSTHOG_*` 必须静态读取；录制 lifecycle 放根 Providers；外部支付回流不能只认 URL；服务端 PostHog 失败不得影响结算。
