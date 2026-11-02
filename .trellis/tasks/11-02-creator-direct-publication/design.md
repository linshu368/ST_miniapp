# 最小方案（修订替代直接公开）

## 复用与归属

复用现有creator发布/可见性接口、provider transport、runtime-config严格读取、CAS发布RPC、Admin managed text config及固定手机验收。不建审核队列/任务平台，不增加数据库表。配置数据属于app_core.runtime_config；admin仅包装既有managed-key/validator，发布仍app_core角色根，experience会话快照不变。

## 协议与调用

shared定义严格二字段结果与只含正文的prompt schema；backend的response_format/json_schema与格式提示硬编码，运营只改正文。开发默认示例prompt；实际backend复用现有OpenRouter transport与润色模型，验证只mock不真实付费调用。输入用服务端当前已存draft_runtime（包含真实预设和导入文件）和标签，不悄悄截断正文。

后端按owner读取并核对expected_revision，外部审核期间不持DB锁。通过才把服务端review结果送mutate；SQL同事务再CAS，保存草稿不发布。模型拒绝返回422+原因而不写卡级新版本；原稿已保存，技术异常返回503，不冒充内容拒绝。私密沿原路径。

## 可靠性与最小约束

JSON Schema required approved/reason + additionalProperties=false，回包再strict parse，缺项/类型错/额外字段/截断/超时不放行。统一后端60s/前端75s预算，不新增自动重试。模型结果排除在客户端幂等身份之外，已有发布重放仍返回同一结果。客户端不能提交review字段，SQL保留旧backend无review→pending兼容。只含合法服务端approved结论才直接公开。

## 迁移与验证

未发布的直接公开migration替换为审核发布gate，不批量处理旧pending。另新增prompt managed text配置迁移，保留既有名单/ACL/CHECK/运营值。两文件先本地隔离验证，本轮不执行TEST/Production。复用现有SQL/单元/固定UI，覆盖通过、拒绝、格式异常、重试、旧版本与权限。

## 恢复

用户已叫停上线，之前提交/发布review失效。后续另行最终审阅再执行配置迁移→发布gate迁移→Backend/Admin→Frontend；旧记录不丢弃，不改钱包，不撤销运营上下架。

## 2026-11-02 用户追加确认

用户确认补齐运营平台试审入口并在测试通过后上线。复用原角色卡审核页、Admin鉴权及environment API client，当前未发布prompt可对粘贴的测试材料试跑，返回严格approved/reason。试审不写配置、角色、会话或钱包。后台调用与正式审核共用transport和硬编码协议，仅正文通过受鉴权的本次试审参数覆盖；正式发布仍读取运营已发布规则。补充契约/鉴权/无副作用验证，再按feature→dev→main隔离发布本批改动。生产迁移须先在TEST逐份验证，本批不无条件放行历史待审卡。
