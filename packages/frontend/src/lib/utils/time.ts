// 把 ISO 时间戳转为耳语感中文文案，供抽屉、对话页、列表使用
// 规则：不用"X 分钟前 / X 小时前"这种机械表达；用"刚刚 / 今晚 / 昨夜 / 上周四"这种带氛围的措辞

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function isSameDate(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** 一天里这个时间属于"今晚 / 今早 / 下午 / 中午"中的哪个语境词。
 *  这个产品的基调偏深夜，默认靠近"晚"。 */
function partOfDay(h: number): string {
  if (h >= 22 || h < 4) return '今晚';
  if (h >= 18) return '今晚';
  if (h >= 12) return '下午';
  if (h >= 6) return '今早';
  return '凌晨';
}

/** 昨天那个时间属于"昨夜 / 昨天"。 */
function yesterdayWord(h: number): string {
  if (h >= 22 || h < 4) return '昨夜';
  if (h >= 18) return '昨夜';
  return '昨天';
}

export function formatWhisperTime(iso: string, now: Date = new Date()): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '';

  const diffMs = now.getTime() - t.getTime();
  const diffMin = Math.floor(diffMs / 60_000);

  if (diffMin < 1) return '刚刚';
  if (diffMin < 30) return `${diffMin} 分钟前`;

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86_400_000);

  const hh = pad2(t.getHours());
  const mm = pad2(t.getMinutes());
  const clock = `${hh}:${mm}`;

  if (isSameDate(t, now)) {
    return `${partOfDay(t.getHours())} ${clock}`;
  }
  if (isSameDate(t, yesterday)) {
    return `${yesterdayWord(t.getHours())} ${clock}`;
  }

  const dayDiff = Math.floor(
    (today.getTime() - new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime()) / 86_400_000
  );

  if (dayDiff < 7) {
    return `上${WEEKDAYS[t.getDay()]}`;
  }
  if (dayDiff < 30) {
    return `${Math.floor(dayDiff / 7)} 周前`;
  }
  if (t.getFullYear() === now.getFullYear()) {
    return `${t.getMonth() + 1} 月 ${t.getDate()} 日`;
  }
  return `${t.getFullYear()} 年 ${t.getMonth() + 1} 月`;
}
