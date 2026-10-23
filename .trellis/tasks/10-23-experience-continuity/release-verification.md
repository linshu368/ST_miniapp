# 移动端上线验收记录

## 范围与源码

- 用户要求以前端移动端体验为准，不纳入PC布局扩展。
- 功能PR454已压缩合入dev（d328f55e）；其文件树与验证版本bddda66f完全相同（cdfd7260dcb8cc6f3b538a107ab87f21d7c9e213）。
- 相对原生产main80e6e6e6仅63个前端/规格/任务文件变化，无后端代码、生产变量或迁移差异。
- 本历史同步提交恢复main祖先关系，必须以merge commit合入dev，避免再压缩丢失祖先造成发布PR455的虚假冲突。产品文件不变。

## 验证通过

- 全包typecheck；前端47文件305项；shared16文件169项；同步线上告警回归2文件16项。
- frontend lint与cross-package imports、legacy-reference、migration filename守卫无error，仅既有5处img建议。
- 最终隔离生产构建exit0，613个源码与34个配置相关文件构建前后和副本SHA一致；此产物只用于验证，不上传为production prebuilt。
- 远端功能PR CI39902695283：Quality Gate及Docker Build均success；Vercel frontend与admin均READY。
- 390px和320px真实前端复验：固定发现栏、详情/续聊、返回来源、草稿离开恢复、回复长度与模块、历史菜单、影像历史及工作室布局。320px studio client/scrollWidth320、主按钮44px高且right295/bottom615在视口内。
- 分支预览实际bundle后端为stminiapp-development；真实测试环境角色与影像页面可读，工作室创建、模型Seedream V5 Pro、报价与画幅/分辨率设置已读通。未触发收费生成。
- 生产网站与production backend health在发布前HTTP200，原生产deployment dpl_5FXxsKXLS8cHeXCACBiUQn6ggb5X可作回滚锚点。

## 修复与独立审查

- 发现并修复多收藏请求同批结束时遗漏invalidate；增加真实MutationCache同时结束/最后请求失败两条回归，收藏8项通过。
- 角色/对话/草稿与影像分别独立复核，无剩余已知P1/P2阻塞。
- main既有出图展示计时、聊天首字/完整回复、主动取消操作及签到反馈、告警修复均保留。

## 已知环境限制

- PR临时后端创建被Railway新账号每日25服务上限阻止；自动审查模型接口HTTP402，未形成代码拒绝结论。未修改工作流、额度或密钥。
- 用户已明确授权本次管理员合并并继续发布。保留所有质量检查，不修改分支保护规则。
- 真实Telegram软键盘、下载与收费生成/计费未在本次浏览器里完成真机验收。最终部署后需核对Production构建API地址与移动端页面。
