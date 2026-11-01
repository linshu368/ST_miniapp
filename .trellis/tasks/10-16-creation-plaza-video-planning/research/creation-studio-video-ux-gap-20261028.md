# 创作页图片/视频联动缺口审计（2026-10-28）

## 范围与证据

- 用户提供的图 1 只作为创作输入卡顶部「图片 / 视频」分段切换的布局参考。
- 用户提供的图 2 只作为视频设置 Sheet 的信息结构参考。任务既有 D9 已确认 Venice 视频不支持提示词优化，因此图中的「自动优化提示词」不进入视频设置。
- 对照源码：
  - `packages/frontend/src/app/(main)/create/studio/[conversationId]/page.tsx`
  - `packages/frontend/src/components/image-plaza/studio-artifact-card.tsx`
  - `packages/frontend/src/components/image-plaza/studio-video-card.tsx`
  - `packages/frontend/src/components/image-plaza/video-settings-dialog.tsx`
  - `packages/frontend/src/components/image-plaza/video-model-sheet.tsx`
  - `packages/frontend/src/app/(main)/create/work/[workId]/page.tsx`
  - `packages/backend/src/features/image-plaza/repository.ts`
  - `packages/backend/src/features/image-plaza/video-repository.ts`
  - `packages/shared/src/api/image-plaza.ts`
  - `packages/shared/src/api/video-plaza.ts`

## 当前实现与缺口

| 用户要求                          | 当前事实                                                                                                                      | 需要修正                                                                                                                                                            |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 输入框顶部图片/视频切换           | Studio 输入卡顶部已有本地 `mediaMode` 分段按钮，但仅在 `videoModels.length > 0` 时渲染                                        | 固化位置、可用/禁用语义、窄屏与软键盘验收；不能因切换丢失两种模式各自草稿和设置                                                                                     |
| 视频设置、模型、报价              | 已有视频时长/分辨率/画幅/声音 Sheet、视频模型 Sheet 和 debounce 报价                                                          | 参数顺序及产品集合按 5/10 秒、16:9/9:16/1:1、720P/1080P 收口；模型只读 Admin 已发布视频目录；默认 Wan 3.0 Pro；模型/参数/有效参考图变化后报价必须联动且拒绝过期响应 |
| 不支持参考图时保留已上传图片      | `selectVideoModel` 当前会调用 `clearReference()` 并提示“已移除图片”                                                           | 改为“保留但暂不参与本次视频提交”：禁用新增上传、提示一次、quote/submit 传 `reference_artifact_id=null`；切回支持图片的模型后自动恢复，不重新上传                    |
| 图片/视频详情用同款的默认类型     | Backend 会按来源作品 `media_type` 解析不同 snapshot；Frontend 通过 snapshot shape 推断视频                                    | 把来源媒体类型写成明确验收和初始化优先级，避免后续重构退化；图片来源固定初始 image，视频来源固定初始 video，新建会话默认 image                                      |
| 视频生成后的编辑/下载/分享/重生成 | `StudioVideoCard` 已有 5 个操作，其中包含这 4 项                                                                              | 补足行为验收：编辑只回填不提交；重生成重新报价且防重复；分享/下载校验归属；失败和 pending 有明确反馈                                                                |
| 图片结果作为视频参考图            | `StudioArtifactCard` 没有入口；视频 attempt 只接受 `image_plaza_reference_assets.id`，而生成结果是 `image_plaza_artifacts.id` | 增加“用这张图生成视频”；由 Backend/DB 幂等地把用户自有 ready 图片 artifact 映射成 reference asset，不让浏览器下载后再上传                                           |

## 最小充分方案

### 1. Composer 状态

- 保留同一会话和现有 `mediaMode`，图片、视频分别保有自己的 prompt、模型和设置。
- 增加“参考图已保留但当前模型不使用”的派生状态，不增加第二份 reference 真相：
  - `retainedReferenceId`：用户已经上传/选择的 reference asset；
  - `activeVideoReferenceId`：仅当当前视频模型 `image_input !== 'none'` 时等于 retained，否则为 null。
- quote 和 submit 只使用 active 值；参考图 chip 仍显示 retained 值并标记“当前模型不支持，已保留”。用户显式点删除才真正清空。

### 2. 图片结果转视频

- 新增鉴权路由 `POST /api/image-plaza/image-artifacts/:id/video-reference`，返回既有 `ImagePlazaArtifact` 形状的 reference asset。
- 新增 forward migration（不得改写已执行历史 migration）：
  - `image_plaza_reference_assets.source_image_artifact_id UUID NULL`，外键到 `image_plaza_artifacts(id) ON DELETE RESTRICT`；
  - 对非空值建唯一索引；
  - service-role-only RPC 原子校验 artifact 所属 attempt 为当前用户且 ready，复制其 storage metadata/path 创建 reference row，冲突时返回既有 row。
- 该方案复用同一个私有 Storage 对象，不复制媒体字节；FK 阻止源 artifact 在 reference 存续时被删除。清理 reference row 时若 `source_image_artifact_id` 非空，不得删除共享对象。
- 路由重复点击、请求超时后重试和并发点击都返回同一 reference asset；不产生生成、计费或分享副作用。
- Frontend 成功后切到 video，优先保留当前支持图片的视频模型；否则选择已启用的 Wan 3.0 Pro，再否则选择第一个支持图片的视频模型。没有任何支持图片的模型时保持 image 并提示，不创建无用 reference。

### 3. 默认值与用同款优先级

1. 图片/视频作品详情「用同款」以来源作品 `media_type` 为最高优先级，并恢复其 snapshot。
2. 图片结果「用这张图生成视频」显式以 video 为最高优先级，并把该图设为 retained reference；不覆盖用户已有 video prompt。
3. 普通新建会话默认 image。
4. video 默认模型为 Admin 已发布且 enabled 的 Wan 3.0 Pro；若目录异常或该模型下架，回退已发布 default，再回退首个 enabled 模型并提示。

## 可靠性与恢复

- 前端模型切换不做网络写；参考图保留/启用状态可逆。
- 图片转 reference RPC 依唯一索引和单事务幂等；未知结果允许安全重试。
- 转 reference 失败时保持图片模式、原图片和草稿不变；不自动切换或提交视频。
- 视频 model/参数变化产生新的 quote key；旧 quote 响应不得覆盖当前价格，提交前仍由服务端校验 quote 与参数完全一致。
- 不新增通用媒体状态框架、客户端 Blob 搬运或第二套上传链路。

## 验证重点

- 新建、图片同款、视频同款、图片转视频四种入口的初始模式和快照。
- 支持图 → 不支持图 → 支持图：reference id 不变，只改变 active 状态；不重复上传。
- 视频设置的全部允许组合、禁用项、报价变化和过期 quote 拒绝。
- 图片转 reference 的越权、非 ready、重复、并发和结果未知重试。
- 视频 ready 卡四项操作的 loading/error/double-click；Telegram 下载降级。
- 320/375/390px、软键盘、safe area、Telegram iOS/Android；扩展 `packages/ui-tests` 的现有 `@image` 流程，不另建一次性 mock 系统。
