# 执行与验证

1. 规划由只读代理按五项门禁复核，通过后将任务置 in_progress 再写产品代码。
2. root：草稿 store/hook、chat page接线、角色卡轻标记、返回文案、快速Splash、文档与总验收。
3. product_navigation：影像广场/详情/工作室及相关组件，复用草稿hook，不改角色文件。
4. roleplay_scope_review：composerIME、message-list回最新、drawer摘要/重试、收藏并发/提示（含Providers挂载），不改chat page/gallery/影像。
5. locate_checkout：规划/整合只读复核，之后临时预览API/隔离build；不与原预览.next混用。
6. 前端 typecheck、全部现有tests、相关lint、隔离生产build（排除.env并不触碰原.next）。
7. 浏览器验证角色连续试卡、草稿离开回来/跨会话、摘要/返回最新/收藏；影像我的生成/用同款/再生成/参数/返回/错误/下载。正常与320px，临时viewport结束恢复。
8. 临时mock只在/tmp，不进入Git；若真实链路不可执行，明确不能替代真实联调。保存最终截图。无commit/push/部署。

9. 浏览器验收发现开发调试浮标实际覆盖手机发送按钮；已将其改为 development 下显式 ?devtools=1 开启，预览默认不出现；生产原本不显示，行为保持。

## 验收记录（2026-10-23）

- 前端类型通过；47个测试文件/303项回归通过，覆盖草稿隔离/版本条件清空、中文IME、收藏并发与影像返回。全包lint无error；root依赖提醒已修，仅既有5处影像img建议。
- 浏览器真实前端+本机示例：不同角色草稿离开再进保留；同角色两段故事草稿互不串用；历史摘要可见。月白从无历史开始完成3轮示例，打开前无聊过标记，返回后显示聊过，继续保持原session；上翻后出现回到最新，新回复提示可点击回底。
- 角色往返精确复验：进入前/返回后scrollY均228，月白top均270.15625。退出不打负反馈、无自动删除/重排。
- 影像我的生成可从广场进入；注入历史读取503后仍保留原记录，解除后原地重新读取成功。用同款恢复画幅/描述；普通Enter换行；生成受理后可输入下一张草稿，历史再生成后该草稿完整保留；返回后再从我的生成打开仍保留。
- 影像点赞invalidate后往返复验：风景+最新保持，进入前/返回后scrollY均88、海边卡top均354；顶部/Telegram/错误回退使用scroll:false。
- 非Telegram保存准确提供打开原图保存兜底；不声称已下载。画幅中文/形状选项可见，None占位已去除，0返利不展示无效badge。
- 320×640：角色与广场clientWidth/scrollWidth均305；广场标题高28、两按钮均高40且nowrap、最右293；工作室width/scrollWidth均320、输入bottom537、生成bottom611/right291，均在640视口内。最窄屏标题已修复换行；白色滚动条复用chat-scroll-area。viewport已恢复默认，临时QA页已关闭，用户原预览保留。
- 最终隔离生产build通过exit0：/private/tmp/st-roleplay-build-t1pqz2yk/build.log。288源码+21配置/包文件比对differences=[]，包括最后窄屏/滚动/0%修正。原.next/3100/3101未被build操作。
- 截图：/Users/qianpeijia/.codex/visualizations/2026/10/23/01a1669e-8b3a-7120-b95f-d5c880561384/experience-role-discovery.png；experience-image-plaza.png；experience-image-settings.png。
- 草稿只在当前应用内存，硬刷新会失去本机草稿；不引入云存储/落盘。明确失效session的交接经过独立代码复核，未用真实用户删除场景验证；真实Telegram输入法/软键盘、下载、生成/计费/发布仍需test环境人工联调。
- /tmp示例不进Git；无commit/push/部署，既有用户未提交导航/回复偏好改动保留。

## 工作室底部视觉修正计划

1. 独立复核上述窄范围设计，再置in_progress。
2. 仅修改studio页底部按钮展示与图标import，保留真实API/提交与状态。
3. 执行typecheck、已有影像测试、该页lint；浏览器检查正常/320px无溢出、触区>=44px、长模型名、报价、禁用、Sheet/Dialog焦点与关闭。
4. 保存更新后截图，恢复viewport，保留用户原页和内容；独立代码复核后回review，不commit/push。

## 工作室底部视觉修正验收

- 本轮仅studio页标记/样式：参考图/设置去小字与边框保留44px触区；当前模型中性胶囊显示名称+ChevronDown，长名省略且保留完整title/aria；生成正常字号横排并带实时报价，取消额外箭头；输入区不增行。模型宽屏max224px，最窄44px。
- typecheck通过；既有image-plaza 9项测试通过；单页lint无error，仅既有2处img建议。git diff --check、任务9+9上下文验证通过。本轮未重复整包build，上一验收build仅对应之前源码。
- 浏览器390和320检查、模型Sheet/设置Dialog开关、空输入禁用通过；用户原页输入未丢失。320初次实测clientWidth/scrollWidth均320，辅助按钮44x44，模型92.906x44，生成77.094x44，right295/bottom615均在320x640内。最终为最长态把主按钮gap从8缩6、模型min44，正常总宽进一步减2。提交中+报价中按字体/盒模型预算126px主钮、44px模型、88px工具、12px间距=270px，未真实延迟提交显示该状态。无提交生成或费用操作。
- 独立delta复核product_navigation通过；未改quote/submit/模型选择/上传/草稿逻辑和API。真实Telegram软键盘仍沿用既有待联调边界。
- 截图：/Users/qianpeijia/.codex/visualizations/2026/10/23/01a1669e-8b3a-7120-b95f-d5c880561384/studio-toolbar-refined.png。临时检查页已关闭，viewport恢复，用户原页保留。无commit/push/部署。

## 上线前整体验收与发布（用户2026-10-23授权）

用户明确要求检查前面全部改动，无问题即上线。发布沿README feature→dev→main，遵守现有分支检查及审核；仅本轮frontend/spec/task改动，无新迁移/配置开关。先保留线上main已有监控与告警修复，处理合并冲突时上游行为只读保留，再对最终源码重新验证与隔离build。正式包由Vercel Production配置构建，禁止上传本机mock预构建。
独立审查角色/影像；本轮发现多角色收藏同时结束时isMutating===1会漏刷新，已审核收藏专用QueryClient WeakMap定时合并方案，pending归零后刷新；允许在既有favorites.test加同批完成/最后请求失败两条回归，结果8/8通过。不得新增状态框架。
发布前类型、全部测试、lint、cross-package/legacy静态守卫和全新隔离build；PR的CI Quality Gate必须通过，合并后核对生产部署commit、真实API地址、页面及health冒烟。真实Telegram与收费生成若当前访问无法证明，必须保留该验证边界，不把本机示例当真后端通过。保留原生产deployment作为回滚锚点dpl_5FXxsKXLS8cHeXCACBiUQn6ggb5X / main80e6e6e6。
