# Implementation

1. 研究官方接口、映射仓库现有链路，确认最小无迁移方案。
2. Shared先加可选开关与思考SSE事件；Backend route/generation/tap适配两平台并扩展相关回归。
3. Frontend开关、SSE分流、请求身份隔离与临时思考缓存、折叠展示和滚动/停滞反馈。
4. 执行 shared/backend/frontend现有测试、所有消费者typecheck、frontend lint/build、导入边界检查。
5. 本地fixture移动端验收：思考展开→正文自动折叠→手动展开，关闭/再生成、取消、320px/压缩高度；与供应商真实调用明确区分。
6. 独立review、修复、更新业务规范及结果；保持本地可预览，不发布或修改dev。
