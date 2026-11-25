# 执行与验收

1. 详情只依赖分页仓储，移除 recover 阶段；原身份、角色、取消语义延续。
2. 将共享首屏限额改为 6，保持旧页默认和缓存合并。滚动 hook 共享翻页触发与锚点，保留点击。
3. 扩展现有 route 注入测试，恢复不可用时依然返回旧历史与 streaming 状态，覆盖多个用途、分页和错误。运行 worker 老记录游标/CAS、activity preview、生成准备、前端缓存/分页等现有回归。复用现有测试文件记录并发和等待边界，不启动本地UI浏览器。
4. 运行相关 Backend/Frontend/shared 测试、pnpm -r typecheck、前端 lint/build、日志规划/分类、复杂度和 diff 检查。必要人工场景列入验证记录，待真实环境核对。
5. 发布先确认 TEST/生产各自的任务启用、索引、积压收敛；首屏样本以稳定 release 分 Android/iOS 观察 48 小时。把旧 recover_ms 与新日志版本按 release 比较，缺值不当零。功能或恢复异常则撤销对应应用变更。
