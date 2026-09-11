# 建立系统事实基线与文档漂移清单

## 目标

用近期 commit、当前实现、部署/迁移配置和现行文档交叉核验系统事实，形成后续同步可直接消费的漂移矩阵。

## 需求

- 覆盖 P1/P2/P3/R1-A/R1-B/R2/R3、迁移 Action 修复、CI/legacy guard、ST 与 botlink 清理。
- 每条结论记录事实、证据路径/commit、冲突文档、优先级、建议处理子任务和不确定性。
- 区分现行事实、已退场能力、历史留档、待办和需生产确认项。
- 只产出研究文档，不在本阶段顺手修改 package spec、README 或产品代码。

## 验收标准

- [ ] `research/system-fact-baseline.md` 覆盖架构、契约、生成计费、增长发奖、前端编排、迁移、部署与测试现状。
- [ ] `research/document-drift-matrix.md` 按 P0/P1/P2 排序，且每项有证据和目标文件。
- [ ] 至少核对 README、ARCHITECTURE、重构实施方案、六类 spec 入口、modules index、workflow/agents。
- [ ] 未能由仓库证明的生产事实明确标记，不作推断。
- [ ] 研究结果经人工审核后才允许启动下一子任务。

## 约束

- 依赖：无；输出是另外两个子任务的前置输入。
- 不读取数据库业务行，不修改历史 migration，不恢复已清理历史文档。
