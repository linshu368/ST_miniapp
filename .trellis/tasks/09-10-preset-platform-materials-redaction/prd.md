# Preset Platform 测试素材与脱敏

## Goal

实现当前环境角色卡只读导入、真实用户输入有界查询与关键用户信息脱敏。

## Requirements

- 实现测试素材功能的 backend 支撑：当前环境角色卡只读导入、真实用户输入有界查询和关键用户信息脱敏。
- 角色卡按当前目标环境读取：test 读 test，production 读 production；只返回必要摘要和生成所需上下文，不回写角色卡。
- 真实用户输入必须按已选角色卡、时间窗和分页读取，仅取必要列。
- 返回浏览器前必须脱敏关键用户信息：用户 ID、Telegram 标识、联系方式、URL query、身份与支付样式标识等。
- 浏览器只获得脱敏正文、粗粒度时间和 opaque sample id；不得获得 user/session/message ID 或未脱敏原文。
- 首期不做内容审计或语义风险审核；不把素材用于训练、导出或长期缓存。

## Acceptance Criteria

- [ ] 角色卡选择、下架/删除、无样本、分页、权限不足、超时均有稳定响应。
- [ ] PII fixture 覆盖手机号、邮箱、TG、URL query、身份/支付样式、Unicode 和超长输入。
- [ ] response/log/Sentry 不包含未脱敏正文、用户身份、联系方式或原始 sample id。
- [ ] 数据库和代码路径证明对 `app_core`/`experience` 仅只读，且不写 MiniApp 业务域。
- [ ] `pnpm --filter @miniapp/backend test` 相关用例通过。
- [ ] 根据实现补充 backend/database 安全 spec、日志脱敏规则和父任务风险记录。

## Notes

- 依赖 backend foundation、数据库域和 shared 契约。
- 内容审计不在本期范围，但关键用户信息脱敏是硬门禁。
