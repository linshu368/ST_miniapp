import type { AdminMenuViewId } from '@miniapp/admin-client';

/**
 * 运营平台每个专用页面在 CLI 里由哪些命令覆盖（命令名前缀）。
 *
 * 用 Record 让类型系统兜底：ADMIN_MENU_GROUPS 新增页面却没在这里登记时 typecheck 直接失败，
 * 测试再确认登记的前缀确实对应已有命令——这样网页加了功能、CLI 不会悄悄落下。
 * 单个配置一页的入口不需要登记：config 命令按注册表自动覆盖全部 managed config。
 */
export const VIEW_CLI_COMMANDS: Record<AdminMenuViewId, readonly string[]> = {
  fallback_config: ['config'],
  platform_instructions: ['config'],
  reply_style_options: ['config'],
  text_postprocess: ['text-rules'],
  characters: ['character', 'layout'],
  vip_strategy: ['config'],
  invite_program: ['config', 'invite'],
  announcements: ['announcement'],
  image_generation_config: ['config', 'test image-text-model'],
  image_plaza: ['config'],
};
