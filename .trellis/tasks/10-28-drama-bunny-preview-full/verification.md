# 本地验证与发布缺口

## 实现状态

本地已实现普通播放全量 Bunny、移除实验链路；尚未提交、推送、修改线上配置或部署。不能声称 pr-525 已切流。
Bunny控制台已只读核实原生动态Origin变量可用，TEST动态映射表单准备但未保存；Experiment closed仍阻断全路径。原生动态回源的真实媒体正确性尚未验证，须发布阶段先预检。

## 已运行检查

- pnpm --filter @miniapp/shared test：17文件，185 passed。
- 相关Backend signed-url/runtime-config/drama-timing/telemetry：4文件，45 passed。包含新Bunny多对象/源token绑定/缓存TTL/环境门禁/失效配置与原鉴权路径。
- pnpm -r typecheck：所有消费者通过。此前删除路由后的旧.next/types引用由正式build重新生成后消失，没有清空他人缓存或修改类型规则。
- pnpm -r --if-present build：Frontend/Admin通过；正常路由清单无实验页面。已有img、caniuse和Admin大chunk警告保留。
- pnpm --filter @miniapp/frontend test：57文件通过、1文件失败；480 passed / 5 failed。失败均位于未修改media-cache.test.ts，对image-plaza client既有signal参数断言不匹配；两相关文件git diff为空。未擅自修复，不声称完整CI绿。
- pnpm --filter @miniapp/frontend lint、lint:imports、lint:legacy、lint:migrations：通过（既有img warning）。
- pnpm test:ui --grep @drama：42 passed，Android与窄屏；覆盖普通首页/剧场/切集/续看/快进/重试、旧实验入口404，虚构fixture不证明真实CDN可用。
- prettier检查本次相关文件、git diff --check：通过。
- task.py validate：inline上下文验证通过。
- module_knowledge.py check：共3次未通过。前两次修正本次模块载荷的规定标题/路径；第3次本任务validate_task_updates已通过，随后baseline_check读取未修改的现存frontend.business.drama-experience文档，因缺少“当前状态”等规范章节失败。已停止继续尝试或扩展为全库文档修复，等待用户选择。不能声称全库模块门禁通过。

## 上线/真机仍待

1. 用户最终内容审核与明确commit/push批准。
2. Bunny TEST动态Origin规则保存并仅开放/preview-test/\*，保留原生token校验；此访问范围变更须执行时确认。实测查询映射/源token/Range；失败停止，不增加媒体代理。
3. pr-525服务新变量与旧变量清理、前后端部署SHA/API目标核对。
4. 至少两不同真实TEST对象的起播与中间Range206/少量字节匹配、热缓存鉴权负例。
5. 真实Telegram手机普通入口起播/切集/快进/续看；当前模拟不代替此证据。

## 已知试验风险

旧iPhone单样本实验未接受Bunny性能收益；本次按用户新目标接入Preview，不宣称提速。正常Telegram登录鉴权与剧/集归属保留。Production与development配置/数据不写。

## 与本次无关的已存在工作

ops/drama-bunny-preview/evidence.json 的已有dirty内容、experiment-closed.png未改动且不纳入提交；主工作区main的其他dirty工作未触碰。
