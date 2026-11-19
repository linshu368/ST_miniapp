# 标签筛选分组修订调研（2026-10-28）

## 需求证据

- 用户给出的移动端参考图要求：标签横向滚动，但「全部风格」固定在右侧；点击后打开底部筛选面板。
- 面板按「玩法 / 体位 / 场景 / 性取向 / 模型」等运营分组展示；默认全部标签处于展示状态，点击单项取消，再次点击恢复。
- 图片与视频共用同一标签目录；标签点击后的作品匹配仍以配置项 `label` 对 `snapshot.prompt_zh` 做字面模糊匹配。
- Admin 必须能配置分组、组顺序、标签顺序与 chip/grid 布局；不再配置图片/视频适用范围。

## 现状与复用调研

| 范围     | 已检索对象                                                                                                               | 决策                                                                                                                        |
| -------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Frontend | `create/page.tsx`、`StyleFilterSheet`、`Sheet`、`useImagePlazaFeedQuery`、`useImagePlazaTagCountsQuery`、返回状态 helper | 复用现有 React Query、Sheet、多标签状态与返回恢复；调整布局和选中语义，不新增状态库或请求层。                               |
| Shared   | `ImagePlazaTagConfigSchema`、`ImagePlazaFeedQuerySchema`、公开 feed/config tag DTO                                       | 扩展现有 tag 项的分组字段；保留公开 `media_types` 并统一返回 image+video 作为旧客户端兼容字段，新客户端不再按它过滤。       |
| Backend  | feed route、`publicImagePlazaFeedTags`、`listWorks`、`feedFilter`、`countWorksByTags`                                    | 复用目录校验、分页、游标和 PostgREST ILIKE 转义；删除 `works.tags` 的筛选/计数路径，所有媒体统一按 `prompt_zh` label 匹配。 |
| Admin    | `ImagePlazaTagsEditor`、`EditableImagePlazaTagConfigSchema`、配置草稿/发布/回滚链路                                      | 扩展现有编辑器，不新增配置 key 或第二套发布流程。                                                                           |
| Database | `admin.validate_image_plaza_tags(jsonb)`、managed config validator                                                       | 只用新 forward migration 替换既有 validator；不改历史 migration、不改表、不读写业务行。                                     |

未复用/拒绝：不新增标签表、搜索服务、同义词框架、前端直连数据库、专用标签 RPC 或另一份运行时配置；这些都超过当前“运营目录 + prompt_zh 字面匹配”的需求。

## 可靠性与容量

- feed 和计数沿用 10 秒显式超时；只读查询不自动重试，失败继续走现有错误/空态，避免重试放大扫描。
- 标签计数由单个 HTTP 请求触发，服务端按有限并发分批统计，避免最多 80 个标签同时打满连接；结果继续缓存 60 秒。
- 标签筛选在数据库分页前完成；多标签为 OR，再与 search/media 条件取交集。游标 filter hash 纳入排序后的标签 label，切换筛选后旧游标明确失效。
- 配置发布写入、审计、回滚继续复用现有 Admin RPC；本改动没有新写入、幂等键、事务、补偿、队列或限流需求。
- 标签 ILIKE 仍可能扫描 JSONB 文本；先用 TEST 记录响应时间，不凭假设新增索引。连续超时或 feed p95 明显退化时停止发布。
- 日志只保留现有 `hasTag`、数量、媒体和耗时，不记录标签 label、prompt 或响应正文。

## 兼容、发布与恢复

- 旧发布配置缺少分组字段时统一归入默认「风格」组；历史 `media_types` 可继续通过数据库校验，但应用忽略它。
- 新 Backend 对公开 tag 仍返回 `media_types: ['image', 'video']`，避免旧 Frontend 在混部窗口访问缺失字段；新 Frontend 不再按媒体裁剪标签。
- 发布顺序：TEST 执行新 validator migration并验证草稿保存/发布/回滚 → Backend → Admin/Frontend → 移动端验收；Production 独立审批。
- 应用可回滚到兼容版本；数据库 validator 扩展无需回滚。若新配置已发布，旧 Backend 会忽略未知分组字段并继续读取基础 tag 字段；缺陷采用 forward-fix。

## 可验证性

- Shared：旧配置默认分组、新分组字段/布局、重复 ID/分组元数据冲突、最多 80 个查询标签。
- Backend：单/多标签均生成 `prompt_zh ILIKE`，不调用 `overlaps/contains(tags)`；图片/视频一致；计数同样按 label；搜索、媒体、游标组合不串页。
- Admin：旧草稿可编辑，新标签继承当前分组，不再出现媒体选择，非法分组无法保存。
- Frontend：窄屏下滚动区不推动固定按钮；默认全选、取消/恢复、全部展示、分组 chip/grid、计数失败和空目录均可用。
- Migration：仅替换 validator，验证旧 payload、新 payload、非法布局/分组/重复 ID 拒绝，ACL 不扩大；不执行远程 SQL。
