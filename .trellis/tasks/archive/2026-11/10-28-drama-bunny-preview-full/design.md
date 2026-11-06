# 最小充分设计（待审核）

## 主路径

1. 复用 routes/drama.ts 的真实鉴权、repo 与选集流程，在现有 signed-url.ts 签发/缓存流程中接入单一 Bunny 签名转换。普通 DramaPlayback 形状不变。
2. 配置只由 platform/runtime-config.ts 读取；明确环境必须为 pr-525，数据库 target 必须 test，未启用则保留原路径；启用但配置错误应明确失败，不静默回源。
3. Bunny 新增 TEST 独立路径命名空间，固定 origin host 与 drama-videos 桶；依据真实对象路径和短期 Supabase 下载签名动态回源。CDN 用户签名覆盖对象路径与所有源签名参数，期限早于源签名且不绑定 IP。继续复用完整 URL、有限 TTL、容量与 single-flight。
4. 优先通过原生 token + Edge Rule 的动态 origin 变量实现：应用发 object path 与命名为 origin_token 的源签名参数，Bunny 查询 token 为独立 CDN 签名，规则将 origin_token 传到固定 Supabase 的 token。实施先核对规则对原查询的转发与签名顺序，禁止出现同名 token 覆盖/丢失。若该原生机制实测不支持，停止并报告，不自行增加代理/Worker/存储方案。
5. 删除独立实验页面、组件、路由、专用签名器、只供实验的 shared schema、telemetry 分支与 UI hooks 参数；保留历史 ops 证据。
6. 文档更新 README、ARCHITECTURE、相关 spec/.env.example 与 Preview 运维记录。正常播放器行为不重构。

## 复用调查

- components/drama/drama-player.tsx：保留播放器、媒体释放、位置恢复与 seek，不另建播放器。
- lib/api/drama.ts：保留正常 React Query keys/预取/重试；删除 experiment 条件。
- features/drama/signed-url.ts：复用缓存、single-flight、5 秒签发超时、容量500、完整签名复用。
- routes/drama.ts/repository/assemble：复用权限、目录/归属/可播选择，不新建 repo/DB函数。
- features/drama/cdn-experiment.ts：复用已核实 HMAC-SHA256 思路但取消单样本配置；不保留双签名状态源。
- shared/api/drama.ts 与 telemetry schema：保持普通响应，删除独占实验契约。
- packages/ui-tests：扩展/复跑已有 dramas/drama-play-error 与 @drama，禁止临时 mock 服务。
- 不新建数据库对象，无八域对象归属或 migration。

## 可靠性与安全

- 超时/重试：保留签名5秒上限及既有 client 有限重试；CDN请求由媒体栈执行，手动重试沿原流程，不加无限探针/重试。
- 并发/容量：进程缓存+single-flight沿用；新配置纳入缓存身份/重启清空，防止回源环境混淆。保留现有 Zone 流量限制；确认未耗尽，触顶需报告不擅自扩额。
- 幂等/事务：只读签发，无数据库写入，无需分布式事务/补偿。重复签发复用同 URL。
- 降级/恢复：运维关闭 Preview CDN 配置并重新部署恢复 Supabase；不伪称 Bunny 失败后自动直连成功是 CDN 验收通过。
- 日志：仅记 provider/阶段/错误分类，不记 URL/query/key/initData。不增加监控系统。
- CDN签名覆盖源 token 与路径；固定 TEST源站/桶和规范路径，拒绝越界、编码绕过与不支持对象路径；无密钥在前端或 CDN origin header。
- 继续私有桶，第三方仅接收本次明确选择播放的短期对象能力，不获取TEST全库凭证。

## 发布与恢复

先完成本地验证及内容审核，再按项目独立审批的 commit/push 发布 PR，配置对应 Bunny TEST namespace 和 Railway pr-525。核实 Frontend bundle API 目标，再执行少量 Range/真实页面验收；不合并dev/main，不发布Production。
停止条件：跨环境回源、鉴权负例失败、Range/对象错配、配置含秘密泄露、配额不足或原生动态映射不成立。
恢复：先关闭 Preview CDN flag并部署，确认普通接口恢复Supabase，再阻断 TEST namespace；不删除既有缓存/历史数据或覆盖他人证据。

## 已知限制

首次接入保留签名维度缓存，更新源签名可能产生新的缓存条目；本轮不为提升命中率放宽签名/缓存隔离。实际 CDN 控制台配置、可用额度与动态规则行为为实施首个必验检查点。
