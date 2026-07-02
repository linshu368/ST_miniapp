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
 * 若直接 display:none 掉 #leftSendForm，#send_textarea 会扩到最左侧，用户输入文字被
 * 宿主按钮遮挡。因此把 #leftSendForm 改为与 ChatToolsMenu 等宽的占位块，并隐藏其内部按钮；
 * 同时去掉 textarea 左内边距，使文字从宿主按钮右侧开始落入。
 */

export function installNativeUiHide(): void {
  const style = document.createElement('style');
  style.textContent = [
    '#leftSendForm { flex: 0 0 40px !important; width: 40px !important; min-width: 40px !important; padding-left: 0 !important; pointer-events: none !important; }',
    '#leftSendForm > div { display: none !important; }',
    '#send_textarea { padding-left: 0 !important; }',
    '#send_textarea::placeholder { color: transparent !important; }',
  ].join('\n');
  document.head.appendChild(style);
}
