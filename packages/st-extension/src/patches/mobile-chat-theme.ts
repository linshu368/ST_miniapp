const STYLE_ID = 'miniapp-mobile-chat-theme';
const APPEARANCE_STORAGE_KEY = 'st_miniapp_appearance_mode';

export type MiniappAppearance = 'light' | 'dark';

export function resolveMiniappAppearance(value: unknown): MiniappAppearance {
  return value === 'dark' ? 'dark' : 'light';
}

function readAppearance(): MiniappAppearance {
  try {
    return resolveMiniappAppearance(window.localStorage.getItem(APPEARANCE_STORAGE_KEY));
  } catch {
    return 'light';
  }
}

function applyAppearance(mode: MiniappAppearance): void {
  document.documentElement.dataset.miniappAppearance = mode;
  document.documentElement.style.colorScheme = mode;
}

/**
 * 直接覆盖 ST 原生聊天 DOM 的视觉层，不复制消息、不代理输入，也不改任何事件处理。
 * MiniApp 外壳和 /tavern iframe 同源，共享 appearance localStorage；切换后 iframe
 * 会收到 storage 事件。额外观察父页面 data-appearance，兜底同文档即时同步。
 */
export function installMobileChatTheme(): void {
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    :root[data-miniapp-appearance='light'] {
      --miniapp-chat-bg: #f8f9fb;
      --miniapp-chat-surface: #ffffff;
      --miniapp-chat-surface-soft: #f1f3f6;
      --miniapp-chat-text: #17191d;
      --miniapp-chat-muted: #7b8089;
      --miniapp-chat-border: #e4e7ec;
      --miniapp-chat-accent: #10b981;
      --miniapp-chat-accent-soft: #ecfdf5;
      --miniapp-chat-user: #ecfdf5;
      --SmartThemeBodyColor: #17191d !important;
      --SmartThemeEmColor: #68707c !important;
      --SmartThemeQuoteColor: #059669 !important;
      --SmartThemeBorderColor: #e4e7ec !important;
      --SmartThemeBlurTintColor: #ffffff !important;
      --SmartThemeChatTintColor: #f8f9fb !important;
      --SmartThemeUserMesBlurTintColor: #ecfdf5 !important;
      --SmartThemeBotMesBlurTintColor: transparent !important;
    }

    :root[data-miniapp-appearance='dark'] {
      --miniapp-chat-bg: #0d1110;
      --miniapp-chat-surface: #151a18;
      --miniapp-chat-surface-soft: #1d2421;
      --miniapp-chat-text: #eef3f0;
      --miniapp-chat-muted: #939d98;
      --miniapp-chat-border: #29312d;
      --miniapp-chat-accent: #34d399;
      --miniapp-chat-accent-soft: #12362b;
      --miniapp-chat-user: #173a30;
      --SmartThemeBodyColor: #eef3f0 !important;
      --SmartThemeEmColor: #a5b0aa !important;
      --SmartThemeQuoteColor: #6ee7b7 !important;
      --SmartThemeBorderColor: #29312d !important;
      --SmartThemeBlurTintColor: #151a18 !important;
      --SmartThemeChatTintColor: #0d1110 !important;
      --SmartThemeUserMesBlurTintColor: #173a30 !important;
      --SmartThemeBotMesBlurTintColor: transparent !important;
    }

    html,
    body {
      background: var(--miniapp-chat-bg) !important;
      color: var(--miniapp-chat-text) !important;
    }

    #top-bar,
    #top-settings-holder {
      display: none !important;
    }

    #sheld {
      top: calc(env(safe-area-inset-top) + 56px) !important;
      height: calc(100dvh - env(safe-area-inset-top) - 56px) !important;
      max-height: calc(100dvh - env(safe-area-inset-top) - 56px) !important;
      width: 100dvw !important;
      max-width: 100dvw !important;
      border: 0 !important;
      border-radius: 0 !important;
      background: var(--miniapp-chat-bg) !important;
      box-shadow: none !important;
    }

    #chat {
      border: 0 !important;
      border-radius: 0 !important;
      padding: 12px 0 8px !important;
      background: var(--miniapp-chat-bg) !important;
      scrollbar-width: none;
      overscroll-behavior: contain;
    }

    #chat::-webkit-scrollbar {
      display: none;
      width: 0;
    }

    #chat .mes {
      margin: 0 !important;
      padding: 12px 16px 14px !important;
      border: 0 !important;
      background: transparent !important;
      color: var(--miniapp-chat-text) !important;
      box-shadow: none !important;
    }

    #chat .mes[is_user='true'] {
      margin: 6px 14px 10px 54px !important;
      padding: 11px 14px !important;
      border: 1px solid color-mix(in srgb, var(--miniapp-chat-accent) 18%, transparent) !important;
      border-radius: 20px 20px 6px 20px !important;
      background: var(--miniapp-chat-user) !important;
    }

    #chat .mes[is_user='true'] .mesAvatarWrapper,
    #chat .mes[is_user='true'] .ch_name {
      display: none !important;
    }

    #chat .mes_block {
      min-width: 0 !important;
      padding-left: 10px !important;
    }

    #chat .mes[is_user='true'] .mes_block {
      padding-left: 0 !important;
    }

    #chat .mesAvatarWrapper,
    #chat .avatar,
    #chat .avatar img {
      width: 36px !important;
      min-width: 36px !important;
      height: 36px !important;
      border-radius: 50% !important;
    }

    #chat .avatar img {
      border: 1px solid var(--miniapp-chat-border) !important;
      box-shadow: none !important;
    }

    #chat .ch_name {
      min-height: 18px !important;
      color: var(--miniapp-chat-text) !important;
      font-size: 13px !important;
      font-weight: 650 !important;
    }

    #chat .mes_text,
    #chat .mes_reasoning {
      color: var(--miniapp-chat-text) !important;
      font-size: 15px !important;
      font-weight: 440 !important;
      line-height: 1.72 !important;
    }

    #chat .mes_text {
      padding: 4px 0 0 !important;
    }

    #chat .mes_text blockquote,
    #chat .mes_reasoning blockquote,
    #chat .mes_reasoning_details {
      border-color: var(--miniapp-chat-border) !important;
      border-radius: 14px !important;
      background: var(--miniapp-chat-surface-soft) !important;
    }

    #chat .mes_buttons,
    #chat .extraMesButtons {
      gap: 3px !important;
      color: var(--miniapp-chat-muted) !important;
    }

    #chat .mes_button {
      border-radius: 999px !important;
    }

    #form_sheld {
      box-sizing: border-box !important;
      margin: 0 !important;
      padding: 8px 10px calc(env(safe-area-inset-bottom) + 8px) !important;
      background: var(--miniapp-chat-bg) !important;
    }

    #send_form {
      min-height: 50px !important;
      margin: 0 !important;
      border: 1px solid var(--miniapp-chat-border) !important;
      border-radius: 22px !important;
      background: var(--miniapp-chat-surface) !important;
      box-shadow: 0 8px 28px rgb(15 23 42 / 8%) !important;
      backdrop-filter: none !important;
    }

    #send_form:has(#send_textarea:focus-visible) {
      border-color: color-mix(in srgb, var(--miniapp-chat-accent) 55%, var(--miniapp-chat-border)) !important;
      outline: 2px solid color-mix(in srgb, var(--miniapp-chat-accent) 12%, transparent) !important;
    }

    #send_textarea {
      min-height: 48px !important;
      height: 48px;
      padding: 13px 6px 10px 4px !important;
      color: var(--miniapp-chat-text) !important;
      font-size: 15px !important;
      line-height: 22px !important;
      caret-color: var(--miniapp-chat-accent) !important;
    }

    #send_textarea::placeholder {
      color: var(--miniapp-chat-muted) !important;
      text-align: left !important;
    }

    #leftSendForm {
      flex-basis: 46px !important;
      width: 46px !important;
      min-width: 46px !important;
    }

    #rightSendForm {
      align-items: center !important;
      padding-right: 4px !important;
    }

    #rightSendForm > div:not(.mes_stop),
    #send_form .mes_stop {
      width: 40px !important;
      height: 40px !important;
      margin: 4px 0 !important;
      border-radius: 50% !important;
      color: var(--miniapp-chat-muted) !important;
      opacity: 1 !important;
    }

    #send_but {
      background: var(--miniapp-chat-accent) !important;
      color: #ffffff !important;
      box-shadow: 0 5px 14px color-mix(in srgb, var(--miniapp-chat-accent) 28%, transparent) !important;
    }

    @media (max-width: 520px) {
      #chat .mes {
        padding-right: 14px !important;
        padding-left: 14px !important;
      }

      #chat .mes_text,
      #chat .mes_reasoning {
        font-size: 14.5px !important;
        line-height: 1.76 !important;
      }

      #chat .mesAvatarWrapper,
      #chat .avatar,
      #chat .avatar img {
        width: 34px !important;
        min-width: 34px !important;
        height: 34px !important;
      }
    }
  `;
  document.head.appendChild(style);

  const syncFromParent = () => {
    try {
      const parentMode = window.parent.document.documentElement.dataset.appearance;
      applyAppearance(resolveMiniappAppearance(parentMode ?? readAppearance()));
    } catch {
      applyAppearance(readAppearance());
    }
  };

  syncFromParent();
  window.addEventListener('storage', (event) => {
    if (event.key === APPEARANCE_STORAGE_KEY) {
      applyAppearance(resolveMiniappAppearance(event.newValue));
    }
  });

  try {
    const parentRoot = window.parent.document.documentElement;
    new MutationObserver(syncFromParent).observe(parentRoot, {
      attributes: true,
      attributeFilter: ['data-appearance', 'class'],
    });
  } catch {
    // 非同源或父页面不可访问时，仅使用共享 localStorage 的初始值与 storage 事件。
  }
}
