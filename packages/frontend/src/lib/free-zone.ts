import type { GetModelCatalogData, PublicFreeZone } from '@miniapp/shared';

/**
 * 畅聊栏目的展示判断（纯函数）。栏目状态由后端算好下发，这里只负责：
 * 时间写成人话、按本地时钟兜底「已过结束时间就当未开放」、算下一个需要重新拉目录的时间点。
 */

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const DAY_MS = 24 * 60 * 60 * 1000;

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

/** 后端说开放、且按本地时钟还没过结束时间，才算开放：防止缓存里的旧状态让人误选。 */
export function isFreeZoneOpen(zone: PublicFreeZone | null | undefined, now = new Date()) {
  return zone?.state === 'open' && Date.parse(zone.ends_at) > now.getTime();
}

export function freeZoneStatusText(zone: PublicFreeZone, now = new Date()): string {
  switch (zone.state) {
    case 'open':
      return isFreeZoneOpen(zone, now)
        ? `${formatFreeZoneTime(zone.ends_at, now)} 结束`
        : '暂未开放';
    case 'not_started':
      return `${formatFreeZoneTime(zone.starts_at, now)} 开始`;
    case 'own_card_only':
      return '仅限自创角色卡';
    case 'no_models':
      return '暂未开放';
  }
}

/** 点了未开放栏目里的模型时的就地提示。 */
export function freeZoneClosedHint(zone: PublicFreeZone, now = new Date()): string {
  switch (zone.state) {
    case 'not_started':
      return `畅聊模型还没开放，${formatFreeZoneTime(zone.starts_at, now)} 开始`;
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
    zone?.state === 'open' ? zone.ends_at : zone?.state === 'not_started' ? zone.starts_at : null;
  if (!at) return null;
  const delay = Date.parse(at) - now.getTime();
  return delay > 0 && delay <= DAY_MS ? delay : null;
}

/** 当前选中的是栏目里的免费模型（且栏目开放）。 */
export function selectedFreeZoneModel(data: GetModelCatalogData | undefined, now = new Date()) {
  if (!data || !isFreeZoneOpen(data.free_zone, now)) return null;
  return data.free_zone?.models.find((model) => model.id === data.selected_model_id) ?? null;
}
