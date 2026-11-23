# 延后加载的交互补齐（2026-11-23）

用户已要求处理聚合或交互，随后明确：模型和设置未保存时使用原配置可以接受。沿用当前已授权的历史优化任务，范围以这次补充为准；不启动本地UI。

## 需求与验收

- 历史展示不等待模型、设置、余额、语音；不扩大历史聚合接口。
- 未保存草稿、目录/偏好尚在加载均不阻塞普通发送；发送仍由Backend读取已保存配置。只有模型选择/设置PATCH正在提交时短暂阻止新的发送、重生成及choice发送，保留草稿并说明保存中。
- 模型选择成功确认后才更新当前模型展示；失败保留原展示并允许重试。打开模型/偏好面板立即读取，区分加载失败与真实空目录。
- 语音独立区分等待调度、加载、错误、可用；已有音频继续可播。记录未确认时不能发起生成/重生成，点击加载/重试只执行GET。新会话不能使用旧会话的读取状态。
- 读写请求有限超时，付费POST不自动重发；本轮不改变服务端计费、权限、CAS、模型选择协议或持久缓存。

## 复用与最小方案

复用modelCatalogKeys/useModelCatalogQuery/useSelectModelMutation、generationConfigKeys/useGenerationConfigQuery/usePatchGenerationConfigMutation、voiceKeys及原语音hooks、TanStack Query的mutationKey/useIsMutating/isMutating。复用现有API终态及后端HTTP日志，不增加HTTP入口、RPC、schema、迁移、供应商调用或通用加载框架。提取聊天专用保存保护及语音组合hook，以收紧超长页面基线。

不采用大聚合：历史、配置和音频并无相同失败/刷新生命周期，合并会放大尾延迟；GET聚合也不能消除客户端保存中的并发问题。按点击放行仅绕过自动延后调度，不取消在途GET或创建重复query key。

## 可靠性、兼容与恢复

保存保护同时订阅MutationCache与发送事件同步检查，覆盖尚未重渲染的窗口；未保存草稿不进入保护。模型选择按现有QueryClient的mutation scope串行，防止同页面多个入口的选择响应乱序。没有新事务、分布式锁或业务幂等存储；服务端原规则继续权威。

已发出POST超时不证明服务器未写入，不将失败提示说成数据库回滚，不自动重试写入。模型失败后通过原目录GET重新校准，GET失败不冒充成功；原缓存仅作展示。额度、付款和供应商故障仍由原后端校验与恢复处理。

语音GET失败只影响语音；禁止把失败转换为空记录并调用生成。新会话按query key隔离，操作处理器再次校验当前读取状态与生成在途状态；音频记录成功不受可选配置刷新失败影响播放。GET与POST使用通用client的总预算；重复点击复用已有query和在途状态，不增加重试层。

无数据库/公开契约变化，单Frontend可兼容发布，异常可回退前端。iOS/Android按原任务的48小时窗口、路由/release、N与P95目标分别验证；语音/模型/设置API当前无分端基线，记为无样本，发布后建立，禁止补零。网络读取增加仅来自明确点击；仍保留原自动background放行，不放大历史首屏依赖。

## 执行与验证

1. 增加模型/偏好mutationKey及聊天保存保护；改模型为成功后更新、面板打开读取、错误/重试展示。
2. 回复偏好沿用原query key，自动enrich/显式打开读取；只在提交期间保护发送，编辑草稿仍可发送旧配置。
3. 提取原语音编排并加入读取状态、重试及付费操作保护；缩小聊天页面。
4. 风险评审确认需要回归，优先扩展既有models/generation-config/conversations-entry/use-conversation-turn/voice-playback测试文件；覆盖真实MutationCache并发、即时保存前发送、失败重试、语音GET失败不POST及切会话隔离，不新增浏览器测试。
5. 运行Frontend全量Vitest（maxWorkers=2）、typecheck、lint、build、复杂度、import边界与diff检查。Windows build前移动standalone到已核验的workspace忽略目录，不递归删除junction。
6. 本地UI/Telegram键盘/真实付费供应商未验收，不记通过。建议之后扩展既有@chat fixture，记录加载/失败/重试、保存中发送、语音晚响应；本轮不启动。

日志复用`api.terminal`的固定route/method/outcome/attempts及时间，与后端`operation.terminal/http.request`的request/trace头关联。保存中的本地拒绝展示status而非error，不伪造服务端请求日志；真实错误沿通用出口，不记录草稿、模型正文、余额或语音URL。无新告警或通知。
