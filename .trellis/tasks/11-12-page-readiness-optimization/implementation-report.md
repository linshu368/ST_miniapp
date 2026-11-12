# 慢页面与失败恢复整体优化实施报告

日期：2026-11-12。状态：**本地实现与验收完成；未提交、未推送、未部署。**

依据：[13页筛选与优化设计](../11-12-overnight-page-performance/slow-pages-optimization-design.md)、[生产基线报告](../11-12-overnight-page-performance/report.md)。原采样窗口为北京时间2026-11-11 19:00—11-12 10:09:24。本报告记录实现与本地验证，不提供虚构的“优化后生产P95”。

## 1. 实施版本与范围

- 工作分支：`perf/overnight-page-readiness`，基于最新 `origin/dev / 0c5977e2`；原 `fix_request_speed / 5a05ffc0` 没有合入此分支。
- 核对时 `origin/main / 9716d8a1` 比 dev 多两次入口上报提交，未改写或移植上游行为。合并发布前仍需重新核对目标分支。
- 改动集中于 Frontend 与其现有 Next 大厅代理。保留上游已实现的全局查询不叠加重试、短剧非阻塞 manifest、角色推荐缓存和新功能。
- 未调整并发帽、原超时数值、ready/首帧含义、生产配置或数据库；不因低样本P95推断后端容量/SQL/CDN根因。

## 2. 已实施的修复

### 请求期限覆盖完整等待

原先普通 API 在请求槽外等待，拿槽后才启动超时，队列积压会额外延长用户等待。现在由既有 timedFetch 持有每次 attempt 的期限，覆盖排队、fetch、正文读取和解析；过期队列不再派发，取消和异常均释放槽。

保留最多两次安全读取尝试，退避在槽外，用户主动取消不重试；创建、生成等原有写入不增加重试，长操作保留 bypass。没有把“页面2秒目标”设置为所有接口硬超时。

### 页面正文优先，预取与附属请求让路

通知列表/详情、客服会话、心愿列表/详情、本人角色编辑详情、创作数据 overview 和当前短剧详情使用 critical。通知预取、客服未读和片尾详情预取走 background，创作数据附属面板保持 normal。

预取与正文保留同一 query key，在途合并；已在途的 background 请求不会强制升级或再发一份。公告仍保持 staleTime=0、挂载刷新和既有前台轮询，未读水位、统计权限、账号隔离和原缓存周期不变。

### 新建聊天只消费一次创建结果

创建成功已返回 session/messages，不必立即再 GET 同一份详情。现在仅当前创建 ID 与对应确认缓存对象可跳过首次读取；首次订阅提交后恢复 staleTime=0，后续焦点刷新、显式失效和会话切换仍读取服务器。

已有会话继续按原规则刷新，streaming 状态继续1500ms轮询，草稿、历史分页和计费不变。实际 QueryObserver 验证了 disabled→新 key、相同 key 恢复新鲜度、跨设备焦点刷新及 invalidation；没有用全局长 TTL 掩盖重复请求。

### Android 深层导航暂缓次要工作

复用已有 navigation-quiet-window，覆盖已登记页面的同源普通 Link 点击及 history 返回。Android/Android X 在正文 ready/error 前暂缓 enrich/background，保留两次绘制及有界 idle 释放、旧 generation 隔离和4秒兜底；正文关键读取不被阻塞。

iOS 维持原调度。下载、新窗口、修饰键、外链和同页链接不触发；遥测关闭也生效。根启动归因沿用启动级信号，不随导航卸载重播。程序式 router 导航尚不由此 click 监听覆盖，不声称覆盖所有入口。

### 大厅代理提供可恢复的错误响应

原 catch 抛错可能变成 Next HTML 错误页。现在返回已有 shared 错误 envelope：调用方取消499/REQUEST_ABORTED，原5秒期限超时504/UPSTREAM_TIMEOUT，网络或上游读取异常502/UPSTREAM_UNAVAILABLE；取消不记为上游故障。

上述异常响应禁止缓存，仅合法公开 latest 成功结果沿用原共享缓存；推荐和指定 selection 继续隔离。固定安全文案不暴露原异常或上游正文。

## 3. 13个页面的实际覆盖

| 页面                            | 本次处理                                             | 保留的边界                                           |
| ------------------------------- | ---------------------------------------------------- | ---------------------------------------------------- |
| `/characters`                   | 原目录期限修复保持；代理错误标准化；入场旁路调度     | Android原4000ms、iOS20000ms不变；推荐/公共缓存不混用 |
| `/chat/:id`                     | 创建结果只复用一次；详情期限与深层导航让路           | 历史回读、焦点刷新、草稿、生成写入与计费不变         |
| `/profile`                      | Android导航期间暂缓公共旁路；原路由预热保留          | 不把余额等次要数据加入ready条件                      |
| `/profile/messages`             | 正文critical、预取background、完整期限               | 公告即时性及已读/未读语义不变                        |
| `/profile/messages/:id`         | 详情critical、完整期限、深层Link/返回调度            | 单个冷启动样本不足以证明根因或收益                   |
| `/profile/support`              | 会话critical、未读background、完整期限               | 不改独立客服服务，不以本地fixture替代上游P95         |
| `/creation/data`                | overviewcritical、其他统计normal                     | 同一统计条件、权限与30秒请求预算不变                 |
| `/creation/characters/:id/edit` | 本人详情critical、完整期限                           | 不批量预取私有草稿，不改发布/审核                    |
| `/wishes`                       | 列表/详情critical、完整期限                          | 排序、我的/公开身份隔离和原缓存不变                  |
| `/create`                       | 原关键请求优先级保持；完整期限与Android旁路让路      | 保留首图/内容ready、分页和收费生成语义               |
| `/dramas`                       | 原目录关键请求及上游manifest修复保留；完整期限与调度 | 不因2.07秒低样本重做列表/渲染框架                    |
| `/dramas/:id`                   | 可见详情critical、片尾详情background；完整期限       | 真实首帧+playing、签名、媒体/进度恢复不变            |
| `/watch`                        | 同短剧请求期限/预取调度；保留现有视频链路            | 页面ready与视频startup分别验证，不把海报算播放成功   |

公共修复覆盖请求与调度，不等于已经独立定位并消除每个页面的生产慢因。冷启动JS下载、真实媒体/CDN、客户端网络及客服上游仍需实际版本证据。

## 4. 验证记录

| 检查                     | 结果                                                |
| ------------------------ | --------------------------------------------------- |
| Frontend完整Vitest       | 最终70个文件、785项全部通过                         |
| 新建会话观察者回归       | 6项通过，含一次入场复用与后续focus刷新              |
| 全仓 `pnpm -r typecheck` | 8个workspace包通过                                  |
| Frontend lint            | 通过；未改文件仍有既有img/hooks警告                 |
| Frontend生产build        | 最终代码build通过；产物完成，Next依赖完整性复核通过 |
| 复杂度检查               | 通过；既有基线告警未在本轮扩大                      |
| UI fixture协议测试       | 11项全部通过                                        |
| 移动端UI固定流程         | 最终40项390/320px验收进行中，完成后更新             |

初次广泛筛选184项后收敛为相关40项，不宣称184项全部通过。聊天场景两次在首次 `page.goto` 等待HTML时超过45秒，尚未进入业务断言；trace内文档请求无响应，后续聊天历史/切换场景通过。最终采用文档已有的常驻预览方式，先完成HTTP首次编译再运行场景，保留原测试超时与断言。

验收还修正了既有角色封面PNG fixture的IDAT CRC，像素数据不变。期间本机Next依赖目录为空导致构建缺少impl模块、预览出现500；停止无效验收后通过 `pnpm install --frozen-lockfile --force` 按原锁文件恢复，最终构建再次通过。依赖清空原因未确认，未归因为产品逻辑或修改依赖版本；锁文件保持不变。最终standalone产物保存在本机忽略目录 `output/build-snapshots/page-readiness-standalone-final/`，避免后续build再次沿链接清理依赖；普通.next其余产物保留。

本地fixture不调用生产API、真实支付、模型供应商或数据库。生产构建仅关闭本次进程的Sentry上传配置以避免远端写入，没有改配置文件。

可重复的核心命令（UI按仓库README先保持3130/3131预览运行并完成首次页面编译）：

```powershell
pnpm --filter @miniapp/frontend exec vitest run --maxWorkers=2
pnpm -r typecheck
pnpm --filter @miniapp/frontend lint
# Windows??build??testing-quality-and-deployment.md???standalone??
pnpm --filter @miniapp/frontend build
pnpm --filter @miniapp/ui-tests test:fixtures
node scripts/complexity-budget.mjs check
pnpm test:ui --grep '@startup|@navigation|@creator-data|@chat-sessions|@chat-history|Surplus Intelligence 目录|浏览角色时|公共前12先|换批缺新卡|广场用同款|图片失败|私密发布|站内通知|心愿排序|播放失败可重试|片尾仅预取|视频流观看完整|未开通会员|签到失败'
```

## 5. 规范、观测与恢复

已准备5个受影响模块的 `module-updates.json`，按Trellis归档流程同步，校验来源为实际代码/回归文件。frontend测试规范已同步更新，故障复盘见bug-analysis.md。包含期限owner、一次缓存豁免、Android调度和代理失败矩阵；并纠正规范当前段仍写Android目录1.8秒、实际已为4秒的差异，历史变更记录保留。

Sentry `api.request.duration` 和 `api.headers.duration`（开始到响应头）在本版本纳入普通API的槽等待，跨release比较必须注明测量边界；Grafana逻辑API的queue/headers/body继续按实际dispatch分段，Sentry86次与Grafana4次timeout原基线不能混加。没有补历史数据或删除慢/失败样本。

回退以本次Frontend改动为单位恢复，无migration、数据回填或生产配置补偿。若出现身份/缓存串用、写入重放、首次内容不可达、首帧/ready语义变化，停止发布并修复或回退；保留所有上游新功能和原草稿/历史数据。

## 6. 发布后仍需完成的验证

1. 按真实部署SHA确认本分支及上游行为，建立同release窗口，分别统计Android/iOS、route、导航/冷启动/挂载，不能平均P95或把无样本补零。
2. 优先观察Android个人中心导航（原4.57秒/N107）与大厅冷启动（原8.31秒/N115）；聊天同时看导航、挂载、失败与详情请求。其余低样本先积累样本，不宣称稳定收益。
3. 同时检查error/stall/left、请求数、队列/在途、读取超时及资源竞争；成功P95下降但失败/离页变差视为未达标。
4. Telegram Android/iOS真机核对冷开深链、快速连续切页、返回、弱网/离线恢复、客服、聊天重进和真实媒体播放。原生键盘、手势、视频首帧和实际账务不由Chromium手机尺寸模拟证明。
5. 复用现有本地验收系统持续运行本轮40项场景；后续如新增程序式导航调度或真实失败复现，优先扩展原@navigation/@chat/@roleplay场景，不另建同构mock框架。

页面最终目标仍为同口径P95≤2000ms，大厅冷启动先观察4000ms阶段目标；本地验证只能证明实现与恢复路径，不证明生产目标已达成。
