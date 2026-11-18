# 生产兼容迁移设计（2026-11-18）

用户已要求生成SQL，不授权执行。复用当前任务已开始的规划/验收；本文件补充审阅后确定的生产差异与执行计划，主进程inline实施。

## 复用与范围

来源为20261027的video基础、config两份历史迁移、20261117钱包最小守卫和首发分享修正，以及本轮生产只读catalog。保留历史文件，新增20261118两个production文件。基础SQL保留现有视频表/列/RPC/索引契约，只替换与生产不兼容的约束和分享旧列写入；配置SQL复用视频目录validator，扩展当前最外层校验分支，不重建旧key CHECK/包装链，不替换标签validator，不写运行配置/价格。

## 数据落位卡

- video_quotes为现有逻辑M对象，video_attempts为已有混合E/J/M对象；registry已登记moving。本次为现有分支/TEST已验证契约的生产首次部署，不新增逻辑字段；保留其账务/任务拆分债务并在交付说明列明理由，不把它们当作新设计推荐。彻底搬表需同步后端/计费RPC另立任务，本次SQL不偷偷改消费者。
- video_artifacts复用既有E对象；下一份Stream迁移才加入稳定UID/链接和delivery J表。本次不复制已有图片实体、不写用户或账务事实。
- 新增生产中的函数均复用原逻辑入口与签名，无新外部读者；quotes十分钟有效，attempt/产物保留现有生命周期，受作品与账务引用约束，未知任务不自动清理。app_core.users为根FK、钱包通过billing RPC；原业务表M/J债务不扩大。
- managed_config_keys为已有admin/C配置登记，新增一个现有视频目录逻辑key，不扩列；运营配置发布、价格与provider映射仍走现有CLI，不在migration写runtime_config。

## 两份SQL

1. production_base为一次性全事务：原前置对象齐全且视频表/列/RPC未创建才继续；拒绝部分初始化。钱包CHECK要求已知单entry_type列、NOT VALID形状，按原表达式OR视频reserve/refund扩展，保留所有现有类型和验证状态，不扫描/重写历史账务。helper复用最小唯一守卫替换，校验主体/OID/owner/ACL/config不变。分享不再写settings，首发由已有返利事实表达。已存在的私有封面桶只校验、不覆盖参数，桶缺失时按既有契约创建。新表/RPC保持service-only/RLS。
2. production_config要求登记表、key外键和现行lookup存在，拒绝旧CHECK路径或已存在视频validator。登记已存在且为operations_config/未retired时保留，否则拒绝；不存在时插入。创建纯视频目录validator，仅在现有validate_managed_config_value根BEGIN之后插入该key分支，原主体和属性保持。lookup/标签validator/两张表的FK与约束不变。两份成功后重放均明确拒绝，不伪装成无条件幂等。

## 可靠性和恢复

锁等待5秒，base语句120秒、config60秒；已知旧图片规模在10万内才执行base。DDL/校验同事务失败全回滚；通过workflow按环境串行，禁止并行和盲重试。应用行锁、扣费/退款幂等原样保留，不产生外部HTTP/限流/通知副作用。迁移不接受调用方SQL/URL。

一次性DDL若提交成功但账本写入失败，第二次前置拒绝；必须先核对catalog、claim与checksum，再准备独立、审阅后的记账恢复，不能强行再建表或force_rerun。新worker在Stream扩展/配置/应用验收前保持关闭；视频作品导入在新读者部署之后。恢复停worker、保留所有事实，forward-fix；不回退旧image-only读取器或删除产物。

## 日志、性能和验证计划

复用Database Migration的执行者/ref/文件/checksum/claim/ledger审计，SQL异常只含固定诊断码，不输出目录数据/动态正文。运行时复用HTTP/DB/任务Pino request/trace与安全cause，继续默认关闭告警，不新增日志表或字段。日志门禁和已有观测测试验证不退化。

页面/API/P95沿任务meta，新增SQL没有可见Android/iOS或生产API P95样本，仍为null；迁移锁预算与正常请求延迟分别观测。用户免本地UI，本轮不启动UI。

风险涉及迁移、权限与钱，允许新增最小隔离回归文件。使用真实钱包/退款/视频函数、生产catalog形状和合成图片/钱包/配置记录：creator/survey旧类型与原钱包主体保留、bonus-first/main_only、预扣退款一次、图片/首发分享、bucket参数、RLS/ACL；配置原键/NULL/拒绝语义、FK/OID/属性不变、视频key合法/非法、部分或未知形状与事务回滚、重放拒绝。随后应用Stream/参考图/标签迁移及4987条种子SQL，核对组合契约。单连接WASM不冒充多连接并发或生产实测。

命令：node scripts/test-video-production-migrations.mjs <PGlite路径>；既有test-video-wallet-reservation.mjs、test-video-stream-delivery.mjs；shared测试、全部消费者typecheck，迁移名/DB契约/日志/复杂度/格式及git diff检查。运行时TS未改，不重复已验证同源码构建；如新增TS行为则重新构建。不能运行的检查记录原因。
