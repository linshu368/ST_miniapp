'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { DRAMA_CDN_SAMPLE_ID, type DramaCdnRoute } from '@miniapp/shared';
import { DramaPlayer } from './drama-player';
import type { DramaPlaybackTiming } from '@/lib/perf/drama-timing';
import { measureCdnSeek, type CdnSeekResult } from '@/lib/perf/drama-cdn-seek';
import { API_URL } from '@/lib/api/client';

const ORDER: DramaCdnRoute[] = ['original', 'bunny', 'bunny', 'original', 'original', 'bunny'];
const STORAGE_KEY = 'st.drama-cdn-phone-round.v1';
type Trial = {
  sequence: number;
  route: DramaCdnRoute;
  purpose: 'formal' | 'functional' | 'fallback';
  started_at: string;
  startup_outcome: string;
  startup_ms?: number;
  source_to_frame_ms?: number;
  frame_method?: string;
  media_error?: number;
  seek?: CdnSeekResult;
  startup_cache: 'UNKNOWN';
  seek_cache: 'UNKNOWN';
  fallback_from_seconds?: number;
  fallback_resumed_seconds?: number;
  interruption?: 'before_seek';
  after_startup_outcome?: string;
};
type Evidence = {
  schema_version: 1;
  release: string;
  backend: string;
  sample: string;
  bytes: number;
  scope: string;
  same_phone_network_proxy: boolean;
  formal_started: boolean;
  closed?: boolean;
  trials: Trial[];
};
const freshEvidence = (): Evidence => ({
  schema_version: 1,
  release: process.env.NEXT_PUBLIC_DRAMA_RELEASE ?? 'unknown',
  backend: API_URL,
  sample: DRAMA_CDN_SAMPLE_ID,
  bytes: 46518538,
  scope:
    'Telegram phone; button click through address API/player to first frame; route already mounted; source_to_frame separate; 15s timeout; no automatic retry',
  same_phone_network_proxy: false,
  formal_started: false,
  trials: [],
});

export function CdnExperiment() {
  const [report, setReport] = useState<Evidence>(freshEvidence);
  const reportRef = useRef(report);
  const [selection, setSelection] = useState({
    route: 'original' as DramaCdnRoute,
    attempt: 0,
    enabled: false,
    preservePosition: false,
  });
  const [busy, setBusy] = useState(false);
  const [readyToSeek, setReadyToSeek] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [notice, setNotice] = useState('先完成接入检查，再开始唯一一轮正式对照。');
  const active = useRef<{
    index: number;
    started: number;
    video?: HTMLVideoElement;
    timer?: ReturnType<typeof setTimeout>;
    terminal: boolean;
    stopSeek?: () => void;
  }>();
  const persist = useCallback((next: Evidence) => {
    reportRef.current = next;
    setReport(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      setNotice('本机保存失败，请立即展开并复制结果。');
    }
  }, []);
  const update = useCallback(
    (index: number, patch: Partial<Trial>) => {
      const current = reportRef.current;
      persist({
        ...current,
        trials: current.trials.map((trial, i) => (i === index ? { ...trial, ...patch } : trial)),
      });
    },
    [persist]
  );
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved: Evidence = JSON.parse(raw);
        if (
          saved.schema_version === 1 &&
          saved.sample === DRAMA_CDN_SAMPLE_ID &&
          saved.trials.length <= 18
        ) {
          saved.trials = saved.trials.map((trial) =>
            trial.startup_outcome === 'pending'
              ? { ...trial, startup_outcome: 'interrupted' }
              : trial
          );
          persist(saved);
        }
      }
    } catch {
      setNotice('已有记录无法读取；请勿开始新轮次，先反馈。');
    }
  }, [persist]);
  const finish = useCallback(
    (patch: Partial<Trial>) => {
      const run = active.current;
      if (!run || run.terminal) return;
      run.terminal = true;
      clearTimeout(run.timer);
      const trial = reportRef.current.trials[run.index];
      update(
        run.index,
        trial?.startup_outcome === 'playing' && patch.startup_outcome !== 'playing'
          ? { interruption: 'before_seek', after_startup_outcome: patch.startup_outcome }
          : patch
      );
      setBusy(false);
      setReadyToSeek(false);
    },
    [update]
  );
  const onAddressError = useCallback(() => {
    finish({ startup_outcome: 'address_error' });
    setNotice('取址失败或实验截止；可关闭实验并重新获取原地址。源签名失效时请联系操作者刷新。');
  }, [finish]);
  const onMedia = useCallback(
    (video: HTMLVideoElement, timing: DramaPlaybackTiming) => {
      const run = active.current;
      if (!run || run.terminal) return () => {};
      run.video = video;
      const stop = timing.onFinish((outcome) => {
        if (active.current !== run || run.terminal) return;
        clearTimeout(run.timer);
        const trial = reportRef.current.trials[run.index];
        const patch: Partial<Trial> = {
          startup_outcome: outcome,
          startup_ms: Math.round((performance.now() - run.started) * 10) / 10,
          source_to_frame_ms:
            timing.marks.first_frame !== undefined && timing.marks.source_set !== undefined
              ? Math.round((timing.marks.first_frame - timing.marks.source_set) * 10) / 10
              : undefined,
          frame_method: timing.frameMethod,
          media_error: video.error?.code,
          ...(trial?.purpose === 'fallback' ? { fallback_resumed_seconds: video.currentTime } : {}),
        };
        update(run.index, patch);
        if (outcome === 'playing' && trial?.purpose === 'formal') setReadyToSeek(true);
        else finish(patch);
      });
      return () => {
        stop();
        run.stopSeek?.();
      };
    },
    [finish, update]
  );
  const start = (route: DramaCdnRoute, purpose: Trial['purpose']) => {
    if (reportRef.current.closed && purpose !== 'fallback') return;
    if (busy && purpose !== 'fallback') return;
    if (reportRef.current.trials.length >= 18) return;
    const previous = active.current;
    const seconds = previous?.video?.currentTime;
    if (previous && !previous.terminal) finish({ startup_outcome: 'interrupted' });
    previous?.stopSeek?.();
    previous?.video?.pause();
    const current = reportRef.current;
    const index = current.trials.length;
    persist({
      ...current,
      formal_started: current.formal_started || purpose === 'formal',
      trials: [
        ...current.trials,
        {
          sequence: index + 1,
          route,
          purpose,
          started_at: new Date().toISOString(),
          startup_outcome: 'pending',
          startup_cache: 'UNKNOWN',
          seek_cache: 'UNKNOWN',
          ...(purpose === 'fallback' ? { fallback_from_seconds: seconds } : {}),
        },
      ],
    });
    active.current = { index, started: performance.now(), terminal: false };
    active.current.timer = setTimeout(() => {
      finish({ startup_outcome: 'timeout' });
      active.current?.video?.pause();
    }, 15_000);
    setBusy(true);
    setReadyToSeek(false);
    setSelection({
      route,
      attempt: index + 1,
      enabled: true,
      preservePosition: purpose === 'fallback',
    });
  };
  const seek = () => {
    const run = active.current;
    if (!run?.video || !readyToSeek || run.terminal) return;
    setReadyToSeek(false);
    run.stopSeek = measureCdnSeek(run.video, (result) => {
      if (active.current !== run || run.terminal) return;
      update(run.index, { seek: result });
      run.terminal = true;
      setBusy(false);
      run.video?.pause();
      setNotice(
        result.outcome === 'playing'
          ? '本次完成，继续下一次。'
          : `seek：${result.outcome}，保留本次，不补测。`
      );
    });
  };
  useEffect(() => {
    const interrupt = () => {
      if (document.hidden) {
        active.current?.stopSeek?.();
        finish({ startup_outcome: 'interrupted' });
      }
    };
    document.addEventListener('visibilitychange', interrupt);
    return () => {
      document.removeEventListener('visibilitychange', interrupt);
      clearTimeout(active.current?.timer);
    };
  }, [finish]);
  const count = report.trials.filter((trial) => trial.purpose === 'formal').length;
  return (
    <>
      <DramaPlayer
        id={DRAMA_CDN_SAMPLE_ID}
        initialVideoId={DRAMA_CDN_SAMPLE_ID}
        experiment={{ ...selection, onMedia, onAddressError }}
        queueFailed={false}
        onRetryQueue={() => {}}
        onNavigate={() => {}}
      />
      <section
        data-player-no-swipe
        className="fixed inset-x-2 top-[max(12px,env(safe-area-inset-top))] z-50 mx-auto max-w-lg rounded-xl bg-black/90 p-3 text-xs text-white"
      >
        <p>
          内部手机配对 · 当前 {selection.route === 'bunny' ? 'B Bunny' : 'A 原 Supabase'} · 正式{' '}
          {count}/6
        </p>
        <p className="my-1 text-white/70">{notice} 真实媒体缓存头不可读时记 UNKNOWN。</p>
        <div className="flex flex-wrap gap-2">
          {!report.formal_started && (
            <>
              <button disabled={busy} onClick={() => start('original', 'functional')}>
                接入检查 A
              </button>
              <button disabled={busy} onClick={() => start('bunny', 'functional')}>
                接入检查 B
              </button>
            </>
          )}
          <button
            disabled={busy || report.closed || count >= 6 || !report.same_phone_network_proxy}
            onClick={() => start(ORDER[count]!, 'formal')}
          >
            {count === 0
              ? '开始唯一正式轮次 A'
              : count < 6
                ? `下一次 ${ORDER[count] === 'bunny' ? 'B' : 'A'}`
                : '三组已结束'}
          </button>
          <button disabled={!readyToSeek} onClick={seek}>
            测 72% 未缓冲 seek
          </button>
          <button
            onClick={() => {
              persist({ ...reportRef.current, closed: true });
              setNotice('Bunny 已在本机关闭，重新请求原地址并保留位置。');
              start('original', 'fallback');
            }}
          >
            关闭实验并回原路径
          </button>
          <button onClick={() => setShowReport((value) => !value)}>结果 / 复制</button>
        </div>
        {!report.formal_started && (
          <label className="mt-2 block">
            <input
              type="checkbox"
              checked={report.same_phone_network_proxy}
              onChange={(event) =>
                persist({ ...reportRef.current, same_phone_network_proxy: event.target.checked })
              }
            />{' '}
            确认真实 Telegram 手机，同手机 / 网络 / 代理状态全程不变
          </label>
        )}
        {showReport && (
          <textarea
            aria-label="脱敏验收结果"
            readOnly
            className="mt-2 h-48 w-full bg-zinc-900 text-[10px]"
            value={JSON.stringify(report, null, 2)}
          />
        )}
      </section>
    </>
  );
}
