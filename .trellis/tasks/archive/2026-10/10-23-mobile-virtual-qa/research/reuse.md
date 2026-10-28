# 已核实复用入口

- packages/frontend/src/lib/api/images.ts 的queryFn旧/新缓存比较；media-cache.test.ts既有hooks捕获和真实QueryClient。
- packages/frontend/src/components/chat/composer-layout.ts及既有test；useVisualViewportHeight；chat page→composer→preferences prop。
- packages/frontend/src/lib/telegram/hooks.ts及既有test；SDK downloadFile成功只指受理，不代表相册落盘。
- packages/backend/src/infrastructure/repositories/MiniappWalletRepository.ts及既有test；listSpending同用户按时间合并。
- packages/backend/src/features/image-plaza/job.ts：一次provider请求，存图/settle后ready；明确拒绝和结果未知分别markFailed，未知不重发。
- packages/shared/migrations/20261012_image_plaza_v2.sql：既有结算类型image_plaza_generation；本次只读源码，不执行SQL。

只读虚拟复现：320×720长消息和展开偏好，改为320×320而不再打字，textarea仍高360，发送按钮top638/bottom678超出可视区。无需真机即可确认effect缺少视口重算。
