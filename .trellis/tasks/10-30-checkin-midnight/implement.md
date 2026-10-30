# 执行与验证
1. shared wallet工具及既有contracts测试：UTC16:00、23:59:59.999、月底/年末、运行时区无关。
2. 后端状态使用helper；新migration只替换当前RPC时间逻辑。
3. 个人中心提示、payment hook单次到期刷新，扩展已有fixture及@profile场景。
4. 复用scripts/test-vip-billing-migrations.sh及原SQL scenarios：同日拒绝、昨日不足24h仍可领、next_claim_at、VIP金额、并发只入账一次、migration重放。
5. shared tests、wallet/VIP backend tests、frontend profile hooks tests、workspace typecheck、@profile移动验收、frontend build、迁移/legacy静态检查。
6. 同步README/架构/签到时间规范，记录证据及未执行远端迁移，最终人工审阅后，仅提交本任务文件，先dev验收，再只发布本功能到main；远端迁移用现有workflow，逐环境核对。
