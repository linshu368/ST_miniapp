# 生产基线与复用记录

## 观测窗口

2026-11-02 18:00 至 2026-11-03 16:00 Asia/Shanghai，production，全部 release，`engineering_v1`。

## 页面基线

- `st_page_critical_visual`，`/characters`，fetch+spa：Android P95 5906.97ms，N=75；iOS P95 2538ms，N=6（低样本）。
- `st_page_ready`，`/characters`，fetch+spa：Android P95 4791.06ms，N=27；iOS P95 1803ms，N=3（低样本）。
- cache+spa critical visual：Android 10380.05ms，N=12；iOS 5608.6ms，N=5，均为低样本但提示缓存重校准/图片竞争风险。

## 接口基线

- Sentry production `GET /api/characters` http.server P95 214.22ms，count=370；未按 `sort` 拆分。
- 浏览器使用同源 `GET /api/lobby-characters?sort=...`，该代理在现有聚合中没有独立可见基线；代理有5秒上游超时。

## 复用结论

- `CharacterGallery` 已有缓存秒开、平台预算、首图 high priority、关键视觉埋点、渐进挂载和返回快照，全部复用。
- shared 默认 recommended 仍被 `/chats` 摘要查询和后端非法参数回退使用，不全局修改。
- 推荐模式额外等待 `recommendation.ready`；fresh entry 默认 latest 可直接移除这条首屏依赖。
- 初始6张卡超过两列首屏的必要数量；减至4张仍覆盖两行，并减少 `CharacterCard`/social bar/图片工作。
