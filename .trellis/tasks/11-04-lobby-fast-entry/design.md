# 复用与边界

复用 useLobbyRecommendation、lobby-return/roleplay-navigation、React Query、已有角色摘要投影、批次仓库CAS与用户锁、评分job的专用连接和advisory lock、既有Playwright场景。热点恢复先读有效批次，生成前在锁内复查；缓存按用户隔离，下架/不可见必须剔除。小屏首屏不主动请求全量目录；公开兜底固定本次浏览，分页/搜索按需，旧版契约兼容。
评分成功标记归 miniapp_features.lobby_ranking_refresh_state，一行存算法/参数指纹和上次成功完成时间。唯一写方是评分job，与分数同一事务提交；空或失败不破坏旧分数，配置变化允许重新计算。无用户信息或跨schema FK；随大厅评分功能存续，RLS仅服务访问。旧行无需回填，新应用前先部署增量迁移；回退应用保留表。
使用既有请求超时和幂等，评分锁内判断新鲜度、周期检查到期。拒绝增加队列、Redis或第二套评分。恢复缓存缺失走正常加载；失败保留可用顺序。先测基线再比较，不在用户浏览中重排。
