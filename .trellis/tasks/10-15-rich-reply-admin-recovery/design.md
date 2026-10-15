# 最小技术设计

复用：api/text-postprocess source/artifact schema、compile/apply、rich-reply 与 legacy fallback、Admin Workbench/Preview worker、既有专用 RPC、SQL validator、nonce transport。扩展现有链路，不增加 API/依赖/数据库表/配置状态源。
source 增加可选 rich_reply 恢复配置；存在时编译为带 recovery 的协议 v3，缺省仍 v2。配置以完整有界对象保存：模块 EOF、标题副标题与降级文案、括号对/标签别名、围栏开关。括号/别名先归一化并维护 UTF-16 原文边界映射，slot 仍使用原文坐标；仅覆盖协议模块的外围围栏被消费，不松绑 Markdown 安全检查。
可靠性：纯解析有输入/模块/选项/节点限制，Worker 既有硬超时；无外部调用/新增重试/网络/补偿。保存发布沿用 CAS、request_id 幂等和事务。诊断读取同一 artifact 配置，兼容恢复不能误标 exact。配置仅生成可信文字/动作，不把模型 HTML 当执行代码。
数据库：仅替换 admin 域两个既有 validator，不新增对象。权威写入仍是 Backend 专用 RPC；配置生命周期是草稿→发布不可变快照，运行时消费者 Shared/renderer/Backend；依赖既有 admin/app_core 发布事务，无数据搬迁或 RLS/grant 扩权。
演进：先逐环境迁移（单文件），再部署 Backend/Admin/Frontend，最后保存发布配置。旧快照无新字段保留旧语义；回滚发布旧 source 生成新版本，不改历史。停止条件为保存/发布失败、预览与消费者不一致或普通代码误识别。应用可回滚前先回滚至不含新配置版本；数据库校验保留兼容扩展，无需反向删除字段。
