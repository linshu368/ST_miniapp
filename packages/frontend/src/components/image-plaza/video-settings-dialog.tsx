'use client';

import { X } from 'lucide-react';
import type { VideoPlazaModel } from '@miniapp/shared';
import { Sheet, SheetClose, SheetContent, SheetTitle } from '@/components/ui/sheet';

function Choices<T extends string | number>(props: {
  label: string;
  values: readonly T[];
  value: T;
  render?: (value: T) => string;
  onChange: (value: T) => void;
}) {
  return (
    <section className="border-b border-border px-4 py-3">
      <p className="mb-2 text-sm font-bold">{props.label}</p>
      <div className="flex flex-wrap gap-2">
        {props.values.map((value) => (
          <button
            key={String(value)}
            type="button"
            aria-pressed={value === props.value}
            onClick={() => props.onChange(value)}
            className={`min-h-10 rounded-xl border px-3 text-xs ${value === props.value ? 'border-primary bg-primary text-primary-foreground' : 'border-border'}`}
          >
            {props.render?.(value) ?? String(value)}
          </button>
        ))}
      </div>
    </section>
  );
}

export function VideoSettingsDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  model: VideoPlazaModel;
  duration: number;
  resolution: string;
  aspectRatio: string | null;
  audio: boolean;
  onDurationChange: (value: number) => void;
  onResolutionChange: (value: string) => void;
  onAspectRatioChange: (value: string | null) => void;
  onAudioChange: (value: boolean) => void;
  onReset: () => void;
}) {
  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent
        side="bottom"
        aria-describedby={undefined}
        className="mx-auto max-h-[76dvh] w-full max-w-3xl overflow-y-auto rounded-t-3xl p-3"
      >
        <div className="overflow-hidden rounded-2xl border border-border">
          <div className="flex items-center border-b border-border px-4 py-3">
            <SheetTitle className="flex-1">视频设置</SheetTitle>
            <button
              type="button"
              onClick={props.onReset}
              className="px-3 text-sm font-bold text-primary"
            >
              重置
            </button>
            <SheetClose aria-label="关闭" className="grid size-9 place-items-center">
              <X className="size-5" />
            </SheetClose>
          </div>
          <Choices
            label="时长"
            values={props.model.durations}
            value={props.duration}
            render={(value) => `${value} 秒`}
            onChange={props.onDurationChange}
          />
          <Choices
            label="清晰度"
            values={props.model.resolutions}
            value={props.resolution}
            render={(value) => value.toUpperCase()}
            onChange={props.onResolutionChange}
          />
          {props.model.aspect_ratios.length ? (
            <Choices
              label="画面比例"
              values={props.model.aspect_ratios}
              value={props.aspectRatio ?? props.model.aspect_ratios[0]!}
              onChange={props.onAspectRatioChange}
            />
          ) : null}
          <section className="flex items-center justify-between px-4 py-4">
            <div>
              <p className="text-sm font-bold">生成声音</p>
              {!props.model.audio_configurable ? (
                <p className="text-xs text-muted-foreground">
                  固定{props.model.default_audio ? '有声' : '无声'}
                </p>
              ) : null}
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={props.audio}
              disabled={!props.model.audio_configurable}
              onClick={() => props.onAudioChange(!props.audio)}
              className={`rounded-full px-4 py-2 text-xs font-bold ${props.audio ? 'bg-primary text-primary-foreground' : 'bg-muted'} disabled:opacity-60`}
            >
              {props.audio ? '开启' : '关闭'}
            </button>
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}
