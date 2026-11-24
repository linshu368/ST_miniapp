# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task                                                       | Files / Scope                                                         | Depends On | Verification             |
| --- | ------ | ---------------------------------------------------------- | --------------------------------------------------------------------- | ---------- | ------------------------ |
| T1  | Done   | 背景数据与计算（生效规则、遮罩、字底、自动采光、图片存取） | `lib/appearance/*`                                                    | 规划审核   | 单测                     |
| T2  | Done   | 背景图层接入聊天页                                         | `components/chat/chat-surface.tsx`、`app/chat/[characterId]/page.tsx` | T1         | ui-tests、真机键盘       |
| T3  | Done   | 工具箱第三个标签「界面设置」                               | `chat-tools-panel.tsx`、`chat-look-settings.tsx`                      | T1 T2      | ui-tests、390/320 截图   |
| T4  | Done   | 字号切片                                                   | `reply-size-store.ts`、聊天气泡与输入框                               | T3         | 真机、热区断言           |
| T5  | Todo   | PR1 发布与核对                                             | -                                                                     | T2 T3      | 48 小时 P95、日志        |
| T6  | Todo   | 夜间截图基线、白天色板、首帧脚本、store、图标              | `globals.css`、`layout.tsx`、`profile-header.tsx`                     | 规划审核   | 夜间差异 0               |
| T7  | Todo   | 写死颜色分批替换、保持深色区域                             | 约 50 个文件                                                          | T6         | 每批夜间差异 0、白天截图 |
| T8  | Todo   | Telegram 配色、回复主题                                    | `lib/telegram/*`、`chat-message-bubble.tsx`                           | T6         | 真机                     |
| T9  | Todo   | PR2 发布与核对                                             | -                                                                     | T7 T8      | 48 小时 P95              |

## Execution Log

- 2026-11-24：规划文档完成，用户 11-24 确认方案与字号滑杆，开工。
- 2026-11-24：T1–T4 完成（未提交）。背景/采光/范围/字号在 Chromium、WebKit、390 与 320px 逐项走通；存储不可用、内容损坏、图片丢失、键盘变矮、生成中换图、满 12 张均正常；没设过的聊天页与改动前截图逐像素一致。单测 991 条全过（含新增 12 条）、@chat 验收 47 条全过、全仓 typecheck 与前端 build 通过。字号热区改用 globals.css 规则实现，没有动 reply-renderer。真机（HEIC、超大图、Telegram 键盘、跨域封面取样）待核对。
