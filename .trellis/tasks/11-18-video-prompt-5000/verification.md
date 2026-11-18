# 视频5000字本地验证

2026-11-18，本地Windows/pnpm。诊断阶段只读确认生产项目 `wbtsfzozlmurljvglhpn` 的消息content CHECK为1–2000、service可写读、无自定义trigger。用户确认提示词超过2000并要求支持5000。本轮修复未执行远端迁移或付费生成。

## 验证

- Shared全部25文件/257项通过，视频2001和5000字完整接受、5001/空白拒绝；25,279字历史snapshot继续可读。现有图片2000字边界回归通过。
- Backend广场route、video upstream、playback既有测试3文件/24项通过，新增5001字提交在runtime/provider/repository前返回400。
- Frontend全部79文件/874项通过，全仓8个消费者typecheck通过。
- `pnpm test:ui --grep '@image'`：11项通过，320/390px工作室输入maxlength=5000且请求正文完整包含5000汉字；原有混排/筛选/图片生成/失败/同款等流程继续通过。此为现有本地验收系统场景，非真实供应商生成。
- `node scripts/test-video-prompt-5000.mjs <PGlite入口>`：真实本地PostgreSQL/WASM合成表，2000→2001旧失败，迁移后2001/5000通过、0/5001拒绝；原文长度不变；重放与postflight通过；未知6000约束明确拒绝并事务回滚；RLS/ACL/PK保持不变。未新增远端表/行，未修改依赖或lockfile。
- frontend生产build与其lint/type检查通过；已存在img、drama hook、Browserslist/Tailwind非阻断警告。沿用本地无Sentry上传入口，不修改发布配置。
- 复杂度、backend日志、迁移命名、db-contract、移动性能声明、日志规划和module payload门禁通过。db-contract仍有既有base迁移的6项警告，本次无新增；studio抽出输入框，主文件/函数净减少，基线不放宽。运行complexity update产生的无关settle/排序变更已复原。

首次UI尝试被3131占用阻断；确认是本会话21:32遗留的fixture父子进程后，仅停止该已核验进程并重跑成功。测试命令局部NO_PROXY用于localhost，不改断言/超时/端口。通过后3130/3131均无监听。

## 上线前与恢复

新增迁移 `packages/shared/migrations/20261118_media_plaza_message_prompt_5000.sql`，同名tests/postflight只读目录。先TEST工作流与shape/锁/规模/权限验收，production独立确认后执行同文件，再发布消费者。默认force_rerun=false，目标是production项目 `wbtsfzozlmurljvglhpn`，不得用TEST实况冒充生产。

迁移只扩content CHECK，不重跑视频base、种子或钱包，不重投4次失败请求。不收紧video_attempts/historical snapshot、不更改图片API2000、计费/幂等/模型参数/资源。更大输入仍可能被具体供应商限制独立拒绝。

回滚应用时保留5000存储CHECK；已保存长内容后不能直接收紧2000，更不能删除/截断正文。未知shape或锁/语句超时立即停止，提交未知先核对catalog与账本。ACCESS EXCLUSIVE锁及全表VALIDATE需各环境单独核验；单连接本地测试不能证明生产多连接锁或P95。

Android/iOS工作室加载与提交成功P95基线暂无独立样本，保持null。目标分别1500ms/800ms，按发布前后24h、平台/release/route比较，N<100延长72h。真机键盘/IME、真实5000字模型调用和发布窗口尚未验收，不宣称线上已生效。

本轮未暂存、提交、推送或发布。最终文件、内容摘要、建议提交与执行顺序见review.md。
