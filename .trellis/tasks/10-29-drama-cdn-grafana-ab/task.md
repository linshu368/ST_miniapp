# 任务分解

- T1 / done：核实指定UID、当前源代码、分桶与遥测投影缺口，完成复用调研与规划。
- T2 / done：审核prd/design/implement/task的目标、已观测分母边界、5秒起点和不做项。依赖T1；用户已批准最新规划，已进入in_progress。
- T3 / done：grafana.ts白名单、drama-observer.ts终态/耗时投影、drama-media.ts每src窗口维度。依赖T2；对应AC2/AC3/AC4/AC5。
- T4 / done：扩展既有grafana/observer/media测试与faro-loki.mjs，覆盖边界、缺失和回退。依赖T3；对应AC2–AC6。
- T5 / done：docs/grafana/st-engineering-drama.json新增独立对照区和实验筛选，保留其他区域。依赖T3，随T4执行LogQL验证；对应AC1/AC3/AC4/AC5。
- T6 / done（本地）：受影响typecheck/test/lint/build、文档/spec与module更新候选、最终diff复核。依赖T4/T5；对应AC6。
- T7 / pending_separate_gate：TEST/Cloud字段回查、真实Telegram、提交/推送/部署与线上看板写入；按各自证据与授权执行，不将本地完成标为线上完成。

预期不新增测试文件，只扩展现有专项回归。若新增实际产品源码超出3个文件或需要Backend/合同/数据库改动，先说明原因与工作量变化。
