# 本次发布

用户已于2026-10-27确认最终预览并授权上线。范围：短剧首页与剧场/追剧、播放手势与进度、点赞评论、五入口与角色旧入口适配、个人中心视觉；本地固定验收同步。不会携带其他人的未上线dev变更。

发布前远端：dev=4e04cbee6d4576ec39ad32b51c49a2b69cae4a79；main=a9881bac23b640915b220a97d9a0eacf029f0c95。两者树差异仅他人的ops/schema-split/postgrest-expose-media-plaza-prod.sql，发布分支从最新main保留其版本，只带本次功能commit；先合入dev，后晋升本次提交。

两位独立代理前后端审查无阻断。生产结构只读预检：drama_archive.dramas/app_core.users的id为uuid主键，service_role有schema USAGE和BYPASSRLS，PostgREST已暴露drama_archive；新增两表/RPC不存在。既有测试项目zoqelpfhurwehlvypryl在连接账号中返回Project not found，不把隔离PG17结果当远端test验证。

SQL只新增drama_archive.drama_likes/drama_comments及评论RPC，无旧行回填。已有隔离PG17验证覆盖RLS/授权收窄、并发限流、UUID幂等、删除墓碑和外键。通过仓库db-migrate工作流执行单文件20261027_drama_interactions.sql，精确引用本次受审查提交，不使用force_rerun。生产后再核对catalog权限和账本。顺序数据库→Backend→Frontend；回退应用保留互动数据，禁止自动DROP。

排除既有无关10-27-vip-checkin-upsell任务两份本地记录，不stage、不改写。无本轮真实支付/模型生成/用户评论写入测试。
