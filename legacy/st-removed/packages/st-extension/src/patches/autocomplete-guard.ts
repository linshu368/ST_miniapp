/**
 * st-extension / patches / autocomplete-guard.ts
 *
 * 架构铁律：vendor/sillytavern 只读，ST 行为缺陷只能从 extension 侧修复。
 *
 * 修复目标报错：
 *   Uncaught Error: cannot call methods on autocomplete prior to initialization;
 *   attempted to call method 'widget'  (power-user.js:3457)
 *
 * 触发条件：iframe 环境中 window.resize 早于 jQuery UI autocomplete 初始化触发，
 * power-user.js 的 adjustAutocompleteDebounced 遍历 .ui-autocomplete-input 并对
 * 未初始化的元素调用 $(el).autocomplete('widget')，jQuery UI widget bridge 抛异常。
 *
 * 修复方式：包装 $.fn.autocomplete。当目标元素尚未初始化 autocomplete 实例时：
 *   - method === 'widget' → 返回一个 display:none 的游离元素，
 *     使 power-user.js 的 `.autocomplete('widget')[0].style.display !== 'none'`
 *     判定为 false（视作未展开），安全跳过，行为等价；
 *   - 其他 method → no-op 并保持链式，避免抛错；
 *   - 'instance' 与已初始化元素 → 原样透传，零行为改变。
 */

interface JQueryLike {
  fn: { autocomplete?: AutocompleteFn };
  (selectorOrHtml: string): unknown;
}

type AutocompleteFn = ((...args: unknown[]) => unknown) & { __miniappGuarded?: boolean };

function tryInstall(): boolean {
  const $ = (window as unknown as { jQuery?: JQueryLike }).jQuery;
  const original = $?.fn?.autocomplete;
  if (!$ || typeof original !== 'function') return false;
  if (original.__miniappGuarded) return true;

  const guarded = function (this: { length: number }, ...args: unknown[]): unknown {
    if (args.length > 0 && typeof args[0] === 'string') {
      const method = args[0];
      // 'instance' 方法本身永不抛错，用它探测是否已初始化（不必猜 data key）
      const instance = method === 'instance' ? undefined : original.call(this, 'instance');
      if (method !== 'instance' && !instance) {
        if (method === 'widget') {
          return $('<span style="display:none"></span>');
        }
        return this;
      }
    }
    return original.apply(this, args);
  } as AutocompleteFn;

  guarded.__miniappGuarded = true;
  $.fn.autocomplete = guarded;
  return true;
}

/**
 * 安装 autocomplete 防御补丁。jQuery / jQuery UI 可能晚于本扩展加载，
 * 因此带少量重试，确保在首次 resize 事件前就位。
 */
export function installAutocompleteGuard(): void {
  if (tryInstall()) return;
  let attempts = 0;
  const timer = setInterval(() => {
    attempts += 1;
    if (tryInstall() || attempts >= 20) clearInterval(timer);
  }, 200);
}
