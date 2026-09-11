# 同步包级 Spec 与模块知识

## 目标

依据已审核事实基线，修正会直接指导实现、迁移和模块理解的 package spec 与 module knowledge。

## 需求

- 优先修复迁移日期命名/账本/psql 执行、已删除 st-bridge、旧模型档位、生成计费唯一入口、统一发奖入口等 P0/P1 规则。
- 同步 backend、frontend、admin、cs-platform、shared、database 的索引与具体规范；未受影响文件不做格式化式重写。
- 更新声明的 module IDs，并通过受控 `module-updates.json` 记录事实变更；索引只通过工具重建。
- 在各包承接统一注释边界和测试创建原则时，不复制完整 workflow，也不弱化包级专项要求。

## 验收标准

- [ ] 已审核漂移矩阵中分配给本子任务的 P0/P1 全部关闭，P2 有处理或延期理由。
- [ ] 不再把 st-bridge、旧模型 tiers、旧迁移编号写成现行能力。
- [ ] 生成/计费、钱包发奖、迁移账本、P3 编排等受影响模块事实与代码一致。
- [ ] `module_knowledge.py check` 与索引重建校验通过，声明模块和 payload 完全一致。
- [ ] 所有 spec 链接存在，`get_context.py --mode packages` 正常。

## 约束

- 依赖：事实基线子任务已完成并由人工审核。
- 不借机改产品代码、迁移或公共契约；发现代码缺陷另立任务。
