/**
 * st-extension / patches / script-popup-autocancel.ts
 *
 * 架构铁律：vendor/sillytavern 只读，第三方扩展行为从 extension 侧调和。
 *
 * 修复目标：进入对话时弹出的「角色卡 'xxx' 中包含酒馆助手可用的嵌入式脚本，
 *   是否现在就启用它们?」Vue 弹窗。
 *   平台现阶段默认关闭角色脚本，不应让用户感知该弹窗 —— 等价于自动点「取消」。
 *
 * 触发源（JS-Slash-Runner bundle/index.js ~L51034-51063）：
 *   酒馆助手在 chatLoaded 事件后设置 Vue watcher（immediate:true, flush:'post'），
 *   若角色卡含脚本且未在 popuped.characters 中，则通过 Md({component:Kd}).open()
 *   弹出 Vue 模态框（teleport 到 body），按钮为「确认」(shouldEmphasize) + 「取消」。
 *
 * 为什么不能复用 regex-autoconfirm 的 makeFirst(CHAT_CHANGED) 模式：
 *   酒馆助手 pinia store 的 script.popuped.characters 在每次 session 初始化为空数组
 *   (legacy migration transform 硬编码)，写入 extension_settings 不会影响 store 的
 *   reactive state（zod parse 切断了引用）。无法从外部预填充该数组。
 *
 * 修复方式：MutationObserver 监听 body 子节点新增，匹配弹窗内容关键词
 *   「嵌入式脚本」/「embedded scripts」，定位「取消」/「Cancel」按钮并 .click()。
 *   弹窗闪现时间极短（MutationObserver 同步回调），用户几乎无感。
 *   同时覆盖角色脚本和预设脚本的弹窗。
 */

const POPUP_FINGERPRINTS = ['嵌入式脚本', 'embedded scripts'];

const CANCEL_LABELS = ['取消', 'Cancel'];

let observer: MutationObserver | null = null;

function tryAutoCancel(node: Node): boolean {
  if (!(node instanceof HTMLElement)) return false;

  const text = node.textContent ?? '';
  const isScriptPopup = POPUP_FINGERPRINTS.some((fp) =>
    text.toLowerCase().includes(fp.toLowerCase())
  );
  if (!isScriptPopup) return false;

  const buttons = node.querySelectorAll('button');
  for (const btn of buttons) {
    const label = btn.textContent?.trim() ?? '';
    if (CANCEL_LABELS.includes(label)) {
      btn.click();
      return true;
    }
  }

  // Fallback: click the last button (取消 is always the trailing button)
  if (buttons.length >= 2) {
    buttons[buttons.length - 1].click();
    return true;
  }

  return false;
}

function onMutation(mutations: MutationRecord[]): void {
  for (const mutation of mutations) {
    for (const added of mutation.addedNodes) {
      if (tryAutoCancel(added)) return;
    }
  }
}

/**
 * 安装角色脚本弹窗「自动取消」补丁。
 * 通过 MutationObserver 监听 DOM，自动关闭酒馆助手的脚本启用确认弹窗。
 */
export function installScriptPopupAutoCancel(): void {
  if (observer) return;
  observer = new MutationObserver(onMutation);
  observer.observe(document.body, { childList: true, subtree: true });
}
