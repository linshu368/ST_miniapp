# 执行与验证

本聊天已先展示六项范围和影响解释，用户随后批准开始实现；本文件落实该范围，不新增产品取舍。状态门禁由task.py start记录。

1. shared API与计算helper→tracker/observer→Backend兼容接收→白名单/release→源JSON和文档；不修改视频控制。
2. 扩展既有telemetry-contract/drama-timing/observer/media/grafana/telemetry路由测试，无需新建测试文件。
3. 运行pnpm --filter @miniapp/backend exec prisma generate；pnpm --filter @miniapp/shared test；前端相关perf测试与Backend telemetry/drama tests；pnpm -r typecheck；pnpm --filter @miniapp/frontend lint/build；pnpm --filter @miniapp/admin build；pnpm lint:legacy；pnpm lint:migrations；Prettier和git diff --check。Backend无独立build脚本时记录使用typecheck；实际脚本先核对。
4. 检查逆序/缺失/0、home/detail与迟到事件、冷/站内/缓存、autoplay_blocked、后台/切换/手动重试、slow/final/network一次性、非法Faro配置回退、上传失败和diagnostic永不写库。
5. 本地验收系统可复用现有fixture与移动端入口，建议补短剧加载/换剧/后台/上报失败场景；本轮无UI变更，先用现有owner状态机回归，不新建独立临时mock体系。
6. 实际Cloud接通和Telegram媒体能力、生产开关/持久化停用均列为待发布验证，不用本地测试替代。
