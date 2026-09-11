# Thinking Guides

Use these guides before implementation when the task crosses layers, repeats existing patterns, or changes data contracts.

## Available Guides

| Guide                                                   | When to use                                                                |
| ------------------------------------------------------- | -------------------------------------------------------------------------- |
| [Cross-Layer Thinking](./cross-layer-thinking-guide.md) | Feature touches API, backend, frontend, database, or shared contracts      |
| [Code Reuse Thinking](./code-reuse-thinking-guide.md)   | You see repeated logic, new helpers, config changes, or duplicated parsing |

## Required Triggers

- Shared API contract changes.
- Fastify route plus frontend hook changes.
- Supabase migration or Prisma schema changes.
- Payment, billing, LLM generation, auth, or Telegram initData changes.
- Any schema/table/field/function deletion.
