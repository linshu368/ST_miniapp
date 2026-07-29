const STYLE_ID = 'miniapp-mobile-chat-theme';

export function shouldExpandComposer(
  value: string,
  scrollHeight: number,
  currentlyExpanded: boolean
): boolean {
  if (value.includes('\n')) return true;
  if (currentlyExpanded) return value.length > 12 || scrollHeight > 54;
  return value.length > 24 || scrollHeight > 54;
}

/**
 * 直接覆盖 ST 原生聊天 DOM 的视觉层，不复制消息、不代理输入，也不改任何事件处理。
 * 配色与外壳的「烛夜」保持同一组取值（见 frontend/src/app/globals.css 的 .dark），
 * 但因为 iframe 是独立 document，无法复用外壳的 Tailwind token，只能在此重复声明。
 */
export function installMobileChatTheme(): void {
  if (document.getElementById(STYLE_ID)) return;

  document.documentElement.style.colorScheme = 'dark';

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    :root {
      --miniapp-chat-bg: #1d181c;
      --miniapp-chat-surface: #272126;
      --miniapp-chat-surface-soft: #332b32;
      --miniapp-chat-text: #ebe2e6;
      --miniapp-chat-muted: #a2949c;
      --miniapp-chat-border: #3d343c;
      --miniapp-chat-accent: #d9b382;
      --miniapp-chat-accent-soft: #332a20;
      /* 金色强调色亮度偏高，落在它上面的图标/文字必须用深褐，白色只有 1.96:1 */
      --miniapp-chat-on-accent: #2a1f16;
      --miniapp-chat-user: #332a2c;
      --SmartThemeBodyColor: #ebe2e6 !important;
      --SmartThemeEmColor: #a2949c !important;
      --SmartThemeQuoteColor: #d9b382 !important;
      --SmartThemeBorderColor: #3d343c !important;
      --SmartThemeBlurTintColor: #272126 !important;
      --SmartThemeChatTintColor: #1d181c !important;
      --SmartThemeUserMesBlurTintColor: #332a2c !important;
      --SmartThemeBotMesBlurTintColor: transparent !important;
    }

    html,
    body {
      background: var(--miniapp-chat-bg) !important;
      color: var(--miniapp-chat-text) !important;
    }

    #top-bar,
    #top-settings-holder,
    #nav-toggle,
    #floatingPrompt,
    #leftNavDrawerIcon,
    #rightNavDrawerIcon,
    #floatingNavPanel,
    body > .drawer-icon,
    body > .panelControlBar {
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
      box-sizing: border-box !important;
      align-self: stretch !important;
      align-items: flex-end !important;
      justify-content: flex-end !important;
      gap: 8px !important;
      width: 100% !important;
      min-width: 0 !important;
      max-width: 100% !important;
      margin: 0 !important;
      padding: 6px 14px 10px !important;
      border: 0 !important;
      border-radius: 0 !important;
      background: transparent !important;
    }

    #chat .mes[is_user='true'] .ch_name {
      display: none !important;
    }

    #chat .mes[is_user='true'] .mesAvatarWrapper {
      display: block !important;
      order: 2 !important;
      flex: 0 0 36px !important;
      max-width: 36px !important;
      margin: 0 !important;
      padding: 0 !important;
    }

    #chat .mes_block {
      box-sizing: border-box !important;
      flex: 1 1 0 !important;
      min-width: 0 !important;
      width: auto !important;
      max-width: calc(100% - 46px) !important;
      padding-left: 10px !important;
    }

    #chat .mes[is_user='true'] .mes_block {
      order: 1 !important;
      flex: 0 1 auto !important;
      width: fit-content !important;
      max-width: min(calc(100% - 44px), 34rem) !important;
      padding: 11px 14px !important;
      border: 1px solid color-mix(in srgb, var(--miniapp-chat-accent) 18%, transparent) !important;
      border-radius: 20px 20px 6px 20px !important;
      background: var(--miniapp-chat-user) !important;
    }

    #chat .mes[is_user='true'] .mes_text {
      width: fit-content !important;
      max-width: 100% !important;
      padding-top: 0 !important;
    }

    #chat .mesAvatarWrapper {
      box-sizing: border-box !important;
      flex: 0 0 36px !important;
      max-width: 36px !important;
      overflow: hidden !important;
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
    #chat .extraMesButtons,
    #chat .extraMesButtonsHint,
    #chat .swipe_left,
    #chat .swipe_right,
    #chat .swipes-counter,
    #chat .mes_img_swipes,
    #chat .mes_reasoning_actions,
    #chat .mes_timer,
    #chat .tokenCounterDisplay,
    #chat .mesIDDisplay {
      display: none !important;
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
      box-shadow: 0 8px 28px rgb(16 13 15 / 40%) !important;
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
      resize: none !important;
      overflow-y: auto !important;
      scrollbar-width: none !important;
      color: var(--miniapp-chat-text) !important;
      font-size: 15px !important;
      line-height: 22px !important;
      caret-color: var(--miniapp-chat-accent) !important;
    }

    #send_textarea::-webkit-scrollbar {
      display: none !important;
      width: 0 !important;
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
      box-sizing: border-box !important;
      position: relative !important;
      flex: 0 0 48px !important;
      width: 48px !important;
      min-width: 48px !important;
      height: 48px !important;
      align-items: center !important;
      justify-content: center !important;
      padding: 0 !important;
    }

    #nonQRFormItems.miniapp-composer-expanded {
      display: grid !important;
      grid-template-columns: 48px minmax(0, 1fr) 48px !important;
      grid-template-rows: auto 48px !important;
      column-gap: 0 !important;
      align-items: center !important;
    }

    #nonQRFormItems.miniapp-composer-expanded #send_textarea {
      grid-column: 1 / -1 !important;
      grid-row: 1 !important;
      box-sizing: border-box !important;
      width: 100% !important;
      min-height: 42px !important;
      padding: 12px 14px 4px !important;
    }

    #nonQRFormItems.miniapp-composer-expanded #leftSendForm {
      grid-column: 1 !important;
      grid-row: 2 !important;
      align-self: center !important;
    }

    #nonQRFormItems.miniapp-composer-expanded #rightSendForm {
      grid-column: 3 !important;
      grid-row: 2 !important;
      align-self: center !important;
    }

    #rightSendForm > div:not(#send_but):not(.mes_stop) {
      display: none !important;
    }

    #send_but,
    #send_form .mes_stop {
      position: absolute !important;
      inset: 4px !important;
      align-items: center !important;
      justify-content: center !important;
      box-sizing: border-box !important;
      width: 40px !important;
      height: 40px !important;
      margin: 0 !important;
      padding: 0 !important;
      border: 0 !important;
      border-radius: 50% !important;
      font-family: inherit !important;
      font-size: 0 !important;
      line-height: 0 !important;
      opacity: 1 !important;
      transform: none !important;
    }

    #send_but {
      background: var(--miniapp-chat-accent) !important;
      color: var(--miniapp-chat-on-accent) !important;
      box-shadow: 0 5px 14px color-mix(in srgb, var(--miniapp-chat-accent) 28%, transparent) !important;
    }

    #send_but::before,
    #send_form .mes_stop::before {
      content: '' !important;
      display: block !important;
      width: 20px !important;
      height: 20px !important;
      background: currentColor !important;
      mask-position: center !important;
      mask-repeat: no-repeat !important;
      mask-size: contain !important;
      -webkit-mask-position: center !important;
      -webkit-mask-repeat: no-repeat !important;
      -webkit-mask-size: contain !important;
    }

    #send_but::before {
      mask-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 24 24' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath fill='black' d='M12 3.5 5.25 10.25l1.5 1.5L11 7.5V20h2V7.5l4.25 4.25 1.5-1.5L12 3.5Z'/%3E%3C/svg%3E") !important;
      -webkit-mask-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 24 24' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath fill='black' d='M12 3.5 5.25 10.25l1.5 1.5L11 7.5V20h2V7.5l4.25 4.25 1.5-1.5L12 3.5Z'/%3E%3C/svg%3E") !important;
    }

    #send_form .mes_stop {
      background: var(--miniapp-chat-surface-soft) !important;
      color: var(--miniapp-chat-accent) !important;
      box-shadow: inset 0 0 0 1px var(--miniapp-chat-border) !important;
    }

    #send_form .mes_stop::before {
      width: 15px !important;
      height: 15px !important;
      border-radius: 4px !important;
      mask-image: none !important;
      -webkit-mask-image: none !important;
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

      #chat .mesAvatarWrapper {
        flex-basis: 34px !important;
        max-width: 34px !important;
      }

      #chat .mes_block {
        max-width: calc(100% - 42px) !important;
      }

      #chat .mes[is_user='true'] .mes_block {
        max-width: calc(100% - 42px) !important;
      }

      #chat .mes[is_user='true'] .mesAvatarWrapper {
        flex-basis: 34px !important;
        max-width: 34px !important;
      }
    }
  `;
  document.head.appendChild(style);

  const bindComposerLayout = () => {
    const textarea = document.querySelector<HTMLTextAreaElement>('#send_textarea');
    const formItems = document.querySelector<HTMLElement>('#nonQRFormItems');
    if (!textarea || !formItems || formItems.dataset.miniappLayoutBound === 'true') return false;

    formItems.dataset.miniappLayoutBound = 'true';
    const syncLayout = () => {
      const wasExpanded = formItems.classList.contains('miniapp-composer-expanded');
      const expanded = shouldExpandComposer(textarea.value, textarea.scrollHeight, wasExpanded);
      formItems.classList.toggle('miniapp-composer-expanded', expanded);
      if (expanded !== wasExpanded) {
        requestAnimationFrame(() => {
          textarea.style.height = '1px';
          textarea.style.height = `${Math.min(textarea.scrollHeight, window.innerHeight * 0.5)}px`;
        });
      }
    };

    textarea.addEventListener('input', () => requestAnimationFrame(syncLayout));
    new ResizeObserver(syncLayout).observe(textarea);
    syncLayout();
    return true;
  };

  if (!bindComposerLayout()) {
    const composerObserver = new MutationObserver(() => {
      if (bindComposerLayout()) composerObserver.disconnect();
    });
    composerObserver.observe(document.body, { childList: true, subtree: true });
  }
}
