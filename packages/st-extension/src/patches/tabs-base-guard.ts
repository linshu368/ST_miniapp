/**
 * st-extension / patches / tabs-base-guard.ts
 *
 * 架构铁律：vendor/sillytavern 只读，ST 行为缺陷只能从 extension 侧修复。
 *
 * 修复目标：对话页 ST UI 整体不渲染（#sheld 0×0）、发送按钮不可见、消息无法发送。
 *
 * 根因：
 *   ST index.html 含 `<base href="/">`，而在本平台 iframe 中 ST 被 Next rewrite
 *   挂在 `/tavern` 路径下提供服务。jQuery UI Tabs（#bg_tabs，背景选择 tab）用
 *   `anchor.href(去 hash) === location.href(去 hash)` 判定 tab 是否为「本地锚点」。
 *   由于 <base href="/">，本地锚点 `#bg_global_tab` 的 anchor.href 解析为
 *   `http://host/#bg_global_tab`（base 部分 `http://host/`），而 location 是
 *   `http://host/tavern` —— 两者不等 → 被误判为「远程 tab」→ jQuery UI 通过 AJAX
 *   把整页（ST 自身）加载进 tab panel，注入了一份完整重复的 ST DOM
 *   （出现两个 #sheld / #send_textarea / #send_but / <title> / <base>）。
 *   重复节点在 DOM 顺序上靠前，ST 的 `$('#send_textarea')`、`$('#send_but')` 等
 *   命中的是隐藏(0×0)的重复副本，导致用户看到/输入的真实节点与 ST 逻辑脱节。
 *
 * 修复方式（两手都要，覆盖「补丁早于/晚于 bg_tabs 初始化」两种时序）：
 *   1. 覆写 `$.ui.tabs.prototype._isLocal`：只要锚点 hash 指向当前文档存在的元素，
 *      即判定为本地 tab，杜绝把本地锚点当远程 URL 去 AJAX 拉取。
 *   2. 修复已被污染的 tabs：若检测到重复 ST DOM，则对含整页注入痕迹（title/base/#sheld）
 *      的 `.ui-tabs` 执行 destroy + 重新初始化（jQuery UI 会移除其生成的远程 panel，
 *      连带清掉注入的重复 DOM），再以已打补丁的 _isLocal 重建为本地 tab。
 */

interface TabsAnchor {
  hash?: string;
}

interface TabsProto {
  _isLocal?: (anchor: TabsAnchor) => boolean;
  __miniappIsLocalPatched?: boolean;
  document?: { 0?: Document } & ArrayLike<Document>;
}

interface JQueryCollection {
  length: number;
  hasClass(cls: string): boolean;
  find(selector: string): JQueryCollection;
  each(cb: (this: Element) => void): JQueryCollection;
  tabs(...args: unknown[]): unknown;
}

interface JQueryStatic {
  (selectorOrEl: string | Element): JQueryCollection;
  ui?: { tabs?: { prototype: TabsProto } };
  fn?: { tabs?: unknown };
}

function getJQuery(): JQueryStatic | undefined {
  return (window as unknown as { jQuery?: JQueryStatic }).jQuery;
}

/** 覆写 _isLocal：hash 指向现有元素 → 本地 tab。返回 true 表示补丁已就位。 */
function patchIsLocal($: JQueryStatic): boolean {
  const proto = $.ui?.tabs?.prototype;
  if (!proto) return false;
  if (proto.__miniappIsLocalPatched) return true;

  const original = proto._isLocal;
  proto._isLocal = function (this: TabsProto, anchor: TabsAnchor): boolean {
    try {
      const hash = anchor?.hash;
      if (hash && hash.length > 1) {
        const id = decodeURIComponent(hash.slice(1));
        const doc = this.document?.[0] ?? document;
        if (id && doc.getElementById(id)) return true;
      }
    } catch {
      /* 落到原始判定 */
    }
    return typeof original === 'function' ? original.call(this, anchor) : false;
  };
  proto.__miniappIsLocalPatched = true;
  return true;
}

/** 整页注入会导致同一 id 出现多份，是本 bug 的可靠信号。 */
function hasDuplicateStDom(): boolean {
  return (
    document.querySelectorAll('[id="sheld"]').length > 1 ||
    document.querySelectorAll('[id="send_textarea"]').length > 1
  );
}

/** 修复被远程注入污染的 tabs：destroy 移除生成的 panel（连带重复 DOM），再重建。 */
function repairBrokenTabs($: JQueryStatic): void {
  if (!hasDuplicateStDom()) return;
  $('.ui-tabs').each(function (this: Element) {
    const $t = $(this);
    // 整页被注入的 panel 会带来 <title>/<base>/#sheld 等本不该出现在 tab 内的痕迹
    const polluted = $t.find('title, base, [id="sheld"]').length > 0;
    if (!polluted) return;
    try {
      if ($t.hasClass('ui-tabs')) $t.tabs('destroy');
      $t.tabs();
    } catch {
      /* 单个 tabs 修复失败不应中断其余修复 */
    }
  });
}

/**
 * 安装 tabs base 守卫。jQuery UI 可能晚于本扩展加载、bg_tabs 初始化时机也不确定，
 * 因此持续重试：先尽早打上 _isLocal 补丁（杜绝后续误加载），同时轮询修复已污染的
 * tabs，直到重复 DOM 清除或超时。
 */
export function installTabsBaseGuard(): void {
  let attempts = 0;
  let patched = false;

  const tick = (): void => {
    attempts += 1;
    const $ = getJQuery();
    if ($) {
      patched = patchIsLocal($) || patched;
      if (typeof $.fn?.tabs === 'function') {
        repairBrokenTabs($);
      }
    }
    if (attempts >= 30 || (patched && !hasDuplicateStDom() && attempts >= 5)) {
      clearInterval(timer);
    }
  };

  const timer = setInterval(tick, 200);
  tick();
}
