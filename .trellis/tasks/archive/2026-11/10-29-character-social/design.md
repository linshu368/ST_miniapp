# 方案

## 已复用调研

CharacterCard / CharacterDetailSheet / ChatTopBar / FavoriteButton保留并扩展；favorites.ts继续唯一收藏状态；角色社交独立React Query keys。Sheet提供可访问弹层；useMemoryDraft承载会话内草稿。短剧评论已有分页/幂等写入可参考，但不把角色归入drama域、不建立跨业务通用社交框架。已有fixtures/server.ts和roleplay.spec.ts扩展。

## 契约（各端依此并行）

新增shared api/character-social.ts并export：
CharacterSocial {liked:boolean,like_count:number,favorite_count:number,comment_count:number}
CharacterComment {id:string,author:string,is_mine:boolean,body:string,created_at:string}
GetCharacterSocialData {social:CharacterSocial}
GetCharacterSocialsData {socials:Array<CharacterSocial & {character_id:string}>}
GetCharacterCommentsData {comments:CharacterComment[],next_cursor:string|null}
CreateCharacterCommentSchema = strict {id:uuid,body:trimmed 1..500 plain text, control chars rejected}; CreateCharacterComment type
CreateCharacterCommentData {comment:CharacterComment}
SetCharacterLikeSchema = strict {liked:boolean}
ReportCharacterCommentSchema = strict {reason:enum(inappropriate,spam,other)}
GET /api/characters/social?ids=<comma-separated uuid,max40> 批量且去重
GET /api/characters/:id/social; PUT /api/characters/:id/like {liked}
GET/POST /api/characters/:id/comments [cursor]; DELETE /api/characters/:id/comments/:commentId
POST /api/characters/:id/comments/:commentId/report {reason} -> {reported:true}
原收藏API不变，收藏变更时客户端同步count并重新获取社交事实。

## 归属和不变量

miniapp_features角色互动关系/公开评论/举报随功能生命周期，区别experience私聊生成内容；引用app_core用户和角色。既有收藏是唯一来源，不复制收藏关系。后端鉴权确认user，不接受客户端user_id。有效上架角色才允许读写，批量输出不暴露其他用户身份。角色评论公开匿名映射不泄露Telegram资料；删除仅作者，举报唯一用户/评论。迁移只新增角色表/RPC并按service_role限定，RLS防御；schema具体对象、索引、FK和DDL验证由后端研究记录补齐。

## 可靠性与最小方案

读取明确8s超时，无无限重试。点赞desired-state、唯一用户角色关系；评论UUID幂等并检测不同正文冲突；限流在DB写事务内；删除重复安全。列表40条批量，首屏后加载，不每卡新HTTP；页20条游标。乐观写只回滚对应字段/角色，pending防重复。失败不阻断主聊天和浏览；未知计数显示占位而非0。仅元信息日志，无评论/私聊正文。无跨设备草稿、通知、关注、复杂评论回复或推荐算法调整。无需计费/补偿；跨用户登录清理前端私有缓存。

## 演进恢复

当前工作目录包含已认可未发布滚动改动，保留所有现有diff；本轮本地不commit/push，不切换或合并上游。正式集成时需对齐最新dev并隔离本轮文件。发布顺序迁移→后端→前端，线上迁移单独执行；旧收藏不迁移不重写。回退前后端可保留新增表，停写后恢复旧UI，数据保留供forward-fix。
