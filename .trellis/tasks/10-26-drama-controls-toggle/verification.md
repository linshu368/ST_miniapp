# 验证与交付记录

## 变更边界

2026-10-26，用户确认只实施第 1 项并提交；第 2 项只提供思路，第 3 项暂缓。产品代码仅修改 `packages/frontend/src/components/drama/drama-player.tsx`。

- 画面按钮以 functional updater 切换 controlsVisible，并重置 activity。
- 父级 click capture 保留滑动后防误触；识别画面按钮后交给按钮处理，避免捕获阶段先显示而破坏切换。其他控件仍只显示并续计时。
- 控件隐藏时不维持自动隐藏计时器，重新显示后完整计时 3 秒；弹层、指针和键盘的暂停规则不变。
- 动态 aria-label 与实际显隐操作一致。

## 自动检查

- `pnpm --filter @miniapp/frontend typecheck`：通过。
- `pnpm --filter @miniapp/frontend test`：58 个文件、436 项通过。
- `pnpm --filter @miniapp/frontend lint`：通过；只有原有影像页面/组件的 5 个 no-img-element 警告。
- `pnpm --filter @miniapp/frontend build`：通过；另有原有 Browserslist 数据过期提示。
- Prettier：本次代码和规范检查通过。
- `git diff --check`：通过。
- `python3 ./.trellis/scripts/module_knowledge.py check .trellis/tasks/10-26-drama-controls-toggle`：通过。

## 本地 DOM 交互验证

通过 stdin 临时脚本，转译并挂载实际 DramaPlayer 源码到既有 jsdom/React 18。仅替换外部 API、媒体 I/O 与 Sheet/选集展示为本地 fixture，不创建测试文件、不发网络请求、不改变依赖。受测状态、事件捕获/冒泡、effect 与定时器均来自实际播放器组件。

通过：初始显示；连续点击隐藏/显示；2999ms 仍显示、3000ms 隐藏；点击声音按钮不隐藏且完整重计时；选集打开期间暂停收起、关闭后重计时；指针按住期间不收起、释放后重计时；键盘显示并保持控件；滑动合成 click 被抑制、抑制窗口结束后可再次点按；卸载清理定时器。

脚本首次因 Node 22 navigator 为只读属性而未启动；去掉该环境赋值后，上述交互断言全部通过。此为验证环境修正，没有修改产品实现。

## 尚未覆盖

未在真实 Telegram iOS/Android WebView 或真实移动浏览器执行人工回归。DOM 验证不代表真机触控、真实 Radix 弹层或媒体播放验收。可重复真机场景见 task.md。

## 提交范围

仅播放器、对应 Frontend 交互规范及本任务目录。原有 drama-mvp-search-latest 任务记录、.claude、.mcp.json、template hashes 和 payment-create-failure-p0 等工作区内容全部排除。按用户“提交上去”授权提交并推送当前功能分支，不合并 dev/main。
