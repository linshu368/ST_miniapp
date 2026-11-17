# Schema 划分与对象约定

> **归属与落位的权威是 [`docs/db/CONTRACT.md`](../../../../docs/db/CONTRACT.md) 与 [`docs/db/registry.yaml`](../../../../docs/db/registry.yaml)。** 包括业务域 × 数据性质、新表、新列、jsonb、配置 key、函数和外部读者的规则。原"九域地图 / 新对象判定流程 / 跨 schema 拆分原则 / 新建表必填说明"已并入契约，本文件只保留对象级书写约定。

## 对象规则

- 新表/函数进入拥有该领域不变量的 schema；禁止为规避权限或 import 边界堆入 `public`。
- 视图、物化视图和函数默认跟随其业务用途或维护的不变量，不因主要来源表位于另一个 schema 就自动跟随来源表。
- 新建 schema 的门槛见 CONTRACT §1.1；功能分组靠表名前缀，不靠 schema。
- 表/列/function 使用 snake_case；PK/FK/unique/check/index/policy/trigger 显式命名，便于诊断和回滚。
- PK 类型与 FK 完全一致；FK 说明删除/更新策略并为高频连接列评估索引。
- `timestamptz` 表达绝对时间；金额/credits 明确单位和精度；状态优先 check/enum 并规划演进。
- `NOT NULL`、default、check 应表达数据库不变量；新增非空列需处理历史数据并避免长锁。
- 表、关键列、函数和非常规索引 SHOULD 有 comment，描述业务语义、单位和限制，不写 secret。
- view/materialized view/function 必须有所有者、依赖和刷新/安全语义；跨 schema 依赖在设计中列出。

## 可靠性与简洁性

事务只包裹必须原子化的最小写集；关键钱包/奖励写入评估幂等键和并发冲突。索引基于查询与 explain 证据，不为所有列预建；触发器/RPC 仅在数据库必须维护跨写一致性时使用，避免隐藏业务流。
