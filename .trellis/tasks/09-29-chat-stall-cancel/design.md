# 设计与审查

## 复用调研

复用 ConversationHistoryRepository、existing startTurn/startRegeneration RPC、generation execute/quota/settle、React Query conversations、现有 footer/ChatRegenerateButton。取消使用已有 experience.chat_history.status=stream_interrupted 与 finish_reason=cancelled，不建表/函数/框架；无 schema migration。

## 数据流

shared 新增取消请求/结果契约 → ownership route → repository 绑定 session+history ID 原子设置 streaming.llm_finish_reason=cancelled → 生成周期读取标记并 abort 上游 → 释放免费额度后 CAS 终态。正常完成只可在 streaming 且无取消标记时抢占；取消先赢不计费，正常完成先赢取消返回已完成。取消接口有限等待执行线程确认，未确认返回 CANCEL_PENDING 并保持 busy，避免旧免费预留未释放便重生成被误判付费。数据库为跨实例事实来源，不以进程 Map 保证一致性。
前端取消独立于断网/离页。首字前尚无落库 ID 时，保留单次取消意图并在有限时间内等待精确本轮 ID，避免仅查三次后需要用户再次点击。已有消息 ID 时立即调用取消；尚未收到 start 时查询当前轮对应的新 revision，确认 ID 后取消，不盲目取消最近消息。前端请求/取消/缓存刷新有有限时间界限、旧请求身份隔离。新客户端在 send/regenerate 发送可选 request_id UUID，后端在开轮后立即写入 history JSON 首条记录的辅助属性，正式 prompt 快照保留同一 UUID，仅装饰落库副本，不能传上游。ChatMessage 可选 request_id 使首字前精确定位同时匹配本次关联 ID、turn、revision；两个设备同时请求相同轮次也不会误取消。该 ID 仅关联取消，不作为 generation/charge 幂等键；旧客户端/旧行仍兼容。现有 history consumers 仅提取开场白、上下文用 user_input/assistant_reply，额外属性无业务 prompt 含义。重新生成复用最后一轮，不新增用户输入。

## 可靠性

CAS 状态转换解决取消/完成/旧 revision 竞争；有限轮询处理不同副本，无自动重试生成；免费额度通过既有 finalize(false)，异步计费保持 interrupted；活跃生成整体 110 秒截止，为 120 秒残留恢复预留额度清理窗口；单次额度/关键状态 DB 调用 5 秒界限。HTTP abort 不等于数据库事务回滚，因此额度决定不明时保持 busy，不能确认取消成功。取消/超时保留已有正文，残留 streaming 在详情读取以及发送/重生成前按 120 秒阈值条件回收；开轮 RPC 的历史回收阈值改为 24 小时，避免临界 crossing 绕过额度释放，实际恢复仍由 120 秒显式路径负责。失败不可静默解锁并声称服务端已取消。连接丢失不自动当成用户取消。日志仅安全 ID/状态/耗时。免费额度释放必须先于取消终态；无法确认释放不伪装成功。执行实例被杀时读取详情的过期恢复使用持久化 chargeId 释放预留后收口。

## 演进与恢复

后端与 shared 先发布、前端后发布；旧客户端继续兼容。取消标记复用已有字符串字段。回滚整个 hotfix commit（尚未提交）；不回滚数据库，因为无需迁移。发布前 TEST 真上游/SSE、免费额度与钱包验证；Production 不在本任务授权范围。停止条件：竞态扣费、跨会话取消或恢复失败。

## 最小充分方案

不新建队列、Redis、通用状态机、不无限重试；必要的计费前终态权威校验和回归测试不可省略。
