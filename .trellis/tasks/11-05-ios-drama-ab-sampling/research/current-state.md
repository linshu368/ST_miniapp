# 研究证据 2026-11-05

本地基线 dev/e2fa9226；初始工作树干净。本轮仅读应用代码、文档与安装包，新增规划文件。

- `packages/frontend/src/components/nav/bottom-nav-shell.tsx`：实际放映/watch、剧场/dramas；与旧模块文档首页/AI短剧描述存在差异。以代码为本地事实，线上需核验。
- `packages/frontend/src/components/drama/drama-home.tsx`：列表顺序、记忆activeId、home switch。
- `packages/frontend/src/components/drama/drama-home-frame.tsx`：顶部追剧/搜索。
- `packages/frontend/src/app/(main)/dramas/page.tsx`：精选/最新/分类/搜索、接着看、已收藏/最近看过、DramaLink共享cover计时。
- `packages/frontend/src/app/(main)/dramas/[id]/page.tsx`：上一部/下一部基于保存队列，优先本设备未完成集。
- `packages/frontend/src/components/drama/drama-player.tsx`：resume、集号、手势、时间显示、episode当前集无新起播、尾部3秒预取、观看有效性、seek回调。
- `packages/frontend/src/components/drama/drama-progress.tsx`、`use-drama-scrub.ts`：48px触区、onBeforeCommit、拖前wasPlaying、松手提交、500ms echo去重；没有缓冲区可视条。
- `packages/frontend/src/lib/perf/drama-seek.ts`：目标缓冲资格在提交时读buffered，forward判定，真实目标帧/播放恢复，60秒诊断截止。
- `packages/frontend/src/lib/perf/drama-observer.ts`：seek_buffered、seek_direction、resume_expected和final指标，与startup分离。
- `packages/backend/src/features/drama/stream.ts`：按账号固定组别、独立入组哈希、指定单集白名单、30部置顶。
- `docs/drama-stream-ab.md`：窗口冻结、原组别/实际provider、回退、不能平均各窗口P95。
- `packages/ui-tests/README.md`、`tests/drama.spec.ts`（路径发现，测试未执行）：已有@drama验收入口；模拟媒体不代表真机。
- `/Users/qj/Downloads/miniapp-ios-setup/README.md`、`common.sh`、`01-install.command`、`03-check.command`、`appium-config.json`：独立Node/Appium/XCUITest，服务127.0.0.1:4723，尚无采样脚本。此轮未检查安装执行结果或设备连接。

官方参考核对：

- https://appium.github.io/appium-xcuitest-driver/latest/reference/execute-methods/ ：原生tap、dragFromToForDuration、截图和viewport。实现时按本机固定版本验证，不照搬latest特有能力。
- https://appium.github.io/appium-xcuitest-driver/latest/reference/settings/ ：视频持续运行可能影响idle等待，不能默认无限等待或盲目禁用idle检查。

未知项：线上release、当前环境manifest及30个准确标题/集号、A/B受控账号、设备/iOS/WDA实际状态、accessibility是否能读到Web内容、重复播放时未缓冲seek命中率。均为预演门槛，不推断为已完成。

收尾观察到其他工作并发修改详情页、drama-home.tsx、drama-media-source.ts，内容为非Apple平台HLS预热/来源选择。此轮仅查看差异，未修改、回退或暂存。上述入口与iOS手势结论未改变；正式采样仍需冻结实际部署版本。
