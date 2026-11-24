'use client';

import type { CSSProperties } from 'react';
import type { PublicDriveModes } from '@miniapp/shared';

import { cn } from '@/lib/utils';

/**
 * 线的两端：香槟金代表“你”，玫瑰粉代表“角色”。两色亮度、饱和度相同，只有色相不同，
 * 四档之间没有高低之分；每档取自己在线上位置的颜色。
 */
const YOU_HUE = 34;
const ROLE_HUE = 330;

function hueAt(index: number, count: number): number {
  const t = count <= 1 ? 0 : index / (count - 1);
  // 从 34° 经 0° 走到 330°（-64°），不绕到冷色。
  return (YOU_HUE - t * (YOU_HUE + 360 - ROLE_HUE) + 360) % 360;
}

function modeColor(index: number, count: number): string {
  return `hsl(${hueAt(index, count).toFixed(1)} 55% var(--drive-lightness))`;
}

interface ChatDriveModePickerProps {
  driveModes: PublicDriveModes;
  activeId: string | undefined;
  pendingId: string | null;
  failed: boolean;
  onChange: (id: string) => void;
}

/** 回复偏好里的「剧情模式」：一排四档 + 两色渐变线标位置 + 一句白话说明。 */
export function ChatDriveModePicker({
  driveModes,
  activeId,
  pendingId,
  failed,
  onChange,
}: ChatDriveModePickerProps) {
  const modes = driveModes.modes;
  if (modes.length === 0) return null;
  const selectedId = pendingId ?? activeId ?? driveModes.default_mode_id;
  const selectedIndex = Math.max(
    0,
    modes.findIndex((mode) => mode.id === selectedId)
  );
  const selected = modes[selectedIndex];
  const count = modes.length;
  const youColor = modeColor(0, Math.max(count, 2));
  const roleColor = modeColor(Math.max(count, 2) - 1, Math.max(count, 2));
  const columns = { gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` };

  return (
    <section aria-label="剧情模式" className="pb-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold text-foreground">剧情模式</h3>
        <span className="text-[10px] text-muted-foreground">谁来推剧情</span>
      </div>
      <div className="mb-1 flex justify-between text-[10px]" aria-hidden>
        <span style={{ color: youColor }}>你来带</span>
        <span style={{ color: roleColor }}>角色来带</span>
      </div>
      <div className="relative mb-1.5 h-3.5" aria-hidden>
        <div
          className="absolute top-1.5 h-0.5 rounded-full opacity-75"
          style={{
            left: `${50 / count}%`,
            right: `${50 / count}%`,
            background: `linear-gradient(90deg, ${youColor}, ${roleColor})`,
          }}
        />
        <div className="absolute inset-0 grid" style={columns}>
          {modes.map((mode, index) => (
            <span
              key={mode.id}
              className={cn(
                'mt-[3px] size-2 justify-self-center rounded-full border-[1.5px] bg-background transition-[background-color,box-shadow] duration-150 motion-reduce:transition-none',
                index === selectedIndex && 'shadow-[0_0_0_3px_var(--dot-ring)]'
              )}
              style={
                {
                  borderColor: modeColor(index, count),
                  backgroundColor: index === selectedIndex ? modeColor(index, count) : undefined,
                  '--dot-ring': `hsl(${hueAt(index, count).toFixed(1)} 55% var(--drive-lightness) / 0.22)`,
                } as CSSProperties
              }
            />
          ))}
        </div>
      </div>
      <div className="grid gap-1.5" style={columns} role="radiogroup" aria-label="剧情模式">
        {modes.map((mode, index) => {
          const active = index === selectedIndex;
          const color = modeColor(index, count);
          return (
            <button
              key={mode.id}
              type="button"
              role="radio"
              aria-checked={active}
              aria-busy={mode.id === pendingId}
              disabled={pendingId !== null}
              onClick={() => onChange(mode.id)}
              className={cn(
                'min-h-9 min-w-0 break-words rounded-lg border px-1 py-2 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-wait',
                active
                  ? 'border-current'
                  : 'border-border bg-secondary/35 text-muted-foreground hover:bg-secondary'
              )}
              style={
                active
                  ? {
                      color,
                      borderColor: `hsl(${hueAt(index, count).toFixed(1)} 55% var(--drive-lightness) / 0.45)`,
                      backgroundColor: `hsl(${hueAt(index, count).toFixed(1)} 55% var(--drive-lightness) / 0.12)`,
                    }
                  : undefined
              }
            >
              {mode.ui_label}
            </button>
          );
        })}
      </div>
      {selected ? (
        <p className="mt-2 rounded-[10px] bg-secondary/50 px-3 py-2.5 text-[13px] leading-5 text-foreground">
          <b className="font-semibold" style={{ color: modeColor(selectedIndex, count) }}>
            {selected.ui_label}
          </b>
          {selected.description ? `：${selected.description}` : null}
        </p>
      ) : null}
      {failed ? (
        <p className="mt-1.5 text-[10px] text-destructive" role="alert">
          未保存，请重试
        </p>
      ) : null}
    </section>
  );
}
