# 最终切流结果（2026-10-29）

pr-525已启用普通播放Bunny；代码f88053a5，启用部署4df23b5f-a228-42f7-930d-e052d1c8951f SUCCESS。用户已明确授权提交推送和Bunny的TEST访问范围变更；不存在用户/固定样本实验名单，正常登录和归属仍保留。其他环境未切流。

## 已完成的真实证据

正常API向两名无名单fixture身份返回不同真实TEST对象的Bunny地址，重复请求保留完整URL/到期。未登录401、错误归属video404，旧实验API/页面404。两对象起始与72%位置Range206、片段SHA-256与源相同；热缓存签名负例及旧实验CDN路径403。939KB实际CDN小样本在0秒和1秒各解出一帧，随即删除。
Vercel h2v2obto8实际bundle确认API为pr-525、release为f88053a5。DRAMA_CDN_ENABLED=true、专用key存在、五个旧实验变量已删除，鉴权旁路均0。详细安全标量见acceptance.json。

## 修正经过与边界

第一次Origin使用Path.1-保留了原query，源返回400 InvalidJWT；普通播放当时未切流。改成明确目录段+Url.Filename后媒体与负例通过。2MB探针对939KB对象得到源/CDN一致416，改按实际文件72%定位后通过；不作为媒体故障/性能补测。Mac锁屏期间停止UI，用户解锁后继续，未扩大到代理/Worker/全库密钥方案。
本地结果维持：shared185、相关Backend45、UI42、全包typecheck/build与适用lint通过；完整Frontend480通过/5条既有media-cache失败。模块载荷通过后被既有文档全库格式阻断；按用户继续指令保留问题，不改全库或伪称门禁通过。PR Review外部402，既有dev冲突未处理/未merge。
真实Telegram手机手感仍待工程师确认，当前证据不等于性能收益或Production结果。旧ops/evidence.json和experiment-closed.png未改动/提交。

## 以下为先前阶段记录（历史状态，以上方最终结果为准）

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

## 推送与云预检进展

用户随后明确授权直接推送，并确认扩大Bunny的TEST路径访问范围。代码已提交/推送 f88053a58406eef601e1e5e2b865df9090e88dff。Railway部署84eced54-9f70-4588-a864-21e2b4b03e7a SUCCESS；Vercel同SHA部署success。PR Review本次HTTP402，未声称通过；远端PR存在与dev的既有冲突，不在本次Preview目标中，不merge/rebase。

Bunny新增Preview TEST drama origin，并将Block outside Preview TEST设置为NONE匹配/preview-test/\*，其他路径仍阻断。已保存回读。普通播放DRAMA_CDN_ENABLED仍未启用，实际继续Supabase，未因预检失败切断现有播放。

用测试Bot正常HMAC验签构造的fixture账号99999调用仅列表/play读接口，取得两个真实TEST可播对象；不读取/创建用户记录，不调用用户写接口。第一对象源Range0-1023返回206/1024字节，Bunny返回400 InvalidJWT / Invalid Compact JWS，已立即停止全量Range序列。后续仅一次受限错误码确认，无大文件下载。

官方动态变量文档说明：Path.1-在不改变文件名时保留原查询串。因此当前Origin模板中的Path.1-后再拼?token可能把CDN query带入源token，需改为不含查询串的明确目录段+Url.Filename，并重新实测；这是当前待验证推断，不把它当已确认根因。参考 https://bunny.net/docs/cdn/edge-rules/dynamic-variables 。

继续操作前Mac锁屏，CUA明确报告无法解锁；已请求用户手动解锁并等待回复。尚未继续修改Origin模板，也未启用Railway切流。
