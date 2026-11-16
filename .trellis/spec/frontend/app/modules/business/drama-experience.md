---
module_id: frontend.business.drama-experience
title: 短剧首页、剧场与本设备追剧
scope: frontend
category: business
status: active
owners: [frontend]
last_verified_task: .trellis/tasks/11-04-drama-play-post-seek-dedupe/
last_verified_at: 2026-11-04
---

# 短剧体验

## 职责与边界

短剧只有一个一级入口「剧场」`/dramas`（2026-11-12 合并，任务 `.trellis/tasks/11-12-theater-merge/`）：双列找剧与追剧；点剧卡封面或顶部「随便看看」进入放映 `/watch`（全屏上下滑换剧，不显示底栏，左上返回剧场）；「接着看」和追剧行进入 `/dramas/:id` 详情选集。`/watch` 地址、埋点路由与 Telegram 竖滑接管保持不变，旧链接直接打开时按全部精选顺序连播。

## 剧场与放映的衔接

- 换剧队列：点击时由 `usePrefetchDramaPlayback` 冻结为当前所见列表（分类/搜索/排序），「随便看看」冻结为全部目录；放映页用 `useDramaFeedQueue` 只读该快照，没有快照（深链）时退回目录，不额外请求。
- 起始剧：两种入口都写 `browse.activeId`；「随便看看」从上次放映停下的那部开始。
- 起播计时：剧卡封面按 `cover`、owner=`home` 计；链接带 `data-drama-cover`，`installDramaTiming` 不再另起放映目录计时。`cover` 开播的 route 因此从 `/dramas/:id` 变为 `/watch`。
- 返回定位：放映随换剧把 activeId 写入 `lib/drama-feed-return.ts`（页面会话内存，不落盘）；剧场在渲染阶段读取、挂载后清空，恢复滚动后若该卡不在可视区就滚到居中，并用香槟金描边闪一次。渲染下限包含该卡索引。
- 启动框架：`/watch` 的启动内容带 `data-startup-fullscreen`，早期 ready 不再等待底栏。

## 当前状态

`components/drama/drama-home.tsx` 使用原 DramaPlayer 嵌入；主页上下滑或当前条目播完进入另一部；点击「观看完整短剧」进入专注详情并延续进度，详情上下滑与自动续播都在本剧内，末集停留。最后3秒只预取下一条地址，保留片尾；小幅纵向过渡，减少动态偏好下无动画。没有下一条时停在尾帧，不显示到头文案。剧场浏览列表仅固定搜索栏，栏目、分类、排序与续看入口随内容滚动；卡片封面下仅显示剧名，不展示简介或标签。返回保留条件与滚动。EpisodeSheet黑灰面板、简介/选集切换、30集分组、打开定位当前组；失败保留恢复入口；暂停不强制打断纯净模式，单击可唤回控件。

`lib/api/drama.ts` 使用列表/详情契约，取址改为固定地址 `POST /api/dramas/play`（CORS 预检可缓存；旧 `GET /api/dramas/:id/play` 保留给旧客户端），详情与签名并行。点封面、详情页换剧在点击当下（`beginPlayback` 之后）发出取址，播放器的 `useDramaPlaybackQuery` 按 (剧, 集) 接上这次请求：10 秒内有效、只用一次、接不上就新建，每次播放意图仍重新取址，不复用意图前的结果。点击按本设备进度确定目标集；互动增量通过 social/like/comments API，与播放并行且互不阻塞。媒体每次换集、换剧、离开先保存后暂停并释放src，过时Promise不能恢复播放。浏览器有声自动播放受限时仅降级一次静音，失败保留手动播放。

一级导航会在后台预算内预热 `/`、`/dramas` route chunk，但不会在底栏 intent 阶段额外拉短剧目录；五入口回归证明该请求会与剧场首批卡片的增量挂载形成竞态。目录继续由既有 React Query、持久缓存和页面 query 负责。`/`、`/dramas` 的点击到内容 ready 沿统一 `page.navigation` 口径记录，2 秒目标必须发布后按 Android/iOS 与 release 验证。

## 入口与调用者

用户从底栏「剧场」进入 `/dramas`，点剧卡或「随便看看」进入 `/watch` 放映，在放映点「观看完整短剧」或在剧场点「接着看」/追剧行进入 `/dramas/:id` 详情与选集；评论、追剧和播放手势由同一短剧页面链路调用。

## 涉及文件

| 路径                                                             | 职责                           |
| ---------------------------------------------------------------- | ------------------------------ |
| `packages/frontend/src/components/drama/`                        | 播放器、评论与选集 UI          |
| `packages/frontend/src/app/(main)/dramas/`                       | 剧场与详情路由                 |
| `packages/frontend/src/components/drama/drama-theater-cards.tsx` | 剧卡、随便看看、续看、返回定位 |
| `packages/frontend/src/components/drama/drama-library-tab.tsx`   | 追剧栏目与位置恢复             |
| `packages/frontend/src/lib/drama-feed-return.ts`                 | 放映返回剧场要找回的剧         |
| `packages/frontend/src/lib/api/drama.ts`                         | 短剧 query 与互动 mutation     |
| `packages/frontend/src/stores/drama-library-store.ts`            | 本设备追剧与观看位置           |

## 关键实现链路

目录 query → 选择剧集（封面/换剧点击即发取址）→ 详情与签名并行 → 媒体装载/恢复位置 → 播放、手势与互动；换集、换剧和离页先保存并释放旧媒体，过时请求不得抢回播放状态。

## 数据、契约与外部依赖

`stores/drama-library-store.ts` 保存有界的本设备追剧ID和观看位置，不存视频签名、凭证或完整目录。按Telegram用户隔离key，单设备使用，最多200部；每5秒及暂停/退出补存。sessionStorage保存剧场条件和位置，损坏/写满降级内存；失效历史集数回退首集。用户允许必要时短剧专属schema扩展；本设备收藏不做跨设备同步；新增点赞/评论存入 drama_archive 专属互动表。

依赖 shared drama 契约、Backend 短剧 HTTP API、浏览器媒体能力和 Telegram WebView。

## 关键节点与约束

播放地址与当前媒体属于首屏关键路径；评论、简介与选集等可选面板不得阻塞首帧。旧媒体、迟到签名和后台页面不得恢复发声；评论草稿与目标按打开时剧集隔离。

## 验证方式

复用 `packages/ui-tests` 的 `@drama`、dramas/drama-list-error/drama-play-error/drama-interaction-error/empty 场景；默认390×844、窄屏320×568。已有前端类型、测试、lint/build及角色/影像固定验收继续执行。真实媒体、原生Telegram/系统手势与生产接口不以本地模拟结论替代。

## 已知缺口与待核验项

进度条拖动会话在 `components/drama/use-drama-scrub.ts`：指针松手提交后 500ms 内忽略原生 range 的 onChange，避免 Android 上同一手势提交两次。提前发出取址只覆盖封面与详情页换剧；选集、首页自动播放的首次请求不在其内，修饰键点击封面可能多发一次不会被接上的请求。

真实媒体、Telegram 原生手势、系统键盘和生产签名服务仍需真机与发布后观测；本地固定 fixture 不能替代生产 P95。

## 关联模块

`frontend.infrastructure.client-ui-foundation`、`backend.infrastructure.runtime-data-security`。

## 官方剧互动

页面仅包含推荐、追剧；无博主/粉丝/转发/红包。右侧收藏、评论、点赞操作独立，收藏回到追剧库。点赞乐观反馈失败回退并读回服务器；评论仅抽屉打开查询，20条游标分页，500字纯文本，提交 UUID 重试复用，失败保留草稿，可确认删除自己的评论。评论开关不改变播放状态，续播跨剧时保留打开时的评论归属与草稿；评论容器由稳定主布局持有。可视视口变化调整抽屉，输入和提交留在键盘上方。当前验收仅模拟手机视口，非系统键盘实测。

## 视觉方向

红果式清晰结构、两列剧卡与沉浸操作是参考；本产品短剧以夜间使用为主要场景，暖炭黑底、柔和米白文字，低饱和玫瑰色只用于选中与关键操作。避免高亮大块白底、鲜橙或艳色渐变；视觉调整局限于短剧及其导航状态。

## 播放手势与会话

主布局仅在首页与详情播放路由持有 Telegram 竖滑禁用，换剧、弹面板不释放，离开播放页恢复进入前状态。SDK mount 自身会禁用竖滑，先记录状态再 mount。播放器使用本层原生捕获监听和非 passive touchmove，竖滑阻止向父级传递；横滑、多指、取消、进度和面板操作不换剧。评论/选集列表保留独立滚动。后台页不自动换剧或发声；选集面板期间等待选择，评论不阻塞续播。静音和倍速在本次会话的 Zustand 内沿用，换源同步 defaultPlaybackRate 避免浏览器重置。

## 标签与高频操作约定

标签沿用已有数据顺序。用户最新确认剧场卡片先不放标签；播放页最多6个完整标签自然换行，更多以+N进入简介查看；简介全部显示。无标签不留空位，长词可折行。

用户明确的手势心智：单击画面只切换控件/纯净模式，双击任意空白只切换播放/暂停；中央播放图标仍可单击。320ms单击判定避免双击先闪开/闪关控件；滑动/离开/换源取消尚未执行的单击。首页纯净模式同时收起顶部和底部导航并让视频铺满，单击恢复；离开播放场景恢复默认界面。不得再次把单击改为播放暂停。

上滑从剧名/简介、中央图标开始也成立，移动后取消按钮点击。手指按住或倍速面板打开时自动续播等操作结束。倍速用四个可直接选择的按钮，点击画面只关闭选择器，不改变播放。评论与选集的横杠/标题空白区可下拉收起，短拖回弹；列表、表单和关闭按钮保留各自操作。所有优化以用户自然动作是否得到预期反应验收，不以代码流程可执行替代。

## 第六轮细节（2026-10-27）

`use-drama-swipe` 在稳定触摸表面下移动画面合成层，用封面承接邻页；距离/速度阈值、边界阻尼、取消回弹，允许立即打断回弹再次拖动。详情手势不换剧。`drama-progress` 全宽48px触区，拖动预览/松手提交，保存拖前播放状态，后台/换源取消不抢播；原暂停拖到末尾不续集。单击显隐无自动3秒计时，纯净双击短暂图标确认。

首页完整短剧入口为真正路由，`from=feed`控制返回原首页，其余返回剧场；详情底部按钮显示选集。关键词搜索忽略旧分类，清空恢复分类/滚动。追剧整行可点、收藏独立。`engagedAt=0` 标识新版试看；老记录缺省按原时间兼容。真实观看累计 min(15秒, 时长×70%) 且不少于3秒，或主动选集后更新有效观看顺序；快进不算观看，全部历史仍保存。

## 发布前连续观看收尾

播放重试先保存当前集与秒数，等待新地址成功后只装载一次；等待时按钮禁用，失败保留位置且可再试，换集/退出使旧尝试失效。同集后台签名更新也恢复原位置，保留用户暂停状态；正常片尾仍可续播。重试精确保留临近片尾位置，不套用重新进入已看完单集的归零规则。

首页/详情自动恢复上次进度（非重试、非后台签名更新的历史续播）在 `format=hls` 时向下对齐到 Stream 固定的 4s 分片边界（`STREAM_HLS_FRAGMENT_SECONDS`），并把该秒数作为 `startPosition` 传给 hls.js，让第一片直接请求目标分片，不再先拉 0 秒分片探测带宽、再因设置 `currentTime` 清空重拉；MP4 与上述两种精确续播路径不对齐。

首页指定选集的 `video` 参数在媒体与详情就绪、该集0秒或实际位置写入后消费；保留 `from=feed`，后续刷新按最新观看记录恢复。有缓存剧目时目录后台失败不中断当前播放器，仅在控件可见时提供轻量刷新入口。

已收藏/最近看过分别保留本会话滚动位置及行锚点，排序改变后优先找回刚点击的剧。选集每次打开或从简介切入时保证当前集与分组可见；集数分组固定在列表上方，用户开始翻组/滚动后不再自动抢位置。

## 短剧播放来源

推荐列表置顶环境清单中的 30 部剧。所有账号播放清单内单集均取 Stream HLS；其余单集走 Supabase。Stream 签名或媒体失败时，每次播放意图可自动重新取址一次，重试绑定失败的视频 ID，保留累计等待和原失败终态。Apple 原生 HLS 的 `play_url` 在取址返回处（`capAppleHlsQuality`）追加 `clientBandwidthHint=2.5`，主清单被裁成 ≤720p 单档（实测 30 部片均不出 1080p），该流上 iOS 不自动切换画质；Android hls.js 从最低档起播，不受影响。配置默认关闭，真机与生产验收状态见本次任务，操作说明见 `docs/drama-stream-ab.md`。

Stream 域名由 `NEXT_PUBLIC_DRAMA_STREAM_ORIGIN` 提供（`lib/drama-stream-origin.ts`）：根布局输出 CORS 与非 CORS 两条 preconnect，播放意图（`startDramaPlayIntent`）时重新插入，因为空闲连接约 10s 被关闭。播放地址每次 `/play` 现签，取到地址后立即设置源，不做清单预取。起播诊断对 Stream 源接收同域名的全部资源计时并按路径标 `kind`（manifest/playlist/segment），其余源仍只认精确 URL；hls.js 路径由 `perf/drama-hls.ts` 记录清单、子清单、init 与分片的首字节、字节数、档位和入缓冲时间（≤16 条，起播终态后停止），经 `loadDramaSource` 的 `onHls` 在加载主清单前订阅。上报只含数值与分类，不含 URL。带 `delivery` 的实验组诊断由 Backend 全量写入 Loki，其余流量仍只留起播 ≥5s / 快进 ≥3s。

非 Apple 平台的 `preloadDramaHls()`（提前 `import('hls.js')`）延后到首页/详情首帧绘制后的一次空闲触发（复用 `navigation-quiet-window.ts` 的 `afterNavigationQuietWindow()`），避免会话内首次起播时和播放器自身的 hls.js 导入抢带宽；非五入口导航或该安静窗口未激活时等价于立即预取，不劣化。

hls.js 路径（Android `hlsjs_mse`、iOS `hlsjs_mms`）由 `lib/drama-hls-seek.ts` 的 `restartStalledAudioOnSeek` 处理无缓冲快进的音视频串行：hls.js 1.7.4 会把领先视频的已下载音频片挂起等视频入缓冲，快进时不中止它，导致目标音频片要等目标视频片入缓冲后才请求。`seeking` 时若目标未缓冲且挂着一片不覆盖目标的音频，调用 `hls.stopLoad()` + `hls.startLoad(currentTime, true)` 让两路并行请求；其余快进不介入，异常吞掉等价于现状。升级 hls.js 时先用快进诊断的两路覆盖分片 `startMs` 差确认上游是否已修复，修复后删除。（任务 `.trellis/tasks/11-12-drama-seek-parallel-av/`）
