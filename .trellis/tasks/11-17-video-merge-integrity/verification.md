# 合并验证记录（2026-11-17）

## 结论与范围

HEAD cad341d5 合入 be737c2398936b79e031f5d7cfe310f4e347f672。21个冲突路径已完成工作树内容处理，未执行git add、commit、push或任何远程数据库操作。Git索引仍显示unmerged，等待最终人工审查。

- 保留视频报价、幂等受理、预扣/退款、worker、播放、分享、首帧引用和原参数重生成；对接上游repository拆分、错误处理、共享运营配置和CLI。
- 保留上游自动打标恒开启、移除PostHog及首次分享记录读取方式。
- 修复合并导致的纯文本视频参考图按钮可点击回归，保留图片模式的提示交互。
- 按现有边界拆分长函数/文件并收紧已有路由复杂度基线，没有提高阈值或新增预算例外。公共导出保持兼容。
- 签到release-review在上游归档内存在完全相同副本，保留上游归档、删除旧活动路径；schema-move任务备注保留双方事实。

## 通过的验证

- pnpm -r typecheck：所有8个消费者包通过；最终Backend typecheck再次通过，最终Frontend/Admin构建包含类型检查。
- Shared：24个测试文件，252项通过。
- Backend影像、路由和观测：20个测试文件，172项通过，拆分后再次通过。
- Frontend：75个测试文件，843项通过，拆分后再次通过。
- Admin：11个测试文件，116项通过，拆分后再次通过。
- UI fixture：12项通过。
- 日志静态检测器：9项通过；Backend日志门禁、复杂度门禁、legacy guard、迁移文件命名通过。
- import边界：Windows下pnpm脚本的空 --rule '{}' 参数被当成字符串；使用等价命令 pnpm exec eslint --no-eslintrc -c .eslintrc.json 'packages/_/src/\*\*/_.{ts,tsx}' --no-inline-config 通过。
- Frontend lint通过，保留既有img与其他模块hook告警；Admin及Frontend production build通过。
- 当前任务与本分支相对合入端触及的3个历史活动任务日志规划检查通过；Trellis上下文校验通过，有长文档注入截断提示，执行时应按需读原文件。
- 最终@image及封面工作室回流9个场景通过（390×844与320×568）。此前全量@image|@creator为40通过4失败：1项是已修复的禁用回归，3项发生于拆分期间缺少Link导入，已补回并在最终9项中全部复跑通过。其他创作/引导场景已通过，不宣称首次整组全绿。
- git diff --check与工作树冲突标记扫描通过。

## 已知限制与发布条件

- Admin CLI：23项通过、1项失败，失败为Windows不提供Unix 0700/0600 chmod语义的本地文件权限断言。未跳过或改写断言；需要POSIX环境完成该专项检查。
- DB契约lint退出0，提示上游20261117_drive_mode.sql向moving的settings表加列。本次未改该迁移，合并PR需保留该已知警告与上游理由。
- 无真实付费Venice canary、账务/退款数据库验证、Telegram Android/iOS下载/系统键盘或线上P95样本；不以fixture代替。后续工程师持续验收直接复用packages/ui-tests的@image/@creator场景，不另建模拟后端。
- 历史20261027_media_plaza_video.sql保留不改；安装或重建其视频分享函数后，须执行20261117_db_reorg_p3b1_video_share_first_share.sql，再开放视频分享。若该forward-fix先前因无函数记为空操作，应核对实际定义并按现有workflow审阅force_rerun。详见packages/shared/migrations/README.md，本次未执行迁移。
- Supabase复核参考官方changelog与rpc文档（https://supabase.com/changelog.md、https://supabase.com/docs/reference/javascript/rpc）；本次沿用既有SDK与RPC契约，不升级依赖。
- 本地next standalone输出按仓库Windows规范移至output/build-snapshots后重建，避免递归跟随junction破坏依赖；output与测试报告不提交。

## 最终审查

拟暂存文件以review-manifest.json为准。仅标记本次冲突解决及其必要适配文件，不操作其余自动合并的暂存内容，不创建合并提交。最终差异相对双方可直接查看git diff --cc、git diff HEAD以及git diff MERGE_HEAD；新文件见清单。

工作树初始冲突副本保存在仓库外临时目录video-merge-backup-m4tzmv85。暂存前须复核清单和SHA-256；内容变化需要重新审查。仓库workflow明确要求最终人工审查后才能git add或git commit。
