# 实现摘要

## 已完成

- 扩展统一移动性能策略，为 Android/iOS/unknown 增加图片广场首批、批次、加载边界、图片规格和视频激活边界。
- `/create` 首屏由一次挂载全部 Feed 改为有界渐进挂载；本地已有项目先展示完再请求下一页，返回快照继续保留全量缓存挂载以保护锚点恢复。
- Feed 图片和视频 poster 使用有限 Supabase transformation/srcset；外链不改写，转换失败回退原图，最终失败显示稳定占位。
- `/create` 与 Studio 接入真实图片/poster critical visual；数据 ready、媒体可见和生成完成继续分开。
- Studio 生成图使用有限响应式规格，但下载、分享、角色封面和视频参考继续使用原 artifact URL。
- Studio 历史视频仅在接近视口或用户播放意图时绑定 MP4；激活后保留原生 controls、playsInline、metadata preload 和全部编辑/下载/分享/重生成能力，不因滚动释放已激活视频。
- `/creation` 在首屏工作完成且网络门禁允许时预热默认 Feed，并在明确触摸/焦点意图时预取路由和同一 Query cache。

## 保留的业务边界

- 未改 Backend/shared/数据库、接口页大小、排序、计费、生成状态机、轮询终态、视频 Range 或签名。
- 未截断/分页 Studio 历史，未增加全局单播放器互斥，避免破坏历史完整性和用户播放进度。
- 未新增依赖、provider、store 或第二套缓存。

## 发布后事项

- 按 release、`tg_platform=android|ios` 分别验证 `/create` 和 Studio navigation/critical visual P95 `<3s`。
- 每平台每页面至少 100 有效样本，连续两个完整窗口才认定稳定；低样本继续标注待验证。
- 视频 metadata/首帧和完整生成耗时独立观察，不并入页面加载 P95。
