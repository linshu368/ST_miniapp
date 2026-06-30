/**
 * st-extension / patches / native-ui-hide.ts
 *
 * 架构铁律：vendor/sillytavern 只读，ST 视觉定制从 extension 侧处理。
 *
 * 隐藏目标：#leftSendForm（含 #options_button 和 #extensionsMenuButton）。
 *
 * 原因：平台壳已用自研 ChatToolsMenu 替代左下角原生按钮的功能（模型切换等），
 * 原生按钮暴露会造成视觉干扰。由于 textarea 高度随用户输入动态变化，
 * 纯覆盖方案无法在所有尺寸下完全遮住原生按钮，故直接通过 CSS 隐藏。
 */

export function installNativeUiHide(): void {
  const style = document.createElement('style');
  style.textContent = `#leftSendForm { display: none !important; }`;
  document.head.appendChild(style);
}
