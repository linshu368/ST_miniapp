# 执行与验证

1. Shared 可选配置 schema、v3 编译与严格校验；原文坐标安全兼容解析、1+有效选项与同配置诊断。
2. Admin 同页恢复配置编辑，复用 Workbench 往返/脏状态/预览/历史；Backend 诊断传入绑定配置。
3. 前向迁移同步 source/artifact validator 与身份绑定，保持 owner/ACL/search_path。
4. 既有 Shared/renderer/Admin 回归测试，pnpm -r typecheck，受影响应用 build，git diff --check、迁移命名与本地 SQL 验证。
5. README/ARCHITECTURE/spec 发布顺序、人工 TEST（单选项点击、EOF/围栏组合、只读权限、环境切换、保存发布回滚）与未执行线上边界。
