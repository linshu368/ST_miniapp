'use client';

import { useEffect, useMemo, useState } from 'react';

import { useCharacterQuery } from '@/lib/api/characters';
import { hueShiftFromId } from '@/lib/utils/character-hue';

/** 开屏至少停留时长：保证动画完整走完一轮，避免"闪一下就没" */
const MIN_SHOW_MS = 2400;
/** 退场动画时长，与 CSS splash-exit 保持一致 */
const EXIT_MS = 720;

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
export function ChatSplash({ characterId, ready }: { characterId: string; ready: boolean }) {
  const { data } = useCharacterQuery(characterId);
  const character = data?.character;

  const [phase, setPhase] = useState<Phase>('showing');
  const [minElapsed, setMinElapsed] = useState(false);

  useEffect(() => {
    const minTimer = setTimeout(() => setMinElapsed(true), MIN_SHOW_MS);
    return () => {
      clearTimeout(minTimer);
    };
  }, []);

  useEffect(() => {
    if (phase === 'showing' && ready && minElapsed) {
      setPhase('exiting');
    }
  }, [phase, ready, minElapsed]);

  useEffect(() => {
    if (phase !== 'exiting') return;
    const timer = setTimeout(() => setPhase('gone'), EXIT_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  const hue = useMemo(() => hueShiftFromId(characterId), [characterId]);
  const stars = useMemo(() => buildStars(characterId, 28), [characterId]);

  if (phase === 'gone') return null;

  const name = character?.name ?? '';
  const description = character?.description?.trim() ?? '';
  const tags = (character?.personality_tags ?? []).slice(0, 3);
  const avatarUrl = character?.avatar_url || '';

  return (
    <div
      aria-hidden="true"
      className="fixed inset-0 z-40 flex flex-col items-center justify-center overflow-hidden"
      style={{
        background: `radial-gradient(150% 110% at 50% -10%, hsl(${hue} 62% 17%) 0%, hsl(${hue - 26} 48% 8%) 46%, #050309 100%)`,
        animation:
          phase === 'exiting'
            ? `splash-exit ${EXIT_MS}ms cubic-bezier(0.4, 0, 0.2, 1) forwards`
            : undefined,
      }}
    >
      {/* 极光气团：两团缓慢漂移的模糊光斑，给纯色背景带来呼吸感 */}
      <div
        className="pointer-events-none absolute -left-1/4 top-[-12%] h-[58vh] w-[58vh] rounded-full opacity-45 blur-3xl"
        style={{
          background: `radial-gradient(circle, hsl(${hue} 80% 46% / 0.85), transparent 68%)`,
          animation: 'splash-aurora-a 9s ease-in-out infinite',
        }}
      />
      <div
        className="pointer-events-none absolute -right-1/4 bottom-[-16%] h-[64vh] w-[64vh] rounded-full opacity-35 blur-3xl"
        style={{
          background: `radial-gradient(circle, hsl(${(hue + 42) % 360} 75% 52% / 0.8), transparent 66%)`,
          animation: 'splash-aurora-b 11s ease-in-out infinite',
        }}
      />

      {/* 星尘粒子 */}
      <div className="pointer-events-none absolute inset-0">
        {stars.map((s, i) => (
          <span
            key={i}
            className="absolute rounded-full bg-white"
            style={{
              left: `${s.left}%`,
              top: `${s.top}%`,
              width: s.size,
              height: s.size,
              opacity: s.opacity,
              boxShadow: `0 0 ${s.size * 3}px hsl(${hue} 90% 80% / 0.9)`,
              animation: `splash-twinkle ${s.duration}s ease-in-out ${s.delay}s infinite`,
            }}
          />
        ))}
      </div>

      {/* 人物海报：流光描边 + 呼吸光晕 + 斜向光扫 */}
      <div
        className="relative"
        style={{ animation: 'splash-pop 0.95s cubic-bezier(0.22, 1, 0.36, 1) both' }}
      >
        <div
          className="pointer-events-none absolute -inset-8 rounded-[40px] blur-2xl"
          style={{
            background: `radial-gradient(circle, hsl(${hue} 85% 55% / 0.5), transparent 70%)`,
            animation: 'splash-glow 3.2s ease-in-out infinite',
          }}
        />
        <div
          className="relative rounded-[26px] p-[1.5px]"
          style={{
            background: `linear-gradient(120deg, hsl(${hue} 90% 72% / 0.9), hsl(${(hue + 60) % 360} 85% 66% / 0.35), hsl(${hue} 90% 72% / 0.9))`,
            backgroundSize: '200% 100%',
            animation: 'splash-border-flow 3s linear infinite',
          }}
        >
          <div className="relative aspect-[3/4] w-44 overflow-hidden rounded-[24.5px] sm:w-52">
            {avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={avatarUrl}
                alt=""
                className="absolute inset-0 h-full w-full object-cover object-top"
              />
            ) : (
              <div
                className="absolute inset-0"
                style={{
                  background: `radial-gradient(120% 80% at 70% 30%, hsl(${hue} 55% 30%), hsl(${hue - 20} 40% 10%) 72%)`,
                }}
              />
            )}
            {/* 底部压暗，衬托描边光 */}
            <div className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/60 to-transparent" />
            {/* 斜向扫过的高光 */}
            <div
              className="pointer-events-none absolute inset-y-[-20%] w-1/3 bg-gradient-to-r from-transparent via-white/30 to-transparent"
              style={{ animation: 'splash-sheen 2.8s ease-in-out 0.6s infinite' }}
            />
          </div>
        </div>
      </div>

      {/* 名字 / 分隔线 / 标签 / 一句话描述：错峰入场 */}
      <div className="relative mt-8 flex max-w-[82vw] flex-col items-center px-6 text-center">
        <h1
          className="text-[26px] font-semibold tracking-[0.18em] text-white drop-shadow-[0_2px_14px_rgba(0,0,0,0.5)] sm:text-3xl"
          style={{ animation: 'splash-fade-up 0.7s ease-out 0.35s both' }}
        >
          {name}
        </h1>

        <div
          className="mt-4 h-px w-24 origin-center"
          style={{
            background: `linear-gradient(90deg, transparent, hsl(${hue} 85% 75%), transparent)`,
            animation: 'splash-line 0.8s cubic-bezier(0.22, 1, 0.36, 1) 0.55s both',
          }}
        />

        {tags.length > 0 && (
          <div
            className="mt-4 flex items-center gap-3"
            style={{ animation: 'splash-fade-up 0.7s ease-out 0.7s both' }}
          >
            {tags.map((t, i) => (
              <span
                key={t}
                className="flex items-center gap-3 text-[12px] tracking-[0.2em] text-white/60"
              >
                {i > 0 && (
                  <span
                    className="h-1 w-1 rounded-full"
                    style={{ background: `hsl(${hue} 85% 70%)` }}
                  />
                )}
                {t}
              </span>
            ))}
          </div>
        )}

        {description && (
          <p
            className="mt-5 line-clamp-2 text-[13px] leading-relaxed text-white/45"
            style={{ animation: 'splash-fade-up 0.7s ease-out 0.85s both' }}
          >
            「{description}」
          </p>
        )}
      </div>

      {/* 底部等待指示：三粒星尘跳动 */}
      <div
        className="absolute inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+3rem)] flex flex-col items-center gap-3"
        style={{ animation: 'splash-fade-up 0.8s ease-out 1.1s both' }}
      >
        <div className="flex items-center gap-1.5">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="h-1.5 w-1.5 rounded-full"
              style={{
                background: `hsl(${hue} 85% 72%)`,
                boxShadow: `0 0 6px hsl(${hue} 85% 70% / 0.9)`,
                animation: `splash-dot 1.3s ease-in-out ${i * 0.18}s infinite`,
              }}
            />
          ))}
        </div>
        <p className="text-[11px] tracking-[0.34em] text-white/35">正在进入 TA 的世界</p>
      </div>
    </div>
  );
}
