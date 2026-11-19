# 任务分解

- [x] P1 调研剧场/短剧、广场视频与日志。
- [x] P2 范围收敛：无需兼容；TEST全部13条；生产不操作。
- [x] P3 TEST只读核对：13条、74,247,409字节、13/13源可读；10条种子匹配既有manifest。
- [x] P4 形成design、implement、数据落位和日志/移动性能声明。
- [x] P5 用户明确“开始执行”，任务已进入in_progress。
- [x] D1 shared、registry、schema/jobs/RPC与隔离SQL验收。
- [x] D2 Stream配置/上传/编码/发布/补偿、最小媒体原语复用。
- [x] D3 工作室/详情HLS、artifact权限、下载和播放观测。
- [x] D4 Pino真实输出、白名单、中文标签、失败告警验证。
- [x] M1 TEST连接/账户核验、13条上传/多档/私有访问校验。
- [ ] M2 workflow逐文件切换、应用验收及原MP4清理，封面保留。
- [ ] V1 typecheck/测试/lint/build/固定UI、真机/真实供应商和P95分别记录。

M2仍待最终人工内容审查、提交/推送、TEST workflow和应用发布后执行。V1已完成类型/单测/静态/构建；用户明确不需要本地UI，真机和真实新生成仍分别标注未验。
