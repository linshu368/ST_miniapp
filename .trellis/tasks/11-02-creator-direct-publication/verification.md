# 角色卡AI审核本地验收

## 当前范围

用户2026-11-02叫停上线并新增AI审核；本轮未提交、推送、远端迁移或部署。原14张待审与6张私密卡保持生产原状。旧直接公开review已失效。

## 验证通过

- shared既有creator contract文件20/20，固定approved:boolean与reason:string，两个必填且拒绝额外字段，客户端不能携带review。
- backend审核transport/原润色/发布route三份相关测试33/33，含配置错误、截断/格式/HTTP/超时、私密跳过、拒绝不写、幂等和审核期间改稿CAS。backend typecheck/lint通过；无独立build脚本。
- Admin既有schema/nav两文件30/30、typecheck与正式build通过；正文独立平台规则入口，不暴露可编辑schema。
- frontend编辑单测9/9、fixture7/7与typecheck/lint通过；正式build通过；全部workspace typecheck与迁移命名检查通过。
- 固定手机@creator全量15项中12项首轮通过；另3项因Next全局route-announcer与业务alert同名导致定位失败。改为限定业务提示后，审核4项定向复验全部通过（32s）。覆盖静默返回、内容拒绝修改重试、旧公开版保持、技术异常不放行和可见性弹层恢复。原390/320布局通过，不重搭环境。
- 隔离PG17 creator完整harness通过：legacy pending/禁用/归档/旧聊天完全不改、审核结果门禁、缺/错/额外字段不发布、服务端reason变化不改变幂等、版本/分支/权限保留，migration重放幂等。Docker network none，临时容器已清理。
- 复用reply-style隔离脚本验证prompt配置迁移通过：text-only、Unicode trim/UTF16 12000边界、默认值与shared一致、旧key/特殊历史CHECK/ACL及grant-option不变、运营改文后重跑不覆盖。使用缓存postgres:17、network none、postgres用户、仓库只读挂载与临时socket；容器已清理。
- 最终独立cross-layer审查通过，无必须修项。

## 预览与边界

手动预览3160/3161（3151被已有进程占用，未终止）；自动验收3130/3131独立。右侧已请求打开场景入口（host返回queued），可选择创作与我的空间、角色公开审核未通过、角色审核暂不可用。

当前只审核文字：名称/描述/开场/标签和已保存的预设/背景/导入全文；不审核封面像素。真实backend复用OpenRouter与现有google/gemini-4-argon，开发验证使用固定模拟结果，没有真实模型调用或扣费；审核准则与真实模型效果待用户后续调试。

## 用户重新授权上线后的补验

- Admin同页测试审核已完成，使用当前未发布prompt和单一测试资料框，提供示例；合法通过/拒绝均有结果，技术异常不伪造结论。
- Backend/shared新增试审契约、当前环境Admin写权限、无发布/配置/角色/钱包副作用。Backend相关4文件48/48，shared契约22/22；Admin3文件39/39，Admin typecheck/build通过。
- 真实供应商验收（使用当前生产runtime已有密钥，只调用模型）：google/gemini-4-argon + require_parameters + strict json_schema实测HTTP200；正式试审函数默认policy对虚构邮差角色通过（4.336s），对明显站外转账诈骗拒绝（7.535s），两次approved/reason严格解析通过。没有写真实卡/规则/用户星尘。
- 全部workspace typecheck通过。生产只读结构核验：mutate_creator_character原块与迁移预期逐字匹配；现有owner/ACL及validated CHECK已记录，审核迁移尚未执行。
- 本地HEAD快进至c66ba9ae，当前origin/main=51d5b2af，两者产品树相同，保留同事已上线首字优化；本次仅提交明确列出的审核功能改动。

- 最终Frontend生产build、全仓imports/legacy/migrations静态门禁及diff检查通过。legacy扫描曾把审核测试mock URL当成新模型出口；已将mock改为通用fixture地址并复跑同文件，生产调用仍只走既有upstream。独立最终跨层审查通过，无阻塞。
