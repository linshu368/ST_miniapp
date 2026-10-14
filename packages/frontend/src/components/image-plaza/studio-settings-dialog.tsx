'use client';

import { Sparkles, X } from 'lucide-react';
import type { ImagePlazaAspectRatio, ImagePlazaModel } from '@miniapp/shared';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';

type ResolutionId = '1K' | '2K' | 'fixed';

interface StudioSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  model: ImagePlazaModel;
  aspectRatio: ImagePlazaAspectRatio;
  onAspectRatioChange: (value: ImagePlazaAspectRatio) => void;
  resolution: ResolutionId;
  onResolutionChange: (value: ResolutionId) => void;
  reasoning: boolean;
  onReasoningChange: (value: boolean) => void;
  autoOptimize: boolean;
  onAutoOptimizeChange: (value: boolean) => void;
  onReset: () => void;
}

const ASPECT_LABELS: Record<ImagePlazaAspectRatio, string> = {
  '1:1': 'Square (1:1)',
  '2:3': 'Portrait (2:3)',
  '3:2': 'Landscape (3:2)',
  '3:4': 'Portrait (3:4)',
  '4:3': 'Landscape (4:3)',
  '4:5': 'Portrait (4:5)',
  '9:16': 'Portrait (9:16)',
  '16:9': 'Landscape (16:9)',
  '21:9': 'Wide (21:9)',
};

export function StudioSettingsDialog(props: StudioSettingsDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="bottom-0 top-auto w-[calc(100%-1rem)] max-w-2xl translate-y-0 gap-0 overflow-hidden rounded-t-[2rem] border-border bg-card p-0 sm:bottom-auto sm:top-1/2 sm:-translate-y-1/2 sm:rounded-[2rem]"
      >
        <DialogHeader className="flex-row items-center justify-between space-y-0 border-b border-border px-6 py-6 text-left">
          <DialogTitle className="text-xl font-black">设置</DialogTitle>
          <div className="flex items-center gap-5">
            <button
              type="button"
              onClick={props.onReset}
              className="text-sm font-black text-primary underline decoration-primary/35 underline-offset-4"
            >
              重置
            </button>
            <DialogClose
              aria-label="关闭设置"
              className="grid size-10 place-items-center rounded-full text-muted-foreground transition hover:bg-background hover:text-foreground"
            >
              <X className="size-5" />
            </DialogClose>
          </div>
        </DialogHeader>

        <div className="divide-y divide-border">
          <SettingRow label="图片风格">
            <div className="flex h-14 min-w-40 items-center gap-3 rounded-2xl border border-border bg-background/45 px-4 font-bold">
              <span className="grid size-8 place-items-center rounded-xl bg-primary/10 text-primary">
                <Sparkles className="size-4" />
              </span>
              <span>None</span>
            </div>
          </SettingRow>

          <SettingRow label="长宽比">
            <select
              aria-label="长宽比"
              value={props.aspectRatio}
              onChange={(event) =>
                props.onAspectRatioChange(event.target.value as ImagePlazaAspectRatio)
              }
              className="h-14 min-w-44 rounded-2xl border border-border bg-background/45 px-4 text-right text-sm font-black outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              {props.model.aspect_ratios.map((value) => (
                <option key={value} value={value}>
                  {ASPECT_LABELS[value]}
                </option>
              ))}
            </select>
          </SettingRow>

          <SettingRow label="分辨率">
            <select
              aria-label="分辨率"
              value={props.resolution}
              onChange={(event) => props.onResolutionChange(event.target.value as ResolutionId)}
              className="h-14 min-w-40 rounded-2xl border border-border bg-background/45 px-4 text-right text-sm font-black outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              {props.model.resolutions.map((item, index) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                  {index === 0 ? '（默认）' : ''}
                </option>
              ))}
            </select>
          </SettingRow>

          <SettingRow label="启用推理">
            <Switch
              aria-label="启用推理"
              checked={props.reasoning}
              onCheckedChange={props.onReasoningChange}
              className="h-8 w-14 data-[state=checked]:bg-primary data-[state=unchecked]:bg-muted [&>span]:size-7 [&>span]:data-[state=checked]:translate-x-6"
            />
          </SettingRow>

          <SettingRow label="自动优化提示词">
            <Switch
              aria-label="自动优化提示词"
              checked={props.autoOptimize}
              onCheckedChange={props.onAutoOptimizeChange}
              className="h-8 w-14 data-[state=checked]:bg-primary data-[state=unchecked]:bg-muted [&>span]:size-7 [&>span]:data-[state=checked]:translate-x-6"
            />
          </SettingRow>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SettingRow(props: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-28 items-center justify-between gap-4 px-6 py-5">
      <span className="text-base font-black">{props.label}</span>
      {props.children}
    </div>
  );
}
