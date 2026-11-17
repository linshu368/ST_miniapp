# 执行清单

- [x] 阅读 Frontend 规范并核实当前实现、工作区与用户确认范围。
- [x] 调整画面点击与控件操作的捕获分工，复用当前显隐状态及计时器（1 个产品文件）。
- [x] 同步 pages-components-and-ui.md 短剧交互约束。
- [x] Frontend typecheck、436 项既有测试、lint、build 通过；使用真实组件的 React DOM 验证显隐及计时/选集状态/拖动状态/键盘/滑动抑制，详见 verification.md。
- [x] 复核最终 diff 与提交范围；用户已在本会话授权提交，仅纳入本任务文件，既有未提交内容不混入。

## 验证命令

```sh
pnpm --filter @miniapp/frontend typecheck
pnpm --filter @miniapp/frontend test
pnpm --filter @miniapp/frontend lint
pnpm --filter @miniapp/frontend build
```

## 人工场景

点击两次显隐交替；显示后 3 秒自动收起；按钮点击保持显示并延长计时；弹层、拖动和键盘阻止自动收起；滑动合成 click 被抑制；错误与加载提示不受控件显隐影响。

## 恢复与风险

仅本地 UI 状态变更，无契约、数据或部署顺序变化；回滚本次播放器和规范 diff 即可恢复原交互。真实 Telegram WebView 如无法操作，必须明确记录未验证。
