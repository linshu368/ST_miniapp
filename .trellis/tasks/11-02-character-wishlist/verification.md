# 本地交付验证 2026-11-02

范围：codex/character-wishlist，基于origin/dev cee0de143。仅本地开发；未commit/push、未应用远端迁移、未触碰其他工作区。

已完成大厅与空态入口、创作数据/我的创作空态入口、公开匿名/私密、支持/取消、撤回、已有卡/新创作回应、站内通知跳转。来源仅在本地草稿元信息，封面往返保留；角色发布成功而关联失败独立恢复，心愿已撤回也能回自己的作品。

## 验证

- pnpm -r typecheck：全部包通过。
- shared Vitest：235通过。
- frontend Vitest：734通过。
- 后端creator/wishes/notifications定向回归：52通过。
- 前端生产构建成功；既有img/Browserslist提示无新增构建错误。backend无build脚本，类型检查通过。
- 现有隔离PG17脚本通过：原创作/会话、5项analytics、心愿权限/RLS/通知事务/幂等/撤回/公开资格。6路并发创建/支持/关联最终各1条、2个收件通知。
- fixture协议10项通过；@wishes 5流程×390/320共10项通过（受文案热更新影响的用例已复跑），覆盖公开成功关联失败只重试回应及撤回心愿回我的创作。
- 定向lint无错误，既有img警告；git diff --check通过。
- 人工IAB预览3200，演示数据来自本地3201。用户可直接查看。

## 复查修复

1. 心愿通知不再因VIP今天到期覆盖标题。
2. 心愿被撤回导致关联失败时保留“角色已发布”与查看我的角色入口。
3. 作品关联资格采用有效已公开版本，不误挡审核未过的新草稿。

## 边界

真实生产未迁移、未通知真实用户；本地UI不代表Telegram原生键盘或线上Android/iOS P95。私密平台访问当前通过受限service_role读取，未新建运营管理页。未来部署先迁移再后端前端。

复用：ST_UI_APP_PORT=3200 pnpm preview:ui；ST_UI_TEST_APP_PORT=3210 pnpm test:ui --grep @wishes；bash scripts/test-creator-characters-local.sh。

## 本地反馈精修

- 排序由原生select换为底部单选Sheet，选中勾选、点后关闭，同选项不请求；排序加载保留同用户同scope的旧列表，范围切换不复用私密数据。
- 演示数据让较早心愿具有最高想玩人数，真实区分两个排序；fixture增加同时间ID降序兜底。
- 页面注明所有心愿均匿名，公开选项标“匿名公开”，明确不展示昵称头像；输入示例按用户指定原句修改。
- frontend typecheck及定向lint通过；新增排序两尺寸与匿名公开失败重试两尺寸共4项通过，复用已有creator.spec.ts。3200本地预览已重启加载最新虚构数据，未提交或上线。

## 发布前复核

用户已确认本地效果并授权上线。2026-11-02远端dev仍为cee0de14、main为35d5632e；本批从dev开发，正式分支只摘取心愿变更并保留main已上线启动拆分及其他上游行为。

- 本轮全包typecheck通过。后端4文件59项回归通过；fresh PG17原创作、心愿权限/通知原子性/幂等和5项创作统计通过。
- 生产只读结构检查：character_creations、can_discover_character(uuid)、通知4列、原kind/shape约束和唯一business_key索引齐全，新心愿表不存在。
- 生产构建、手机复验和远端CI/迁移/部署结果在发布记录继续补充；不将本地模拟声称为真实线上用户验证。

本轮生产构建完成；390/320手机12项（@wishes与@wish-sort）全部通过，无新增修复。线上迁移与CI仍在执行前状态。

## 最终口径变更：仅匿名公开

用户在上线前取消私密心愿。前述私密读隔离仅是旧版本验证记录；最终版本只支持public，提交前提示所有人可见且不展示昵称头像。API和DB双重拒绝private，仍保留本人撤回和我的心愿。27项shared定向、60项backend、fresh PG17和5项analytics通过。最终迁移SHA256：e65e46e73b71d969830b5003fb14e1b069657f9ca7359228495cdd90fe065b8e。
