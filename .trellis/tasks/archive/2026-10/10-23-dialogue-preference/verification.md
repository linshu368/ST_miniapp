# Verification

当前HEAD1341605c已经包含main#469的思考修复，本次diff不重复覆盖。仅新增通用运营UI目录及用户独立开关保存，不把marker/rules接入模型，不预设内容。

- Shared17files/176tests PASS；Backend99files/843tests PASS；Frontend50files/374tests PASS；Admin13files/121tests PASS。
- 全5个consumer typecheck PASS。Prisma generate PASS。
- 最终源码的frontend生产构建与Adminbuild均PASS，包含字体、开关拇指和手机预览样式调整。回滚写入互斥P2已修复并经独立只读复核。
- 构建恢复记录：隔离Next构建目录使用外部node_modules链接时，本地frontend源码和依赖出现清理异常。停止该路径，先保全全部改动，再以HEAD恢复原文件、以核验副本恢复3个本次frontend文件；3文件SHA256逐一相等，无跟踪文件删除。pnpm --frozen-lockfile恢复依赖，Prisma重新生成；在真实完整checkout重跑上述1514项测试、5包typecheck、frontend/Admin生产构建均PASS。没有锁文件或依赖版本变动，不再使用该隔离薄复制构建。
- lint:migrations、lint:legacy、lint:imports PASS；变更文件lint/format/diffcheck PASS。
- PG17Docker无网络/只读代码挂载：空目录默认、strictcatalog字段/数量/唯一、UTF16界限、空字符串、ECMAScript FEFF/NBSP trim、旧managedkey/validator/CHECK验证状态/ACL、service_role invoker路径、64合并上限、原字段保留、8路同用户不同键原子保存、幂等不覆盖运营数据，全PASS。首轮抓出空glyph误计数，已修复并实测锁定。
- 独立review无P0/P1；P2历史回滚与save/publish并发已修复，同步写锁覆盖确认窗及网络等待，取消/失败finally释放。
- 手机真实组件示例API390x844以及320x500：多项同时开启，单项模拟保存失败回滚且其它项不丢，重试成功；documentWidth305<=viewport320，收起入口top87/bottom127和发送top462/bottom494均在500高度内。没有真实手机/模型/钱包调用。
- 正式Admin域名已readonly确认projectprj_qFA3muYfDxjvC6xiLBPr4Ke295hK/team_5enSiAZSqTPMaNX5ehTSGv1J，当前main134已READY；门户尚在登录页，未读取凭证。
- TESTzoq与Productionwb两环境只读shape检查均符合前置，尚未执行远端迁移；后续workflow执行与checksum单独记录。
