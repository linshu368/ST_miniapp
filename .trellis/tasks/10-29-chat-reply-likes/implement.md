# 执行

1. 独立评审设计，确认体验及数据归属，start后再写产品代码。
2. Root定义shared契约与虚构fixture；数据库同伴实现迁移/隔离PG；后端同伴实现仓储/路由/定向测试；前端同伴接按钮和缓存/失败状态。
3. 复用现有chat验收加入回复点赞，验证点击目标、点亮/撤销、刷新、旧轮、失败、分支/重生成隔离。
4. 执行相关测试、所有消费者typecheck、两端build、限定lint、diff检查和独立最终复审；不重复与本次无关检查。
5. 更新module payload、README/ARCHITECTURE和本地验收记录，展示预览。只本地，不stage/commit/push/远端迁移。
