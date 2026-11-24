'use client';

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Ban, Loader2, Plus, X } from 'lucide-react';

import { lobbyImageUrl } from '@/components/characters/character-card';
import { CHAT_APPEARANCE, useActiveBackground } from '@/hooks/use-chat-background';
import {
  COVER_IMAGE,
  effectiveBackground,
  NO_IMAGE,
  type BackgroundScope,
} from '@/lib/appearance/chat-background';
import { MAX_IMAGES } from '@/lib/appearance/image-store';
import { cn } from '@/lib/utils';
import { useChatBackgroundStore } from '@/stores/chat-background-store';
import { REPLY_SIZES, useReplySizeStore } from '@/stores/reply-size-store';

/** 正在拖的滑杆；拖动时面板其余部分隐去，露出后面的真实对话。 */
export type AdjustingRow = 'light' | 'size' | null;

/** 拖动时要隐去的块都带这个类（面板根节点在 ChatToolsPanel 里打 data-adjusting）。 */
export const HIDE_WHILE_ADJUSTING =
  'transition-opacity duration-150 group-data-[adjusting]/tools:pointer-events-none group-data-[adjusting]/tools:opacity-0 motion-reduce:transition-none';

const SCOPES: ReadonlyArray<{ key: BackgroundScope; label: string }> = [
  { key: 'character', label: '仅此角色' },
  { key: 'all', label: '全部对话' },
];

export function ChatLookSettings({
  characterId,
  coverSource,
  adjusting,
  onAdjustingChange,
}: {
  characterId: string;
  coverSource: string | null;
  adjusting: AdjustingRow;
  onAdjustingChange: (row: AdjustingRow) => void;
}) {
  const openPanel = useChatBackgroundStore((state) => state.openPanel);
  useEffect(() => openPanel(characterId), [characterId, openPanel]);

  // 松手可能发生在滑杆外面，统一在窗口上收尾。
  useEffect(() => {
    if (!adjusting) return;
    const end = () => onAdjustingChange(null);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
  }, [adjusting, onAdjustingChange]);

  return (
    <div className="divide-y divide-border/70 group-data-[adjusting]/tools:divide-transparent">
      <section aria-label="背景" className="pb-3.5">
        <ScopeSwitch characterId={characterId} />
        <ImagePicker characterId={characterId} coverSource={coverSource} />
        <LightRow
          characterId={characterId}
          coverSource={coverSource}
          adjusting={adjusting}
          onAdjustingChange={onAdjustingChange}
        />
      </section>
      <section aria-label="字号" className="pt-3.5">
        <SizeRow adjusting={adjusting} onAdjustingChange={onAdjustingChange} />
      </section>
    </div>
  );
}

function ScopeSwitch({ characterId }: { characterId: string }) {
  const scope = useChatBackgroundStore((state) => state.scope);
  const pickScope = useChatBackgroundStore((state) => state.pickScope);
  return (
    <div className={cn('mb-2.5 flex min-h-9 items-center gap-3', HIDE_WHILE_ADJUSTING)}>
      <h3 className="text-[14px] font-semibold text-foreground">背景</h3>
      <div
        role="group"
        aria-label="适用范围"
        className="ml-auto flex rounded-full bg-secondary p-[3px]"
      >
        {SCOPES.map((item) => (
          <button
            key={item.key}
            type="button"
            aria-pressed={scope === item.key}
            onClick={() => pickScope(characterId, item.key)}
            className={cn(
              'min-h-[34px] rounded-full px-3 text-[12px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
              scope === item.key
                ? 'bg-background font-semibold text-foreground shadow-sm'
                : 'text-muted-foreground'
            )}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}

const TILE_CLASS =
  'relative grid h-[78px] w-[60px] shrink-0 place-items-center overflow-hidden rounded-[13px] bg-secondary bg-cover bg-center text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60';

function Tile({
  label,
  selected,
  url,
  onSelect,
  children,
}: {
  label: string;
  selected: boolean;
  url?: string;
  onSelect: () => void;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        TILE_CLASS,
        "after:pointer-events-none after:absolute after:inset-0 after:rounded-[13px] after:content-['']",
        selected
          ? 'after:ring-2 after:ring-inset after:ring-primary'
          : 'after:ring-1 after:ring-inset after:ring-border'
      )}
      style={url ? { backgroundImage: `url("${url}")` } : undefined}
    >
      {children}
    </button>
  );
}

function ImagePicker({
  characterId,
  coverSource,
}: {
  characterId: string;
  coverSource: string | null;
}) {
  const prefs = useChatBackgroundStore((state) => state.prefs);
  const images = useChatBackgroundStore((state) => state.images);
  const pick = useChatBackgroundStore((state) => state.pick);
  const addImage = useChatBackgroundStore((state) => state.addImage);
  const removeImage = useChatBackgroundStore((state) => state.removeImage);
  const inputRef = useRef<HTMLInputElement>(null);
  const [adding, setAdding] = useState(false);
  const [failed, setFailed] = useState(false);
  const selected = effectiveBackground(prefs, characterId)?.img ?? NO_IMAGE;

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    setFailed(false);
    setAdding(true);
    const added = await addImage(characterId, file);
    setAdding(false);
    setFailed(!added);
  };

  return (
    <div className={HIDE_WHILE_ADJUSTING}>
      <div className="chat-scroll-area -mx-4 flex gap-2 overflow-x-auto overscroll-x-contain px-4 py-0.5">
        <Tile
          label="不用背景"
          selected={selected === NO_IMAGE}
          onSelect={() => pick(characterId, NO_IMAGE)}
        >
          <span className="grid justify-items-center gap-1.5 text-[11px]">
            <Ban className="size-5" aria-hidden />无
          </span>
        </Tile>
        {coverSource ? (
          <Tile
            label="用角色封面"
            selected={selected === COVER_IMAGE}
            url={lobbyImageUrl(coverSource)}
            onSelect={() => pick(characterId, COVER_IMAGE)}
          >
            <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/65 to-transparent pb-1 pt-3 text-center text-[10.5px] text-white">
              封面
            </span>
          </Tile>
        ) : null}
        {images?.map((image, index) => (
          <div key={image.id} className="relative shrink-0">
            <Tile
              label={`用第 ${index + 1} 张图`}
              selected={selected === image.id}
              url={image.url}
              onSelect={() => pick(characterId, image.id)}
            />
            {selected === image.id ? (
              <button
                type="button"
                aria-label="删掉这张图"
                onClick={() => removeImage(image.id)}
                className="absolute -right-1 -top-1 grid size-8 place-items-center focus-visible:outline-none"
              >
                <span className="grid size-5 place-items-center rounded-full bg-black/65 text-white">
                  <X className="size-3" aria-hidden />
                </span>
              </button>
            ) : null}
          </div>
        ))}
        {images && images.length < MAX_IMAGES ? (
          <button
            type="button"
            aria-label="从相册选"
            disabled={adding}
            onClick={() => inputRef.current?.click()}
            className={cn(TILE_CLASS, 'border border-dashed border-primary/55 text-primary')}
          >
            {adding ? (
              <Loader2 className="size-5 animate-spin" aria-hidden />
            ) : (
              <Plus className="size-[22px]" aria-hidden />
            )}
          </button>
        ) : null}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          void importFile(file);
        }}
      />
      {failed ? (
        <p role="alert" className="mt-2 text-[12px] text-destructive">
          这张图用不了，换一张试试
        </p>
      ) : null}
    </div>
  );
}

const RANGE_CLASS =
  'h-11 w-full cursor-pointer touch-none appearance-none bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40 rounded-xl';

function rowClass(live: boolean) {
  return live
    ? '-mx-3.5 rounded-[18px] bg-card px-3.5 shadow-[0_8px_24px_rgb(0_0_0/28%)]'
    : HIDE_WHILE_ADJUSTING;
}

function rangeFill(ratio: number): CSSProperties & Record<'--fill', string> {
  return { '--fill': `${Math.round(ratio * 100)}%` };
}

function LightRow({
  characterId,
  coverSource,
  adjusting,
  onAdjustingChange,
}: {
  characterId: string;
  coverSource: string | null;
  adjusting: AdjustingRow;
  onAdjustingChange: (row: AdjustingRow) => void;
}) {
  const setLight = useChatBackgroundStore((state) => state.light);
  const background = useActiveBackground(characterId, coverSource);
  if (!background) return null;
  return (
    <div
      className={cn(
        'mt-2 grid min-h-12 grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-3 text-[12px] text-muted-foreground',
        rowClass(adjusting === 'light')
      )}
    >
      <span className="text-[13px] font-semibold text-foreground">采光</span>
      <span>看清字</span>
      <input
        type="range"
        min={0}
        max={100}
        value={background.light}
        aria-label="采光"
        onPointerDown={() => onAdjustingChange('light')}
        onChange={(event) =>
          setLight(characterId, CHAT_APPEARANCE, Number(event.currentTarget.value))
        }
        className={cn('look-range', RANGE_CLASS)}
        style={rangeFill(background.light / 100)}
      />
      <span>看清图</span>
    </div>
  );
}

function SizeRow({
  adjusting,
  onAdjustingChange,
}: {
  adjusting: AdjustingRow;
  onAdjustingChange: (row: AdjustingRow) => void;
}) {
  const level = useReplySizeStore((state) => state.level);
  const setLevel = useReplySizeStore((state) => state.setLevel);
  const last = REPLY_SIZES.length - 1;
  return (
    <div
      className={cn(
        'grid min-h-12 grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-2 text-muted-foreground',
        rowClass(adjusting === 'size')
      )}
    >
      <span className="text-[13px] font-semibold text-foreground">字号</span>
      <button
        type="button"
        aria-label="小一档"
        disabled={level === 0}
        onClick={() => setLevel(level - 1)}
        className="grid h-11 w-9 place-items-center text-[13px] disabled:opacity-40"
      >
        A
      </button>
      <div className="look-ticks relative">
        <input
          type="range"
          min={0}
          max={last}
          step={1}
          value={level}
          aria-label="字号"
          aria-valuetext={`${REPLY_SIZES[level]} 像素`}
          onPointerDown={() => onAdjustingChange('size')}
          onChange={(event) => setLevel(Number(event.currentTarget.value))}
          className={cn('look-range relative', RANGE_CLASS)}
          style={rangeFill(level / last)}
        />
      </div>
      <button
        type="button"
        aria-label="大一档"
        disabled={level === last}
        onClick={() => setLevel(level + 1)}
        className="grid h-11 w-9 place-items-center text-[24px] leading-none text-foreground disabled:opacity-40"
      >
        A
      </button>
    </div>
  );
}
