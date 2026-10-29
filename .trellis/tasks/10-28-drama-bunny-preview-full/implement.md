# 执行计划（规划，待用户审核）

约三块工作：签名/配置、实验代码清理、CDN配置与验收；涉及Backend/Frontend/Shared与运维文档，不是删除几个白名单条件。

1. 审核本任务 PRD/design/task；仅批准后 task.py start。当前 inline模式，不派发子代理。
2. 只读复核 Bunny Zone/规则/token设置、pr-525实际变量与TEST目标。原生动态回源先做小范围功能预检，失败停止，不堆代理。
3. 修改 runtime-config 与签名模块，保持普通API与播放器路径；扩展既有 signed-url / route测试，覆盖 HMAC、两视频分离、缓存复用/过期、pr-525/TEST环境门禁、错误配置、鉴权/归属。该风险需要回归覆盖，不默认新增测试文件。
4. 删除实验独占链路及其测试/契约，清理 imports、组件实验props、telemetry分支；相关普通测试不能删。
5. 同步 README、ARCHITECTURE、相关 spec、.env.example 与运维文档，保留他人dirty证据。
6. 运行 pnpm --filter @miniapp/shared test；受影响 backend/frontend 既有相关 tests；pnpm -r typecheck；pnpm -r --if-present build；frontend适用lint/import guard/legacy检查；pnpm test:ui --grep @drama。准确记录已有失败，不静默修计划外问题。
7. 展示最终路径/digest/验证/提交名单，按 .trellis/workflow.md 3.4 请求内容审核，再单独确认 push；配置/发布只限本任务 pr-525及Bunny TEST命名空间，不触及Production。
8. 部署核对 SHA、实际 Frontend API、普通有效TEST账号任意剧/集签发；至少两不同对象，起播/中间Range的206、Content-Range、少量字节匹配；热缓存鉴权负例。探针有超时/响应大小上限，非206立即取消，不下载大视频。
9. 真实 Preview普通页面验证切集、续看、快进、地址重试；提示用户Telegram手机验收。未取得手机结果则明确剩余缺口，不声称完全验收。
10. 检查production/development门禁继续走原路径，旧实验入口关闭；保留运维回退说明。
