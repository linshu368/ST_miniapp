'use client';

import { ChevronDown, X } from 'lucide-react';
import { useState } from 'react';
import type { ImagePlazaAspectRatio, ImagePlazaModel } from '@miniapp/shared';
import { Sheet, SheetClose, SheetContent, SheetTitle } from '@/components/ui/sheet';

type ResolutionId = '1K' | '2K' | 'fixed';
type ExpandedSetting = 'ratio' | 'resolution' | null;

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
  '1:1': '方形 1:1',
  '2:3': '竖版 2:3',
  '3:2': '横版 3:2',
  '3:4': '竖版 3:4',
  '4:3': '横版 4:3',
  '4:5': '海报 4:5',
  '9:16': '竖屏 9:16',
  '16:9': '宽屏 16:9',
  '21:9': '超宽屏 21:9',
};

export function StudioSettingsDialog(props: StudioSettingsDialogProps) {
  const [expanded, setExpanded] = useState<ExpandedSetting>(null);
  const showResolution = props.model.resolutions.length > 1;
  const toggle = (setting: Exclude<ExpandedSetting, null>) =>
    setExpanded((current) => (current === setting ? null : setting));

  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent
        side="bottom"
        aria-describedby={undefined}
        overlayClassName="bg-black/80 backdrop-blur-none motion-reduce:data-[state=open]:animate-none motion-reduce:data-[state=closed]:animate-none"
        className="chat-scroll-area mx-auto max-h-[76dvh] w-full max-w-3xl overflow-y-auto rounded-t-[1.25rem] border-border bg-card p-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] shadow-[0_-18px_42px_rgba(0,0,0,0.3)] motion-reduce:transition-none motion-reduce:data-[state=open]:animate-none motion-reduce:data-[state=closed]:animate-none"
      >
        <div className="overflow-hidden rounded-2xl border border-border bg-card">
          <div className="flex items-center gap-2 border-b border-border px-4 py-3 text-left">
            <SheetTitle className="flex-1 text-base font-extrabold leading-none tracking-tight">
              设置
            </SheetTitle>
            <button
              type="button"
              onClick={() => {
                props.onReset();
                setExpanded(null);
              }}
              className="min-h-9 rounded-lg px-2 text-sm font-bold text-primary transition active:bg-background"
            >
              重置
            </button>
            <SheetClose
              aria-label="关闭设置"
              className="grid size-9 place-items-center rounded-lg text-muted-foreground transition active:bg-background"
            >
              <X className="size-5" />
            </SheetClose>
          </div>

          <SettingSection
            label="画幅"
            expanded={expanded === 'ratio'}
            control={
              <SelectorButton expanded={expanded === 'ratio'} onClick={() => toggle('ratio')}>
                <AspectShape value={props.aspectRatio} />
                <span>{ASPECT_LABELS[props.aspectRatio]}</span>
              </SelectorButton>
            }
          >
            {props.model.aspect_ratios.map((value) => (
              <ChoiceButton
                key={value}
                selected={value === props.aspectRatio}
                onClick={() => {
                  props.onAspectRatioChange(value);
                  setExpanded(null);
                }}
              >
                <AspectShape value={value} />
                {ASPECT_LABELS[value]}
              </ChoiceButton>
            ))}
          </SettingSection>

          {showResolution ? (
            <SettingSection
              label="分辨率"
              expanded={expanded === 'resolution'}
              control={
                <SelectorButton
                  expanded={expanded === 'resolution'}
                  onClick={() => toggle('resolution')}
                >
                  <span>
                    {props.model.resolutions.find((item) => item.id === props.resolution)?.label ??
                      props.resolution}
                    {props.model.resolutions[0]?.id === props.resolution ? '（默认）' : ''}
                  </span>
                </SelectorButton>
              }
            >
              {props.model.resolutions.map((item, index) => (
                <ChoiceButton
                  key={item.id}
                  selected={item.id === props.resolution}
                  onClick={() => {
                    props.onResolutionChange(item.id);
                    setExpanded(null);
                  }}
                >
                  {item.label}
                  {index === 0 ? '（默认）' : ''}
                </ChoiceButton>
              ))}
            </SettingSection>
          ) : null}

          <ToggleRow
            label="启用推理"
            checked={props.reasoning}
            onChange={props.onReasoningChange}
          />
          <ToggleRow
            label="自动优化提示词"
            checked={props.autoOptimize}
            onChange={props.onAutoOptimizeChange}
            last
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}

function SettingSection(props: {
  label: string;
  expanded: boolean;
  control: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="border-b border-border">
      <div
        className={`flex items-center justify-between gap-3 px-4 ${
          props.expanded ? 'pb-2 pt-3.5' : 'py-3.5'
        }`}
      >
        <span className="text-sm font-bold">{props.label}</span>
        {props.control}
      </div>
      {props.expanded ? (
        <div className="flex flex-wrap gap-2 px-4 pb-3.5">{props.children}</div>
      ) : null}
    </section>
  );
}

function SelectorButton(props: {
  expanded: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-expanded={props.expanded}
      onClick={props.onClick}
      className="inline-flex min-h-10 min-w-32 items-center justify-between gap-2 rounded-xl border border-border bg-background/45 px-3 text-xs font-bold text-foreground transition active:bg-background"
    >
      <span className="inline-flex items-center gap-2">{props.children}</span>
      <ChevronDown
        className={`size-3 text-muted-foreground transition ${props.expanded ? 'rotate-180' : ''}`}
      />
    </button>
  );
}

function AspectShape({ value }: { value: ImagePlazaAspectRatio }) {
  const [width = 1, height = 1] = value.split(':').map(Number);
  const scale = 22 / Math.max(width, height);
  return (
    <span aria-hidden className="flex size-6 shrink-0 items-center justify-center">
      <span
        className="block rounded-[2px] border border-current bg-primary/10"
        style={{ width: width * scale, height: height * scale }}
      />
    </span>
  );
}

function ChoiceButton(props: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={props.selected}
      onClick={props.onClick}
      className={`inline-flex min-h-11 items-center gap-2 rounded-xl border px-3 py-1.5 text-xs transition ${
        props.selected
          ? 'border-primary bg-primary font-bold text-primary-foreground'
          : 'border-border bg-background/45 text-muted-foreground'
      }`}
    >
      {props.children}
    </button>
  );
}

function ToggleRow(props: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  last?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between gap-3 px-4 py-3.5 ${props.last ? '' : 'border-b border-border'}`}
    >
      <span className="text-sm font-bold">{props.label}</span>
      <button
        type="button"
        role="switch"
        aria-label={props.label}
        aria-checked={props.checked}
        onClick={() => props.onChange(!props.checked)}
        className={`relative h-[27px] w-[46px] shrink-0 rounded-full border transition ${
          props.checked ? 'border-primary bg-primary' : 'border-border bg-muted'
        }`}
      >
        <span
          className={`absolute top-0.5 size-[21px] rounded-full transition-all ${
            props.checked ? 'left-[21px] bg-primary-foreground' : 'left-0.5 bg-foreground'
          }`}
        />
      </button>
    </div>
  );
}
