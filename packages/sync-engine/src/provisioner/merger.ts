/**
 * sync-engine / provisioner / merger.ts
 *
 * merge(A_settings, B_settings) 逻辑 + character_ref 有效性校验。
 *
 * 核心原则：
 *   - 所有逻辑在内存中完成，不做任何 IO（writer.ts 负责写盘）
 *   - B 只能覆盖 writable_paths 白名单内的键（决策 1）
 *   - character_ref 失效时回退到系统兜底卡（runtime_config.system_fallback_character_id）
 */

import { get as lodashGet, set as lodashSet, cloneDeep } from 'lodash-es';
import type { PlatformSettingsRow, UserSettingsRow } from './fetcher.js';

// ─── 类型定义 ─────────────────────────────────────────────────────────────────

/** merge 后的 settings，附带一个 debug 标记字段 */
export interface MergedSettings {
  /** 最终写入 settings.json 的内容 */
  settings: Record<string, unknown>;
  /** 本次 merge 是否触发了 character_ref 失效兜底 */
  hadInvalidRef: boolean;
  /** 如果触发了兜底，记录原来的失效值 */
  invalidRefValue?: string;
}

/**
 * 用户 ST persona 注入参数（对话页/回复里显示的「用户名 + 头像」）。
 *   name       - 显示名（TG 名字），为空则不注入、保留平台默认 persona
 *   avatarFile - User Avatars/ 下已落盘的头像文件名，为空则沿用现有/默认头像文件
 */
export interface PersonaInput {
  name: string | null;
  avatarFile: string | null;
}

// ─── 主 merge 函数 ────────────────────────────────────────────────────────────
/**
 * 将平台 settings（A）与用户 settings 镜像（B）合并，
 * 并对 character_ref 类型的字段做有效性校验。
 *
 * @param platformSettings       - 分区 A 最新版本
 * @param userSettings           - 分区 B 该用户最新行（null 表示新用户，完全用 A 默认值）
 * @param availableCharIds       - 本次已下发的角色卡 id 列表（用于 character_ref 校验）
 * @param fallbackCharacterId    - 系统兜底卡 ID（character_ref 失效时的回退值，来自 runtime_config）
 * @param llmProxyUrl            - 写入 ST settings 的平台 LLM 代理地址
 * @param persona                - 用户 ST persona（TG 名字/头像），可选；name 为空则不注入
 */
export function mergeSettings(
  platformSettings: PlatformSettingsRow,
  userSettings: UserSettingsRow | null,
  availableCharIds: string[],
  fallbackCharacterId: string | undefined,
  llmProxyUrl: string,
  persona?: PersonaInput
): MergedSettings {
  // 深拷贝 A 作为 base（绝不修改原始对象）
  const merged = cloneDeep(platformSettings.settings_jsonb) as Record<string, unknown>;

  // 如果有 B 类记录，按白名单覆盖
  if (userSettings) {
    for (const { path, transform } of platformSettings.writable_paths) {
      const bVal = lodashGet(userSettings.settings_jsonb, path);
      if (bVal !== undefined) {
        // character_ref 在投影阶段做校验（这里先 set，后面统一校验）
        // passthrough 直接覆盖
        lodashSet(merged, path, bVal);
      }
    }
  }

  // character_ref 有效性校验（决策 8）
  // 在已 merge 的结果上对所有 character_ref 类型的路径做校验
  let hadInvalidRef = false;
  let invalidRefValue: string | undefined;

  for (const { path, transform } of platformSettings.writable_paths) {
    if (transform !== 'character_ref') continue;

    const currentVal = lodashGet(merged, path) as string | undefined;
    if (!currentVal) continue;

    // currentVal 格式：platform_<uuid>.png
    // 从中提取 uuid 部分做校验
    const match = currentVal.match(/^platform_([0-9a-f-]+)\.png$/i);
    if (!match) {
      hadInvalidRef = true;
      invalidRefValue = currentVal;
      const fallback = buildFallbackCharRef(fallbackCharacterId);
      if (fallback) lodashSet(merged, path, fallback);
      continue;
    }

    const refId = match[1] ?? '';
    if (!refId || !availableCharIds.includes(refId)) {
      hadInvalidRef = true;
      invalidRefValue = currentVal;
      const fallback = buildFallbackCharRef(fallbackCharacterId);
      if (fallback) lodashSet(merged, path, fallback);
    }
  }

  // 强制覆写 LLM endpoint 为平台代理网关地址，确保 ST 的 LLM 调用经 backend 代理（注入 key + 计费）。
  // 地址由调用方从配置层传入，避免 merge 纯函数直接依赖全局环境变量。
  lodashSet(merged, 'oai_settings.reverse_proxy', llmProxyUrl);
  lodashSet(merged, 'oai_settings.custom_url', llmProxyUrl);

  // 强制 ST 走「Chat Completion + custom 源」链路，否则生成会绕过平台代理（无回复、不计费）。
  // - main_api 决定实际发起请求的顶层 API；默认模板常为 koboldhorde，会完全不碰上面的 custom_url。
  // - 仅当 chat_completion_source='custom' 时，ST 才使用 oai_settings.custom_url 指向的 backend 代理；
  //   openai 源会改用 reverse_proxy 并落到官方 OpenAI，openrouter 模型 id 也无法在官方端点识别。
  // - custom_model 为空时 ST 无模型可发；回退到标准档默认模型（与 model-tiers/前端档位一致）。
  //   用户经档位切换写入的 custom_model 已在上方按 writable_paths 合并，此处仅在缺省时兜底。
  lodashSet(merged, 'main_api', 'openai');
  lodashSet(merged, 'oai_settings.chat_completion_source', 'custom');
  if (!lodashGet(merged, 'oai_settings.custom_model')) {
    lodashSet(merged, 'oai_settings.custom_model', 'google/gemini-2.5-flash');
  }

  // 强制设置上下文上限：默认模板的 openai_max_context=4095 过小，大角色卡（人设 + 内置正则）
  // 组装后的提示词极易超限，触发「必要的提示词超过了上下文大小」并截断历史。
  // 平台模型（gemini-2.5-flash ~1M / claude-sonnet-4 ~200K）远大于此，统一抬到 32K 兼顾体验与成本。
  // max_context_unlocked=true 解除 UI 预设档位限制，使该值生效。
  lodashSet(merged, 'oai_settings.openai_max_context', 32768);
  lodashSet(merged, 'oai_settings.max_context_unlocked', true);

  // 关闭 ST 首次引导（persona 设定面板）：用户在 Telegram 内打开 miniapp 即视为已登录，
  // 不应感知 ST 的 onboarding。ST 仅在 settings.firstRun 为真时调用 doOnboarding()
  // （见 vendor/sillytavern/public/script.js）；新 provision 出来的用户默认 firstRun=true
  // 会弹出「您的用户设定 / 用户设定名称」面板。强制写 false，彻底不弹（每次 force provision 重申）。
  lodashSet(merged, 'firstRun', false);

  // 注入用户自己的 TG persona（名字 + 头像）。平台种子里 name1/user_avatar/personas 写死了
  // 运营 default-user 的 persona（如 user-default.png→"linshu"），若不覆盖则所有用户都显示同一名字。
  // persona 段不在 writable_paths（属平台管控），每次 provision 覆盖写以对齐当前 TG 身份。
  applyUserPersona(merged, persona);

  // 净化 accountStorage 中的抽屉「钉住/展开」状态：这些是运营端在完整 ST 里编辑预设时残留的
  // 界面状态（见 vendor scripts/util/AccountStorage.js + RossAscends-mods.js），会被一并写进
  // platform_settings 并下发给所有用户，导致「AI Response Configuration / 对话补全预设」抽屉
  // (#left-nav-panel) 在聊天页被钉开、占满屏幕。平台不开放用户改预设，这些 UI 状态一律强制关闭。
  sanitizeAccountStorageDrawerState(merged);

  return { settings: merged, hadInvalidRef, invalidRefValue };
}

/**
 * ST 抽屉的「钉住(*LockOn)」与「展开(*Opened)」状态存于 settings.accountStorage。
 * 强制清零这些 key，避免运营端残留状态把导航抽屉（左：AI 配置/预设，右：角色/预设面板，
 * WI：世界书）在用户端钉开或自动展开。仅动这几个 UI 状态 key，其余 accountStorage 保留。
 */
function sanitizeAccountStorageDrawerState(merged: Record<string, unknown>): void {
  const accountStorage = lodashGet(merged, 'accountStorage');
  if (!accountStorage || typeof accountStorage !== 'object') return;

  const drawerStateKeys = [
    'LNavLockOn',
    'NavLockOn',
    'WINavLockOn',
    'LNavOpened',
    'NavOpened',
    'WINavOpened',
  ];

  const store = accountStorage as Record<string, unknown>;
  for (const key of drawerStateKeys) {
    if (key in store) store[key] = 'false';
  }
}

/**
 * 把用户 TG persona 注入 merged settings：
 *   - name1                              → 对话/回复里显示的用户名
 *   - user_avatar                        → 当前 persona 头像文件名
 *   - power_user.personas                → { <avatar>: <name> }（整体替换，清掉运营残留如 linshu）
 *   - power_user.persona_descriptions    → { <avatar>: { position, description } }
 * name 为空则不动（保留平台默认 persona，例如浏览器 bypass 无 TG 身份时）。
 */
function applyUserPersona(merged: Record<string, unknown>, persona?: PersonaInput): void {
  if (!persona || !persona.name) return;

  const existingAvatar = lodashGet(merged, 'user_avatar');
  const avatarFile =
    persona.avatarFile ||
    (typeof existingAvatar === 'string' && existingAvatar ? existingAvatar : 'user-default.png');

  lodashSet(merged, 'name1', persona.name);
  lodashSet(merged, 'user_avatar', avatarFile);
  lodashSet(merged, 'power_user.personas', { [avatarFile]: persona.name });
  lodashSet(merged, 'power_user.persona_descriptions', {
    [avatarFile]: { position: 0, description: '' },
  });
}

/** 构造兜底的 character_ref 值（platform_<fallback_uuid>.png） */
function buildFallbackCharRef(fallbackCharacterId: string | undefined): string | undefined {
  if (!fallbackCharacterId) return undefined;
  return `platform_${fallbackCharacterId}.png`;
}
