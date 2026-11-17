# 实施与验证

1. 复用/风险审查：两名子代理分别审查前端合同和计费裁剪链路，根代理合并规划；用户已明确要求替换并有此前测试后直接发布授权。
2. 前端/shared：v4、提交确认、一次终态，删除旧观察器；扩展既有单测。
3. 数据/看板：兼容v4约束、首份结果、提交超时释放；默认v4与历史隔离，保留最小索引查询。
4. 计费/恢复：settled过滤、归档dedup显式结果、failed退避；扩展既有单测和本地SQL。
5. 并行实现后根代理跨层审查，重点退款/免扣、用户停止、离页、迟到、缺报与并发。
6. pnpm shared/frontend/backend tests，pnpm -r typecheck，frontend/admin build，lint:migrations，相关lint，git diff --check；已有ui-tests mock验证主动滚动、延迟提交、后台恢复、温馨提示。
7. 提交/PR→dev CI及TEST验收→生产单文件迁移/应用与Grafana发布；核对具体SHA与新口径、调用频率。遇CI服务外部402等沿用此前用户批准的Quality Gate通过后管理员合并，不改分支保护。

修复与上线不得扫描大表，不导出正文/余额/密钥。运行时故障退避、重复交付/计费幂等、未知冲突拒绝由既有专项测试证明。
