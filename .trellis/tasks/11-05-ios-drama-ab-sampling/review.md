# 最终审核包（审核时未提交/未发布）

## 交付

scripts/ios-drama-sampler/ 为独立原生触摸工具，真实production片单与账号配置仅在本机私有目录；Downloads独立交付目录与zip不含凭证、账号ID、片单、截图或编译产物。使用run.command复用现有安装包Node/Appium。

## 变更与验证

Backend仅新增runtime-config两账号定向读取及stream分组覆盖，沿用既有API与experiment_user；无新表/迁移/前端变更。扩展已有测试，119文件1328项全过，typecheck通过，7项分桶与13项遥测专项通过。工具语法/Shell/Swift/无网络计划及review中的关键离线断言通过；ESLint no-undef及git diff --check通过。模块知识全仓检查存在无关spec通配路径问题，见verification.md。

拟提交范围及SHA256见review-digests.json；本任务全部Trellis文件可作为独立规划/验收提交。未git add/commit/push，不包含任何本机私有配置或编译产物。未发现原有无关dirty文件；先前其他窗口的变更已由对方提交，不混入本次diff。

## production现状与后续操作

目标gallant-insight / production / stminiapp。当前Backend部署SUCCESS，SHA9dd89ffb；实验ID固定，Stream true、Bunny false、入组10000。两个指定账号自然均Supabase，A已符合指定，B尚需定向。

独立发布前从当前main隔离以下后端文件，保留上游：runtime-config.ts、features/drama/stream.ts、stream.test.ts；配置操作说明一起发布。运行适用检查/Quality Gate并审核后合并发布；确认部署新版本后设置唯一变量DRAMA_STREAM_SAMPLING_COHORT，值为本机600权限cohort-proposal.json中的proposedValue，仅含当前experimentId及用户指定两ID。其他变量/密钥/实验ID不改。配置后读回、两账号实际播放核对assigned group/provider/fallback，B未核验前不标记脚本分组已确认。

异常移除新增定向变量即可恢复两号自然分桶；不改全体key，按观察窗口分隔移除前后样本。代码部署、变量写入、设备预演尚未执行。本轮用户要求先完成设备之外工作，因此停止设备操作。

## 本轮授权与提交分组

用户同意先推送远程，由用户自己开PR合并线上；本轮只执行以下两次有界提交与分支推送，不创建/合并PR，不部署、不写production配置、不操作手机。

1. feat(drama): add iPhone sampling and targeted A/B accounts
   文件：review-digests.json列出的18个实现/规范/说明文件；已审核实现仅进行不改变AST的Prettier格式化。
2. docs(trellis): record iPhone sampling plan and validation
   文件：.trellis/tasks/11-05-ios-drama-ab-sampling/ 下规划、研究和验收文件。

原工作区全部内容保留。远程分支为codex/ios-drama-sampling，PR目标main。合并后必须先验证Backend部署成功，再应用本机定向提案；手机/WDA就绪后另做真实验证。
