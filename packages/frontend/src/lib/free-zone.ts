import {
  formatVipWeeklyWindow,
  freeZoneWeekdayLabel,
  type ChatMessage,
  type GetModelCatalogData,
  type PublicFreeZone,
  type PublicFreeZoneAccess,
} from '@miniapp/shared';

/**
 * 畅聊栏目的展示判断（纯函数）。栏目状态由后端算好下发，这里只负责：
 * 时间写成人话、按本地时钟兜底「已过结束时间就当未开放」、算下一个需要重新拉目录的时间点、
 * 按身份写卡头说明、推导对话里「免费 → 付费」的分隔线。
 */

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** 今天 / 明天 / 7 天内写周几 / 再远写日期，后面跟 HH:mm（手机本地时区）。 */
export function formatFreeZoneTime(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const days = Math.round((startOfDay(at) - startOfDay(now)) / DAY_MS);
  if (days === 0) return `今天 ${clock}`;
  if (days === 1) return `明天 ${clock}`;
  if (days > 1 && days < 7) return `${WEEKDAYS[at.getDay()]} ${clock}`;
  return `${at.getMonth() + 1}月${at.getDate()}日 ${clock}`;
}

/** 「剩 2 天」「剩 5 小时」：向上取整，最后一天里写小时 */
export function remainingText(iso: string, now = new Date()): string {
  const ms = Date.parse(iso) - now.getTime();
  if (ms <= 0) return '即将结束';
  const hours = Math.ceil(ms / HOUR_MS);
  return hours >= 24 ? `剩 ${Math.ceil(hours / 24)} 天` : `剩 ${hours} 小时`;
}

/** 后端说开放、且按本地时钟还没过结束时间，才算开放：防止缓存里的旧状态让人误选。 */
export function isFreeZoneOpen(zone: PublicFreeZone | null | undefined, now = new Date()) {
  return zone?.state === 'open' && Date.parse(zone.ends_at) > now.getTime();
}

export function freeZoneStatusText(zone: PublicFreeZone, now = new Date()): string {
  switch (zone.state) {
    case 'open': {
      if (!isFreeZoneOpen(zone, now)) return '暂未开放';
      const via = zone.access?.via;
      if (via === 'trial') return `新人体验 · ${remainingText(zone.ends_at, now)}`;
      if (via === 'vip_welcome') return `开通礼 · ${remainingText(zone.ends_at, now)}`;
      return `${formatFreeZoneTime(zone.ends_at, now)} 结束`;
    }
    case 'not_started':
    case 'vip_waiting':
      return `${formatFreeZoneTime(zone.starts_at, now)} 开始`;
    case 'own_card_only':
      return '仅限自创角色卡';
    case 'no_models':
      return '暂未开放';
    case 'vip_only':
      return 'VIP 专享';
  }
}

/** 点了未开放栏目里的模型时的就地提示。 */
export function freeZoneClosedHint(zone: PublicFreeZone, now = new Date()): string {
  switch (zone.state) {
    case 'not_started':
      return `畅聊模型还没开放，${formatFreeZoneTime(zone.starts_at, now)} 开始`;
    case 'vip_waiting':
      return `畅聊${formatFreeZoneTime(zone.starts_at, now)} 开始，到时直接选用`;
    case 'vip_only':
      return '开通 VIP 后即可选用';
    case 'own_card_only':
      return '畅聊模型仅限在自己创作的角色卡里使用';
    default:
      return '畅聊模型暂未开放，规则见上方说明';
  }
}

/** 下一个会改变栏目状态的时间点距现在多少毫秒；没有或超过一天返回 null。 */
export function freeZoneBoundaryDelay(
  zone: PublicFreeZone | null | undefined,
  now = new Date()
): number | null {
  const at =
    zone?.state === 'open'
      ? zone.ends_at
      : zone?.state === 'not_started' || zone?.state === 'vip_waiting'
        ? zone.starts_at
        : zone?.state === 'vip_only'
          ? zone.vip_day.open
            ? zone.vip_day.ends_at
            : zone.vip_day.starts_at
          : null;
  if (!at) return null;
  const delay = Date.parse(at) - now.getTime();
  return delay > 0 && delay <= DAY_MS ? delay : null;
}

/** 当前选中的是栏目里的免费模型（且栏目开放）。 */
export function selectedFreeZoneModel(data: GetModelCatalogData | undefined, now = new Date()) {
  if (!data || !isFreeZoneOpen(data.free_zone, now)) return null;
  return data.free_zone?.models.find((model) => model.id === data.selected_model_id) ?? null;
}

function trialLength(access: PublicFreeZoneAccess): string {
  return access.trial_hours % 24 === 0
    ? `${access.trial_hours / 24} 天`
    : `${access.trial_hours} 小时`;
}

/**
 * 卡头的规则说明：按身份生成（新人 / 会员 / 非会员），后面接运营写的规则文字。
 * 福利期或旧后端（没有 access）只显示运营规则。
 */
export function freeZoneRulesText(zone: PublicFreeZone): string {
  const access = zone.access;
  const ops = zone.rules.trim();
  if (!access || access.audience === 'everyone') return ops;
  const weekday = freeZoneWeekdayLabel(access.vip_weekly.weekday);
  const welcome = access.vip_welcome_days;
  const lead =
    access.audience === 'trial'
      ? `新人专享 ${trialLength(access)}免费畅聊。体验结束后开通 VIP，${
          welcome > 0 ? `立享 ${welcome} 天畅聊，之后` : ''
        }每${weekday}畅聊。`
      : access.audience === 'vip'
        ? `VIP 专享：${welcome > 0 ? `开通或续费立享 ${welcome} 天畅聊，之后` : ''}每${formatVipWeeklyWindow(access.vip_weekly)}畅聊。`
        : `开通 VIP：${welcome > 0 ? `立享 ${welcome} 天免费畅聊，之后` : ''}每${weekday}畅聊。`;
  return ops ? `${lead}\n${ops}` : lead;
}

/** 卡头要不要挂 VIP 标签：会员在用或在等下一个畅聊日 */
export function isVipZone(zone: PublicFreeZone): boolean {
  return zone.access?.audience === 'vip';
}

export interface FreeZoneSwitchDivider {
  /** 原因标题；只有最近一次切换、且畅聊此刻对用户关闭时才有 */
  title: string | null;
  detail: string;
}

/**
 * 对话里「免费轮 → 付费轮」那一轮前的分隔线，键是这一轮第一条消息的 id。
 * 按每条回复的 credits_per_turn 判断（0 = 免费轮）；不知道的（旧数据、流式占位）跳过，不当成切换。
 * 切换原因不落库：最近一次切换按当前栏目状态写原因，更早的（含用户自己换模型）只写中性说明。
 */
export function freeZoneSwitchDividers(
  messages: readonly ChatMessage[],
  data: GetModelCatalogData | undefined,
  now = new Date()
): Record<string, FreeZoneSwitchDivider> {
  if (!data) return {};
  const firstOfTurn = new Map<number, string>();
  const switches: Array<{ turn: number; credits: number }> = [];
  let previousFree: boolean | null = null;
  for (const message of messages) {
    if (message.deleted) continue;
    if (!firstOfTurn.has(message.turn_index)) firstOfTurn.set(message.turn_index, message.id);
    const credits = message.credits_per_turn;
    if (message.role !== 'assistant' || credits === undefined) continue;
    if (previousFree === true && credits > 0) {
      switches.push({ turn: message.turn_index, credits });
    }
    previousFree = credits === 0;
  }
  const zone = data.free_zone ?? null;
  const closedNow = zone !== null && zone.access !== undefined && !isFreeZoneOpen(zone, now);
  const result: Record<string, FreeZoneSwitchDivider> = {};
  switches.forEach((item, index) => {
    const anchor = firstOfTurn.get(item.turn);
    if (!anchor) return;
    // 回复只存了上游模型名，档位按当前目录里同价的那一档认；认不出就只写价格。
    const tier = data.catalog.tiers.find(
      (entry) => (entry.payable_credits ?? entry.original_credits) === item.credits
    );
    const price = `${tier ? `${tier.label}模型，` : ''}每轮 ${item.credits} 星尘`;
    if (index === switches.length - 1 && closedNow && zone) {
      const next =
        zone.state === 'vip_waiting'
          ? ` · 下次畅聊：${formatFreeZoneTime(zone.starts_at, now)}`
          : '';
      result[anchor] = {
        title: zone.access?.audience === 'vip' ? '本次畅聊已结束' : '畅聊已结束',
        detail: `以下按${price}${next}`,
      };
    } else {
      result[anchor] = { title: null, detail: `以下改用${price}` };
    }
  });
  return result;
}
