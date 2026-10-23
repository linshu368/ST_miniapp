# 当前大厅返回链路调研

## 1. 检索范围

- 组件：`CharacterGallery`、`CharacterCard`、`CharacterDetailSheet`、`ChatTopBar`、`BottomNav`。
- hooks/helpers：`useCharactersQuery`、`characterKeys`、`chatEntryPath`、`useTelegramBackButton`、Next `useRouter`。
- contracts：`GetCharactersData`、`LobbySort`；当前角色列表契约没有 cursor/page/limit。
- features/repositories/数据库函数：本需求是前端导航现场恢复，不需要 backend feature、repository 或数据库函数；已确认 `/api/characters` 当前一次返回完整 enabled 列表。
- 既有恢复能力：未发现大厅 `scrollRestoration`、滚动快照或列表条件 store；支付 `sessionStorage` 只服务支付回流，不能复用其业务状态。

## 2. 当前事实

1. 大厅 `/` 挂载 `CharacterGallery`；`sort`、`query`、详情 `previewId` 均为组件本地 state，离开路由后丢失。
2. 点击卡片先开详情 Sheet，点击“进入角色”后 `router.push('/chat/:characterId')`。
3. 聊天页顶部按钮和 Telegram 返回键都执行 `router.push('/')`，不是 history back；系统手势则可能走浏览器 history。
4. `useCharactersQuery(sort)` 的 query key 已隔离推荐/最新，并以 React Query + 24h localStorage 快照保存角色数组；但 `refetchOnMount: 'always'` 会在大厅重新挂载时立即对账，可能改变顺序。
5. 角色卡图片容器有固定 `3:4` 比例，图片异步完成通常不改变卡片高度；`CharacterCard` 已预留 `onImageSettled` 回调，可用于必要的锚点二次校准。
6. 当前列表不是 API 分页，也不是 `useInfiniteQuery`。因此“分页恢复”不能通过新增后端分页伪造；正确做法是让恢复协议记录已加载集合，并把“缓存准备完成后定位”作为门禁，使机制能覆盖深列表以及后续分页实现。

## 3. 复用结论

- **复用 React Query**：它继续拥有角色数组和收藏状态，不复制完整列表快照。
- **复用现有 sort query key 与本地角色缓存**：返回时优先使用内存 cache，恢复挂载跳过一次强制 refetch，避免新响应覆盖旧顺序；后续正常进入仍按现有规则对账。
- **复用 `onImageSettled`**：仅锚点附近布局发生变化时有限二次校准，不引入 ResizeObserver 通用框架。
- **扩展现有导航 helper/调用点**：所有聊天退出路径统一到“返回大厅”动作；不引入新路由、全局 store 或后端 token。
- **不复用支付存储 helper**：支付 key、TTL 和敏感边界不同，强行泛化会扩大影响面。

## 4. 差异与风险

- 需求文件描述“分页/无限滚动”，但当前 checkout 的大厅接口一次返回完整列表。规划按当前事实设计，同时明确分页兼容门禁，不把推断写成现状。
- 浏览器原生 history scroll restoration 与 Next App Router 生命周期不够可控，且无法恢复组件本地筛选条件，因此不能只依赖 `router.back()`。
- 仅保存 `scrollY` 在排序变化、卡片下架或响应式列数变化时会偏移；必须保存目标卡与相邻卡 ID、进入时卡片 `getBoundingClientRect().top` 作为锚点。
