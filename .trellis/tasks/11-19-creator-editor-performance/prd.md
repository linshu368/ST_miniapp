# 角色创作兼容性与编辑器首屏优化

## 目标与用户价值

角色创作兼容性与编辑器首屏优化，使用户获得更稳定、更快的真实可用页面/任务结果；不是仅降低告警或调整统计。属于[总任务](../11-19-mobile-performance-round2/prd.md)。

## 背景和证据

冻结窗口2026-11-17 15:10:52—2026-11-19 15:10:52；[安全证据](../11-19-mobile-performance-round2/research/evidence.md)。代表new Android1898.48/N43、iOS7961/N6；edit Android3861.2/N31、iOS270/N1；data Android3521.52/N37，均不能宣称稳态。creator API被白名单归other，无可信独立历史P95，因此api baseline null。

## 需求

- R1 修复创建页、恢复备份、附件和心愿直接调用crypto.randomUUID；从已有v4兼容实现抽取最小客户端纯helper，不引入依赖、不用于密码/鉴权token。
- R2 编辑已有角色时复用GetCreatorCharacterData.character.owner_user_id，移除仅取owner而额外等待整个创作列表；新建角色继续以已认证list身份隔离草稿，不从Telegram id伪造内部UUID。
- R3 以localReady和真实编辑器提交点观察可用，不把父组件拿到数据提前算完整草稿可用；existing ready定义若实质调整需单独版本比较，不能拿口径变化当提速。
- R4 修复creator/creator_public等有限API分组被Faro白名单降为other，按现有API classifier投影做一对一白名单补全；历史不可回填。
- R5 创作数据页只在可重复query-plan证据支持时做等价SQL/数据读取简化，不改默认all统计、计费统计规则或上新派生表；本批优先前端兼容与真实首屏。

## 验收标准

- [x] AC1 crypto.randomUUID缺失、仅getRandomValues可用和完全无crypto时，草稿/附件/幂等ID仍为合法v4，重复保存/失败重试不换既定id。
- [x] AC2 edit首屏不再以无关list为硬依赖；detail失败不显示别人的缓存，owner/draft切换不会串稿；本地草稿恢复和网络失败可操作行为保持。
- [ ] AC3 页面目标≤2000ms；new iOS仅N6，不能据当前7961ms证明稳态；API历史无分组样本保留null，上线新分类后再取基线。
- [x] 适用的既有测试/typecheck/lint/build通过，必要风险回归按implement执行；失败、低样本和无法运行项真实记录。

## 不在范围

无自动生产发布/数据库操作/运营配置写入；不重做UX或改变权限、计费、审核、默认统计周期；不建立通用缓存/调度/队列框架。技术未证实项按design停止条件处理。

## Local delivery status

User approved implementation on 2026-11-19. Local code and automated verification are complete; see [verification.md](verification.md). Production P95, real Telegram and Railway termination acceptance remain pending. Task is in review; no commit or deployment performed.
