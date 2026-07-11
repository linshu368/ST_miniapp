/**
 * st-extension / patches / native-ui-hide.ts
 *
 * 架构铁律：vendor/sillytavern 只读，ST 视觉定制从 extension 侧处理。
 *
 * 隐藏目标：#leftSendForm 内原生按钮（含 #options_button 和 #extensionsMenuButton）、
 * #send_textarea placeholder 文字。
 *
 * 原因：平台壳已用自研 ChatToolsMenu 替代左下角原生按钮的功能（模型切换等），
 * 原生按钮暴露会造成视觉干扰。但 ChatToolsMenu 位于宿主页面并覆盖在 ST iframe 上方，
 * 工具按钮现已移动到宿主聊天顶栏，因此输入区不再需要预留左侧占位。保留原生 DOM，
 * 但把容器压缩为 0 宽并隐藏内部按钮，让 textarea 使用完整可用宽度。
 */

export function installNativeUiHide(): void {
  const style = document.createElement('style');
  style.textContent = [
    '#leftSendForm { flex: 0 0 0 !important; width: 0 !important; min-width: 0 !important; margin: 0 !important; padding: 0 !important; overflow: hidden !important; pointer-events: none !important; }',
    '#leftSendForm > div { display: none !important; }',
    '#send_textarea { min-width: 0 !important; padding-left: clamp(10px, 3vw, 16px) !important; }',
    '#send_textarea::placeholder { color: transparent !important; }',
  ].join('\n');
  document.head.appendChild(style);
}

/**
 * 隐藏 ST 原生「AI Response Configuration / 对话补全预设」抽屉。
 *
 * 平台不开放用户自主修改预设，该抽屉（顶栏图标 #leftNavDrawerIcon + 面板 #left-nav-panel，
 * 含预设下拉 #settings_preset_openai、提示词管理 #completion_prompt_manager 等）必须始终隐藏。
 *
 * 用 display:none 而非移除 DOM：ST 内部预设加载仍依赖这些元素存在（仅读取，不需可见），
 * 隐藏后不影响预设生效与 bridge 档位切换（changeModel 直写 oai_settings.custom_model，
 * 不经该抽屉）。CSS 方案与时序无关，即使 accountStorage 残留 pin 状态把抽屉钉开，
 * 面板整体不可见亦不占位，作为 merger 净化之外的兜底。
 */
export function installPresetUiHide(): void {
  const style = document.createElement('style');
  style.textContent = [
    '#ai-config-button { display: none !important; }',
    '#left-nav-panel { display: none !important; }',
  ].join('\n');
  document.head.appendChild(style);
}

/**
 * 隐藏消息正文中的空 <details> 元素。
 *
 * 部分角色卡让模型用 `<details>` 包裹 `<UpdateVariable>` 等变量块，卡自带的
 * scoped 正则在展示时剥离了内部 `<UpdateVariable>` 却保留了外层 `<details>`。
 * `encode_tags=false` 时浏览器将空 `<details>` 渲染为带「详情」折叠标签的空区域。
 * 此规则在渲染层隐藏"无子元素"的 `<details>`，不影响含有合法内容的折叠区域。
 */
export function installEmptyDetailsHide(): void {
  const style = document.createElement('style');
  style.textContent = '.mes_text details:not(:has(*)) { display: none !important; }';
  document.head.appendChild(style);
}
