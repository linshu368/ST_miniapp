# 任务分解

- [x] 用户审核 prd / design，定 D1（流式 + 首字 6 秒 + 总超时保留）与 D2（推荐方案）
- [ ] shared：配置契约 + 旧形状兼容 + 测试
- [ ] backend：Surplus 流式调用 + 首字计时
- [ ] backend：尝试序列（并入 → 主线精简 → 删最早条目，去预精简）
- [ ] 日志字段与白名单（含 window.planned 字段）；admin 编辑器；回放脚本
- [ ] 验证命令全过 → PR → dev → development 环境实测
- [ ] release → main → 部署核对
- [ ] 生产配置改新形状（差异给用户看、同意后发布）
- [ ] 数据迁移重新排队卡住的任务：TEST → 生产
- [ ] 24 小时验收数据
