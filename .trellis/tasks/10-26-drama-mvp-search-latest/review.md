# 最终人工审阅包

## 变更与状态

本地已实现：剧级元数据回退、标题／标签／完整简介搜索与分类交集、首次上架时间排序、筛选后浏览队列及一份 TEST 迁移。未提交／推送／部署；远端 TEST 迁移未执行，Production 不操作。

建议一个完整变更单元：`feat(drama): 支持剧级检索与首次上架排序`。继续使用现有分支 `dev_video_1021`，base 为 `dev`；当前本地 HEAD 与本地追踪的 origin/dev_video_1021 一致（ahead=0/behind=0，推送前仍需重新核对远端）。

## 最终摘要

- shared 新增兼容可选 first_published_at；repository 明确使用 ai_results_drama_fkey，assemble 不再借用单集信息代表整部剧。
- 前端复用 React Query、Input 和原布局；检索不受卡片标签／文字截断影响，最新缺失置后且同时间顺序固定，推荐保留响应顺序。
- SQL 添加 nullable created_at，无默认值；锁内 577 行整批编号、只填 NULL、非空冲突拒绝、5s 锁／60s 语句预算、覆盖／元数据／ACL／RLS 断言；失败事务回滚，不改播放状态。
- 文档同步上传端字段交接、先迁移后应用的顺序、只限 TEST、定向 forward-fix 与本地／远端证据差异。

## 验证结果

- 五包 typecheck、shared 177／frontend 395／backend 最终 868 项既有测试通过；backend 首轮计时失败后独立文件和完整复跑均通过，未改生成逻辑。
- Frontend lint 与改动文件根 ESLint 通过；仅五条既有图片优化 warning。Frontend／Admin build、migration 命名、diff 空白和模块声明通过。
- 临时合成 fixture、实际 Supabase client + repository 投影、隔离 PG17 成功／拒绝／回滚／锁超时验证通过；未创建永久测试文件。
- TEST 只读 catalog／HEAD 核验、浏览器交互与 390／320 像素布局检查通过。真实时间列读取／workflow 账本／Telegram 播放未验收。完整结果见 [verification.md](verification.md)。

## 拟提交的文件与 SHA-256

下列摘要固定对应当前最终内容；任何内容变化必须重新审核。本审阅文件本身亦包含在拟提交范围，但为避免自引用不列自身摘要。

- `packages/shared/src/api/drama.ts` — `a5b08298d1744106e86638bcdee48a62d7c67f7acc4910153cacdf166d6c9401`
- `packages/backend/src/features/drama/repository.ts` — `5cf51b2e4ceb77efc751d566faf7134bcc1edba18c26dcd3cd8c972a7cc45c99`
- `packages/backend/src/features/drama/assemble.ts` — `7bdffe8e772424811db5032a4133fbc2e976a570347c1733e21cf5e9eefab5e6`
- `packages/backend/src/routes/drama.ts` — `cc6e66e1854b2065edfe7aea8382c8fb24e27dae78aef1e23cc9355a6f4a4c5e`
- `packages/frontend/src/app/(main)/dramas/page.tsx` — `201cf19d83406514aa1a0a0406aa16b35b6abfe2877433aa580faf931b4f341a`
- `packages/frontend/src/lib/api/drama.ts` — `ad40134f0cdff5fb74f119c89ddd1a8cbecefd52ade6c68f5d934a46aeca92c3`
- `packages/frontend/src/lib/drama-catalog.ts` — `25508226885d1e9ae03a80c1e065946f45caeae2e6eb3580edcfc24605238a5c`
- `packages/shared/migrations/20261026_drama_video_created_at.sql` — `5f0660f7eba2332d21203eea17a80f04eb1ccfd77042cffeb68cb69c571059cb`
- `README.md` — `48b0f29e1d77b70c1b908b05577b46532f47c6a50587fc89e6afffaa9f3284cc`
- `docs/ARCHITECTURE.md` — `8c4c5a1119e3f72cbe58da15eb9fc01d3b91f7f2125d1312d13c2ede97d9f3c2`
- `.trellis/spec/database/supabase/index.md` — `f629dbb79172bfa4aa33d99343513a34682f8f4a831c107b2a07424d5f6e3bf3`
- `.trellis/spec/database/supabase/drama-catalog.md` — `8de6803f967442746c513bc70cdffb8e8f8ea1ad240fa0eb3c782e93a81ee295`
- `.trellis/spec/frontend/app/pages-components-and-ui.md` — `89e39776e1d5261b9a88902049233b9c3e2796c2f449afa1489c1d0c5d13f217`
- `.trellis/spec/shared/contracts/api-contracts.md` — `68d195802e77767693a72fe994d41d877d15d680b5e62949dfac2892aac9cf9d`
- `.trellis/tasks/10-26-drama-mvp-search-latest/task.json` — `2b1bd7374ad198a10e556417000930ad2afe8249654147e30747ec775e68189a`
- `.trellis/tasks/10-26-drama-mvp-search-latest/prd.md` — `0a09dce21261f9789d0c24ab8b9900e49342020b57c1f1c6d3129a5e375e2849`
- `.trellis/tasks/10-26-drama-mvp-search-latest/task.md` — `2d3c9d6f2168f470f8d751c390b22614b3decb2c6d5ab165d39acfc7f4d64efa`
- `.trellis/tasks/10-26-drama-mvp-search-latest/verification.md` — `6a05757b593cd803c3ad5717c06a49f27ecfe0a2f39e46ac7e58c80c11b4dd64`
- `.trellis/tasks/10-26-drama-mvp-search-latest/review.md` — 本审阅包最终正文

## 排除的既有未跟踪内容

不提交 `.claude/`、`.mcp.json`、`.trellis/.template-hashes.json`、`.trellis/tasks/10-20-payment-create-failure-p0/`，也不提交本任务未使用／未编辑的 implement.jsonl、check.jsonl 示例文件。临时脚本、截图、env、业务导出均不入 Git。

## 批准后的动作

提交需明确批准上述最终内容；推送需要单独明确授权，提交批准不等于推送批准。SQL 推送到远端后，按已授权计划运行 `db-migrate.yml`，仅 `test`、只此单文件、`force_rerun=false`。执行前核对 branch SHA／文件 checksum／TEST ref；规模变化等保护拒绝后停止，不扩大批次、不盲重跑。

远端成功与真实消费者验证完成之前任务保持 in_progress，不归档；本次应用不自动部署 Production。执行后的账本／验收记录若有修改，需要作为新的最终内容重新审核后才能提交。
