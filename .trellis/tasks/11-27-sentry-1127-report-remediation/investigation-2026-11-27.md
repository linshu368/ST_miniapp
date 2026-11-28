# 追加只读调查：2026-11-27

以下为规划审核等待期间的历史快照，当时没有task.py start或产品代码修改。用户随后“批准并修复”，现已启动实施；最新结果及不再进行本地UI测试的指令见[repair-evidence.md](repair-evidence.md)，本文件不代表当前任务状态。

## 1. 本地UI基线

命令：

```powershell
pnpm test:ui --grep "@chat-worker-fallback|多行输入与回复偏好可操作"
```

结果：4项通过，耗时1.3分钟；使用现有自动3130/3131与虚构fixture，未接触生产身份、计费或供应商。

- android：Worker不可用→完整原文、输入保留、下一轮仍可发送，通过。
- narrow：同Worker场景，通过。
- android / narrow：多行输入、回复偏好操作及多个风格独立开关，通过。

这证明既有场景在当前代码可工作，不能证明G03/G13线上递归或G05原静态资源故障恢复。没有修改或新增测试；不能把这4项与业务失败/用户数混算。输出沿已有output/playwright，不提交原始trace或业务数据。

## 2. 成本数据库结构核对（仅当前生产）

目标先由Supabase list_projects确认：

- ref wbtsfzozlmurljvglhpn，ST_telegrambot，ap-southeast-1，ACTIVE_HEALTHY，PostgreSQL17.6.1.063。
- 与docs/ARCHITECTURE.md:588明确production ref、docs/relay-providers.md及历史只读核验一致。没有误用TEST ref zoqelpfhurwehlvypryl。
- 通过现有Supabase链接读取information_schema.columns、pg_constraint、pg_trigger及关联pg_class/pg_proc/pg_namespace；没有业务表SELECT、DDL/DML、函数执行或数据库写入。

列查询仅针对ops.llm_calls、ops.llm_cost_jobs及以下允许字段：id/call_id、kind、status、attempts、next_retry_at、cost_usd、cost_source、prompt_tokens、completion_tokens、updated_at。

结果：

- llm_calls：id uuid、tokens bigint、cost_usd numeric、cost_source text、updated_at timestamptz均存在。
- llm_cost_jobs：call_id uuid主键；kind允许surplus_request_record/call_cost；attempts范围0–8；status允许pending/complete/unavailable/forbidden/not_found；updated_at存在。
- llm_calls相关金额/用量非负CHECK和panel/relay shape约束存在；没有发现cost_source特定取值CHECK。
- 两表NOT tgisinternal的触发器查询返回空；不能把P2010直接归因于未核实的自定义触发器。

结论：当前结构没有支持“缺列、缺call_id冲突键、kind未扩展”的证据。它是本轮当前生产shape，不反向证明11-26/27故障时完全同构，也没有验证应用连接角色的实际权限或SQL执行。仍需拿到安全SQLSTATE/失败阶段或隔离执行复现，不能把P2010本身当根因。

本机docker、psql、bash未能通过Get-Command发现，C:/Program Files/PostgreSQL也未发现可用安装；因此既有依赖Docker的PG17隔离脚本当前不能运行。没有改用生产执行SQL或读业务行作为替代。后续可在具备隔离PG17的验证环境复验，或确认本机已有可用二进制后再执行。

## 3. 输入与取消调用链排查

- useMemoryDraft selector返回原entry引用，没有直接返回新对象；store同值write仍提升revision，但尚无证据证明它单独构成反馈环。
- useChatHistory的persisted有useMemo；useChatDraftRecovery在恢复前先清recovery ref，不能仅凭setDraft出现在effect里就认定死循环。
- ChatComposer已有高度/展开依赖与布局hysteresis；usePullDownToClose的onClose使用ref、监听effect只依赖scroller。尚未证明具体反馈组件，不能试探性批量改所有setState。
- conversation-stream已有Promise.race处理stopped、reader.cancel.catch及监听清理。需要复现特定卸载/服务端终态竞态，不能把栈中的abort直接等同“缺catch”。

## 4. 下一步与审核边界

既有规划范围与验收不变；以上是证据补充，不是修复完成。继续保持planning和implementation_authorized=false，等待用户明确批准已给出的最终规划摘要。原错误报告v1不覆盖，任务不提交、不部署、Issue状态不变。
