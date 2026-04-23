/**
 * 从角色 id 稳定生成一个"房间色相"。
 * 用于让同一个角色在卡片、详情、对话页的氛围色保持一致——"她的房间"有固定颜色。
 *
 * 返回值范围：220 ~ 339（偏紫→玫红→暖色一带，避开冷青/草绿，夜间更贴身体感）。
 */
export function hueShiftFromId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) {
    h = (h * 31 + id.charCodeAt(i)) % 360;
  }
  return 220 + (h % 120);
}

/** 基于 hue 生成一个可直接用作 background 的径向渐变（角色卡/详情 hero 复用） */
export function characterRoomGradient(id: string): string {
  const hue = hueShiftFromId(id);
  return `radial-gradient(120% 80% at 70% 30%, hsl(${hue} 55% 28% / 0.92), hsl(${hue - 20} 40% 10% / 1) 70%)`;
}
