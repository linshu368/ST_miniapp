# 补充周报 Android 与 iOS 性能对比

## 目标

在既有 2026-10-26 至 2026-11-01 production 性能周报中增加 Android 与 iOS 对比维度，保持原 48 小时重叠整窗和缺失值规则。

## 要求

- 优先使用生产事件的 `tg_platform`，区分 Telegram Android、Android X 与 iOS；Android 汇总需说明是否合并 `android_x`。
- 至少比较页面导航、首次加载，并在可用时补充 Grafana 页面成功率/ready、首字和完整回复。
- 每个数值附样本量或覆盖说明；无结果写“无可见样本”，不补零。
- 不将普通浏览器 OS、Sentry SDK platform 或未知平台误当 Telegram Android/iOS。

## 验收标准

- [x] 周报新增 Android/iOS 逐日对比表和平台差异结论。
- [x] 标明峰值、样本不平衡、低样本和平台字段上线覆盖。
- [x] 原周报数据与口径保持不变。
- [x] 完成校验并自动归档任务。
