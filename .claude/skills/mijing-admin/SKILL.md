---
name: mijing-admin
description: 操作蜜镜 AI 生产运营平台（运营配置、角色卡上下架与排序、公告、邀请、回复富文本规则）。用户要求查看或修改运营后台/运营配置/角色上架/公告等时使用；用命令行完成，不打开浏览器。
---

# 用 mijing-admin CLI 操作生产运营平台

在仓库根目录运行（子目录加 `-w`）。AI 调用总是 `pnpm -s admin <命令> --json`，stdout 只有一段 JSON。

1. `pnpm -s admin whoami --json`
   - `setup_required`：请用户在终端执行 `pnpm admin setup`。
   - `auth_required`：请用户执行 `pnpm admin login`（Claude Code 里可输入 `! pnpm admin login`）。不要索要或代填密码。
2. 找对象：`config list`（按菜单分组）、`character list --query`、`announcement list`。不确定命令时 `pnpm -s admin help --json`。
3. 读现值：`config describe <key>`、`config get <key>`、`layout get`、`text-rules get`。
4. 改动：
   - 配置：把新值写到文件 → `config draft set <key> --file f --json`。不带 `--yes` 会返回 `confirmation_required` 与 `details.preview` 差异。
   - 角色上下架/排序：`layout list|delist|delete|move` 改布局草稿 → `layout publish`。
   - 公告：`announcement create|update|publish|unpublish|delete`。
5. **把差异用中文讲给用户，得到明确同意后**，同一命令加 `--yes` 执行；再执行发布命令（同样先确认）。
6. 发布后 `config get` / `layout get` 复核，把结果和版本号告诉用户。

错误处理：`validation_failed` 看 `details.issues` 的字段路径修正后重试；`draft_exists`、`conflict`、`permission_denied` 先告诉用户，不要自行 `--replace-draft` 或重复写；`unavailable` 对写操作不要盲目重试，先读状态确认是否已生效（富文本规则用 `text-rules recover <request_id>`）。
