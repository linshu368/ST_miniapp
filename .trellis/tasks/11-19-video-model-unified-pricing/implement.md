# 执行计划

## 启动

用户审核最新方案后才task.py start；当前仅规划。inline执行，无子代理。工作树已有大量无关staged改动，保持其状态，不stage/commit/push。

## 顺序

1. shared兼容增加可选参数，核对公开用户模型不携带参考字段。
2. 视频helper复用精确计算，增加组合key、安全更新、价格上限及原子批量。
3. 视频组件接入参数/公式、逐档与批量重算，保留disabled及现有选项能力。
4. 核验admin-client解析/transform和CLI现有config命令保留字段，无新API或命令。
5. 扩展现有admin/lib/imagePlazaPricing.test.ts、configSchemas.test.ts及shared既有视频契约测试（按职责选择），不默认新建测试文件。参考字段持久化、计费上限与旧目录兼容必须回归。
6. 更新Admin README与admin.business.operations现状。额外部署/数据库行为若超出本设计，重新规划并同步相应架构/spec。

## 验证命令

```powershell
python .trellis/scripts/logging_planning_gate.py --task .trellis/tasks/11-19-video-model-unified-pricing
pnpm --filter @miniapp/admin test
pnpm --filter @miniapp/shared test
pnpm --filter @miniapp/admin-cli test
pnpm -r typecheck
pnpm --filter @miniapp/admin build
pnpm build
pnpm lint:imports
pnpm lint:complexity
pnpm lint:db-contract
git diff --check
```

执行前核对根build适用范围；既有错误记录命令、来源与本改动关系，不改无关代码。格式检查仅本次路径；如触及复杂度基线，拆小并只收紧本次项。

## 失败路径与消费者

- null/0/负值/NaN/Infinity/超过四位小数、输入上限、乘积不安全、最终价超过1,000,000。
- 精确整十、0.0001与视频上限边界；跨模型/时长/分辨率/音频隔离。
- 缺一档、下架模型缺值、新增选项缺值：批量完全不改；单档不改其他档。
- 输入修改不改手工价；重算保留目录其他属性；非法参数不导致默认回退。
- JSON/managed config往返及CLI consumer兼容；frontend/backend仍按既有price_matrix报价。
- 请求失败/超时/权限拒绝/重复点击沿现有流程保留输入，不输出敏感浏览器日志。

## 人工与恢复

本地虚构数据检查窄屏/disabled/输入重算；具备受控TEST会话时验证保存重开、历史、环境隔离、发布区分。未执行记录缺口，不把单元测试当远端验收。本轮不操作生产配置。已有页面扩展优先复用Admin人工流程，不创建临时MiniApp mock脚本。

仅撤回本任务拥有的本地修改，不reset已有dirty状态。线上异常停止新编辑器或回退部署，沿用历史恢复；不做账务补扣。交付报告改动、验证及限制，不自动提交。
