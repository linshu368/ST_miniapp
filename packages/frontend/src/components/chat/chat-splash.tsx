'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import { useCharacterQuery } from '@/lib/api/characters';
import { lobbyImageUrl } from '@/components/characters/character-card';
import { characterRoomGradient } from '@/lib/utils/character-hue';

/** 快加载不打扰：500ms 内 ready 的场景不展示进度条 */
const PROGRESS_REVEAL_MS = 500;
/** 首次进入 ST 可能较慢，超过该时长后展示安抚提示 */
const SLOW_HINT_MS = 6500;
/** 长尾兜底：不让用户永远只看一条进度条 */
const STALL_HINT_MS = 45000;
/** 退场动画时长，与 CSS splash-exit 保持一致 */
const EXIT_MS = 720;
/** ready 后先拉满进度，再让整屏退场 */
const READY_FILL_MS = 240;

type Phase = 'showing' | 'exiting' | 'gone';

/** 由 characterId 派生的确定性伪随机（SSR/CSR 渲染一致，避免 hydration 抖动） */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFromId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

type Star = {
  left: number;
  top: number;
  size: number;
  delay: number;
  duration: number;
  opacity: number;
};

function buildStars(id: string, count: number): Star[] {
  const rand = mulberry32(seedFromId(id));
  return Array.from({ length: count }, () => ({
    left: rand() * 100,
    top: rand() * 100,
    size: 1 + rand() * 2.4,
    delay: rand() * 4,
    duration: 2.2 + rand() * 3.2,
    opacity: 0.3 + rand() * 0.7,
  }));
}

/**
 * 进入 Chat 前的开屏动画（T1）。
 * 全屏覆盖在 ST iframe（z-10）与 ChatHeader（z-20）之上，
 * 在桥接 ready + 角色切换完成（ready=true）且最短停留时间已到后，
 * 以"镜头推进"式的放大淡出收场，然后自行卸载。
 * 如果 ST/桥接/角色切换没有完成，则持续展示本动画，不露出 ST 原生加载画面。
 */
export function ChatSplash({
  characterId,
  ready,
  error,
  onRetry,
  onVisible,
}: {
  characterId: string;
  ready: boolean;
  error?: string | null;
  onRetry?: () => void;
  onVisible?: () => void;
}) {
  const router = useRouter();
  const { data } = useCharacterQuery(characterId);
  const character = data?.character;
  const avatarUrl = character?.avatar_url || '';

  /**
   * 挂载那一刻就已经 ready，说明没有任何要等的东西——典型场景是从「自定义本次语音」
   * 这类二级页返回，会话和消息都还在 React Query 缓存里。这时候再放一遍开屏，
   * 用户看到的就是凭空弹出来的「正在进入」，所以直接跳到 gone。
   *
   * 用 ref 锁住挂载时的值：ready 随后转 true 是正常的首次进入，那一次必须走完整入场。
   */
  const skipIntro = useRef(ready).current;

  const [phase, setPhase] = useState<Phase>(skipIntro ? 'gone' : 'showing');
  const [progressVisible, setProgressVisible] = useState(false);
  const [showSlowHint, setShowSlowHint] = useState(false);
  const [showStallHint, setShowStallHint] = useState(false);
  const [progress, setProgress] = useState(0);
  const [returning, setReturning] = useState(false);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const visibleReportedRef = useRef(false);

  useEffect(() => {
    router.prefetch('/');
  }, [router]);

  useEffect(() => {
    setImageLoaded(false);
    setImageFailed(false);
  }, [avatarUrl]);

  useEffect(() => {
    if (skipIntro) return;
    const startedAt = performance.now();
    const revealTimer = setTimeout(() => setProgressVisible(true), PROGRESS_REVEAL_MS);
    const slowHintTimer = setTimeout(() => setShowSlowHint(true), SLOW_HINT_MS);
    const stallHintTimer = setTimeout(() => setShowStallHint(true), STALL_HINT_MS);

    // 进度仅作等待反馈，无需逐帧刷新；降低冷启动时主线程压力并避免影响按钮点击。
    const progressTimer = window.setInterval(() => {
      setProgress(calculateProgress(performance.now() - startedAt));
    }, 200);

    return () => {
      clearInterval(progressTimer);
      clearTimeout(revealTimer);
      clearTimeout(slowHintTimer);
      clearTimeout(stallHintTimer);
    };
  }, [skipIntro]);

  useEffect(() => {
    if (phase !== 'showing' || !ready) return;
    setProgress(100);
    const timer = setTimeout(() => setPhase('exiting'), READY_FILL_MS);
    return () => clearTimeout(timer);
  }, [phase, ready]);

  useEffect(() => {
    if (phase !== 'exiting') return;
    const timer = setTimeout(() => setPhase('gone'), EXIT_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  useEffect(() => {
    if (phase !== 'gone' || visibleReportedRef.current) return;
    const raf = window.requestAnimationFrame(() => {
      if (visibleReportedRef.current) return;
      visibleReportedRef.current = true;
      onVisible?.();
    });
    return () => window.cancelAnimationFrame(raf);
  }, [onVisible, phase]);

  const stars = useMemo(() => buildStars(characterId, 28), [characterId]);

  if (phase === 'gone') return null;

  const name = character?.name ?? '';
  const description = character?.description?.trim() ?? '';
  const tags = (character?.personality_tags ?? []).slice(0, 3);
  const posterGradient = characterRoomGradient(characterId);
  const returnToLobby = () => {
    if (returning) return;
    setReturning(true);
    router.replace('/');

    // 极端情况下 ST 冷启动会长时间占用主线程，给客户端路由一个短窗口后用原生导航兜底。
    window.setTimeout(() => {
      if (window.location.pathname.startsWith('/tavern/')) {
        window.location.replace('/');
      }
    }, 1200);
  };

  return (
    <div
      aria-live="polite"
      aria-busy={!ready}
      className="fixed inset-0 z-40 flex flex-col items-center justify-center overflow-hidden bg-background px-5 py-5 text-foreground"
      style={{
        // 开屏盖在 ST iframe 之上，ST 注入的样式会串进来，这里显式钉住前景色。
        color: 'hsl(var(--foreground))',
        colorScheme: 'dark',
        animation:
          phase === 'exiting'
            ? `splash-exit ${EXIT_MS}ms cubic-bezier(0.4, 0, 0.2, 1) forwards`
            : undefined,
      }}
    >
      {phase === 'showing' && (
        <button
          type="button"
          onClick={returnToLobby}
          disabled={returning}
          aria-label="取消进入并返回大厅"
          className="absolute right-4 z-20 flex size-10 items-center justify-center rounded-full border border-border bg-card text-xl font-light text-muted-foreground transition hover:border-primary/30 hover:bg-secondary active:scale-95 disabled:opacity-50"
          style={{ top: 'calc(env(safe-area-inset-top) + 1rem)' }}
        >
          ×
        </button>
      )}

      {/* 保留原有装饰层，但改为克制的版式线条与纸面颗粒。 */}
      <div className="pointer-events-none absolute inset-y-0 left-[11%] w-px bg-foreground/[0.055]" />
      <div className="pointer-events-none absolute inset-x-0 bottom-[18%] h-px bg-foreground/[0.055]" />
      <div className="pointer-events-none absolute inset-0">
        {stars.map((s, i) => (
          <span
            key={i}
            className="absolute rounded-full bg-foreground"
            style={{
              left: `${s.left}%`,
              top: `${s.top}%`,
              width: Math.min(1.2, s.size),
              height: Math.min(1.2, s.size),
              opacity: s.opacity * 0.13,
            }}
          />
        ))}
      </div>

      <div className="absolute left-5 top-[calc(env(safe-area-inset-top)+1.35rem)] text-left">
        <p className="text-[10px] font-semibold tracking-[0.28em] text-primary">蜜镜 AI</p>
        <p className="mt-1 text-[9px] tracking-[0.2em] text-muted-foreground/70">
          CHARACTER SESSION
        </p>
      </div>

      <div className="relative flex w-full max-w-[22rem] flex-col items-center">
        {showSlowHint && !showStallHint && !error && phase === 'showing' && (
          <div
            className="mb-4 w-full border-l-2 border-primary bg-card px-4 py-3 text-left"
            style={{ animation: 'splash-fade-up 0.45s ease-out both' }}
          >
            <p className="text-[12px] font-medium text-foreground/80">第一次见面，需要多等几秒</p>
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
              我们正在唤醒角色记忆和对话引擎。准备好后会自动进入，不用退出重试。
            </p>
          </div>
        )}

        <div
          className={`mb-4 w-full transition-all duration-500 ${
            progressVisible ? 'translate-y-0 opacity-100' : '-translate-y-1 opacity-0'
          }`}
        >
          <div className="mb-2 flex items-center justify-between text-[9px] tracking-[0.2em] text-muted-foreground">
            <span>正在连接对话</span>
            <span>{ready ? '100%' : progress >= 90 ? '正在完成' : `${Math.floor(progress)}%`}</span>
          </div>
          <div className="h-px overflow-hidden bg-border">
            <div
              className="h-full bg-primary"
              style={{
                width: `${progress}%`,
                transition: ready ? `width ${READY_FILL_MS}ms ease-out` : 'width 180ms linear',
              }}
            />
          </div>
          {(showStallHint || error) && phase === 'showing' && (
            <div
              className="mt-3 border border-border bg-card px-3 py-3 text-center"
              style={{ animation: 'splash-fade-up 0.4s ease-out both' }}
            >
              <p className="text-[12px] leading-relaxed text-muted-foreground">
                {error ?? '连接时间比预期更久。可以继续等待，或返回大厅重新进入。'}
              </p>
              <div className="mt-3 flex justify-center gap-2">
                {error && onRetry && (
                  <button
                    type="button"
                    onClick={onRetry}
                    disabled={returning}
                    className="min-h-10 rounded-full bg-primary px-5 py-2 text-[12px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-55"
                  >
                    重试
                  </button>
                )}
                <button
                  type="button"
                  onClick={returnToLobby}
                  disabled={returning}
                  className="min-h-10 rounded-full border border-border px-5 py-2 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-secondary disabled:opacity-55"
                >
                  {returning ? '正在返回…' : '返回大厅'}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* 人物海报：与大厅共用缩图、占位色和淡入加载策略。 */}
        <div
          className="relative w-fit"
          style={{ animation: 'splash-pop 0.65s cubic-bezier(0.22, 1, 0.36, 1) both' }}
        >
          <span className="absolute -left-3 -top-3 text-[9px] font-medium tracking-[0.22em] text-muted-foreground/70">
            PORTRAIT / 01
          </span>
          <div className="relative border border-border bg-card p-1.5">
            <div
              className="relative aspect-[3/4] overflow-hidden"
              style={{ width: 'clamp(8rem, 25vh, 12rem)', background: posterGradient }}
            >
              {avatarUrl && !imageFailed ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={lobbyImageUrl(avatarUrl)}
                  alt={name}
                  width={360}
                  height={480}
                  loading="eager"
                  fetchPriority="high"
                  decoding="async"
                  onLoad={() => setImageLoaded(true)}
                  onError={() => setImageFailed(true)}
                  className={`absolute inset-0 h-full w-full object-cover object-top transition-opacity duration-300 ${
                    imageLoaded ? 'opacity-100' : 'opacity-0'
                  }`}
                />
              ) : null}
            </div>
          </div>
          <div className="absolute -bottom-2 -right-2 size-5 border-b border-r border-primary/70" />
        </div>

        {/* 名字、标签和描述全部保留，以简洁的信息版式呈现。 */}
        <div className="mt-[clamp(1rem,2.8vh,1.75rem)] flex max-w-[86vw] flex-col items-center text-center">
          <h1
            className="text-[24px] font-semibold tracking-[0.08em] text-foreground sm:text-[28px]"
            style={{
              color: 'hsl(var(--foreground))',
              animation: 'splash-fade-up 0.5s ease-out 0.2s both',
            }}
          >
            {name}
          </h1>

          <div className="mt-3 h-px w-10 bg-primary/80" />

          {tags.length > 0 && (
            <div
              className="mt-3 flex flex-wrap items-center justify-center gap-x-3 gap-y-1"
              style={{ animation: 'splash-fade-up 0.5s ease-out 0.35s both' }}
            >
              {tags.map((tag) => (
                <span key={tag} className="text-[10px] tracking-[0.16em] text-muted-foreground">
                  {tag}
                </span>
              ))}
            </div>
          )}

          {description && (
            <p
              className="mt-3 line-clamp-2 max-w-[19rem] text-[12px] leading-5 text-muted-foreground"
              style={{ animation: 'splash-fade-up 0.5s ease-out 0.5s both' }}
            >
              {description}
            </p>
          )}
        </div>
      </div>

      {/* 底部等待状态保留，动效仅用于说明仍在运行。 */}
      <div
        className="absolute inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+1.2rem)] flex flex-col items-center gap-2"
        style={{ animation: 'splash-fade-up 0.55s ease-out 0.65s both' }}
      >
        <div className="flex items-center gap-1">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="size-1 rounded-full bg-primary"
              style={{
                animation: `splash-dot 1.3s ease-in-out ${i * 0.18}s infinite`,
              }}
            />
          ))}
        </div>
        <p className="text-[9px] tracking-[0.28em] text-muted-foreground/70">正在进入 TA 的世界</p>
      </div>
    </div>
  );
}

function calculateProgress(elapsedMs: number): number {
  if (elapsedMs <= 3000) {
    return Math.min(70, (elapsedMs / 3000) * 70);
  }

  if (elapsedMs <= 10000) {
    return 70 + ((elapsedMs - 3000) / 7000) * 20;
  }

  // 10s 之后极慢蠕动，永不到 100%，100% 只绑定真实 ready。
  const creep = 5 * (1 - Math.exp(-(elapsedMs - 10000) / 20000));
  return Math.min(95, 90 + creep);
}
