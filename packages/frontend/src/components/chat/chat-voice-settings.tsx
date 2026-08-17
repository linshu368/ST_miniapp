'use client';

import { useMemo } from 'react';
import { Check, Gauge, Loader2, Mic } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useVoiceConfigQuery, usePatchVoiceConfigMutation } from '@/lib/api/voice';
import { ToolRow } from './chat-tool-row';

/**
 * 工具箱「语音设置」。与生成偏好同域：用户级配置，对所有角色生效。
 *
 * 音色列表放在二级页而不是平铺在这里——十几个音色平铺会把抽屉撑满，
 * 而这一栏之后还要放图片设置之外的其它项。
 */
export function ChatVoiceSettings({ onOpenVoicePicker }: { onOpenVoicePicker: () => void }) {
  const query = useVoiceConfigQuery();
  const patch = usePatchVoiceConfigMutation();

  const config = query.data?.config;
  const rates = query.data?.playback_rates ?? [];
  const currentVoiceLabel = useMemo(
    () => query.data?.voices.find((voice) => voice.id === config?.voice_id)?.label,
    [config?.voice_id, query.data?.voices]
  );

  if (query.isError) return <VoiceSettingsUnavailable />;
  if (query.isLoading || !config) return <VoiceSettingsLoading />;

  return (
    <div className="space-y-5">
      <ToolRow
        icon={Mic}
        title="默认声音"
        hint={currentVoiceLabel ?? '选择角色说话的声音'}
        onClick={onOpenVoicePicker}
      />

      <section>
        <div className="mb-2 flex items-center gap-1.5">
          <Gauge className="size-3.5 text-muted-foreground" aria-hidden />
          <h3 className="text-[13px] font-semibold text-foreground">播放速度</h3>
        </div>
        <div
          className="grid gap-2"
          style={{
            gridTemplateColumns: `repeat(${Math.min(rates.length || 1, 4)}, minmax(0, 1fr))`,
          }}
        >
          {rates.map((rate) => {
            const active = rate === config.playback_rate;
            return (
              <button
                key={rate}
                type="button"
                disabled={patch.isPending}
                onClick={() => patch.mutate({ playback_rate: rate })}
                className={cn(
                  'rounded-xl border py-2 text-[13px] font-medium transition-colors disabled:opacity-55',
                  active
                    ? 'border-primary/40 bg-primary/10 text-primary'
                    : 'border-border bg-card text-muted-foreground hover:bg-secondary'
                )}
              >
                {formatRate(rate)}
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
          对已生成的语音立即生效
        </p>
      </section>
    </div>
  );
}

/** 音色二级页。选完即返回，省掉一次「确定」 */
export function ChatVoicePicker({ onPicked }: { onPicked: () => void }) {
  const query = useVoiceConfigQuery();
  const patch = usePatchVoiceConfigMutation();

  const groups = useMemo(() => {
    const byGroup = new Map<string, { id: string; label: string }[]>();
    for (const voice of query.data?.voices ?? []) {
      const list = byGroup.get(voice.group) ?? [];
      list.push({ id: voice.id, label: voice.label });
      byGroup.set(voice.group, list);
    }
    return [...byGroup.entries()];
  }, [query.data?.voices]);

  const selectedVoiceId = query.data?.config.voice_id;

  if (query.isError) return <VoiceSettingsUnavailable />;
  if (query.isLoading || !query.data) return <VoiceSettingsLoading />;

  return (
    <div className="space-y-4">
      <p className="text-[11px] leading-snug text-muted-foreground">
        只影响之后生成的语音，已生成的保持不变
      </p>

      {groups.map(([group, voices]) => (
        <section key={group}>
          <h3 className="mb-2 text-[11px] font-medium text-muted-foreground">{group}</h3>
          <div className="space-y-1.5">
            {voices.map((voice) => {
              const active = voice.id === selectedVoiceId;
              return (
                <button
                  key={voice.id}
                  type="button"
                  disabled={patch.isPending}
                  onClick={() => {
                    if (!active) patch.mutate({ voice_id: voice.id });
                    onPicked();
                  }}
                  className={cn(
                    'flex w-full items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left transition-colors disabled:opacity-55',
                    active
                      ? 'border-primary/40 bg-primary/10'
                      : 'border-border bg-card hover:bg-secondary'
                  )}
                >
                  <span
                    className={cn(
                      'text-[14px] font-medium',
                      active ? 'text-primary' : 'text-foreground'
                    )}
                  >
                    {voice.label}
                  </span>
                  {active ? <Check className="size-4 shrink-0 text-primary" aria-hidden /> : null}
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

function VoiceSettingsLoading() {
  return (
    <div className="flex justify-center py-10 text-[13px] text-muted-foreground">
      <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
      加载中
    </div>
  );
}

/**
 * 取不到配置时给个明确的收场，而不是一直转圈。
 * 最可能的原因是后端先于 migration 080 上线，这时读语音偏好会直接报错。
 */
function VoiceSettingsUnavailable() {
  return (
    <div className="rounded-2xl border border-dashed border-border bg-card/50 px-4 py-10 text-center">
      <p className="text-[13px] font-semibold text-foreground">语音设置暂时打不开</p>
      <p className="mt-1 text-[11px] text-muted-foreground">稍后再试，不影响正常聊天</p>
    </div>
  );
}

/** 1 显示成「1.0x」而不是「1x」，四个档位宽度才一致，不会跳来跳去 */
function formatRate(rate: number): string {
  return `${rate.toFixed(2).replace(/0$/, '')}x`;
}
