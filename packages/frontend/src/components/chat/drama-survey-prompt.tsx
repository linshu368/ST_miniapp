'use client';

import dynamic from 'next/dynamic';
import { useEffect, useRef, useState } from 'react';
import type { DramaSurveyEngagement } from '@miniapp/shared';
import { useDismissDramaSurveyMutation, useDramaSurveyStatusQuery } from '@/lib/api/drama-survey';
import {
  reachedDramaSurveyRound,
  readDramaSurveyDone,
  writeDramaSurveyDone,
} from '@/lib/drama-survey-trigger';
import { getTelegramPlatform } from '@/lib/perf/env-tags';
import { readDramaEngagement } from '@/stores/drama-library-store';

// 绝大多数会话不会弹，问卷 UI 等真正要弹时再加载。
const DramaSurveySheet = dynamic(
  () => import('./drama-survey-sheet').then((module) => module.DramaSurveySheet),
  { ssr: false }
);

/**
 * 聊天页的短剧原因问卷入口：只给本机有过有效观看的用户，任意对话聊满 4 轮、AI 回复完成时弹一次。
 * 从未看过、只是误点划过的用户（追剧记录里没有有效观看）不弹。
 */
export function DramaSurveyPrompt({
  generating,
  failed,
  messages,
  userScope,
}: {
  generating: boolean;
  failed: boolean;
  messages: readonly { role: string }[];
  userScope: string;
}) {
  const wasGenerating = useRef(generating);
  const [engagement, setEngagement] = useState<DramaSurveyEngagement | null>(null);
  const [open, setOpen] = useState(false);
  const [closed, setClosed] = useState(false);
  const status = useDramaSurveyStatusQuery(engagement !== null);
  const dismiss = useDismissDramaSurveyMutation();

  useEffect(() => {
    const reached = reachedDramaSurveyRound({
      wasGenerating: wasGenerating.current,
      generating,
      failed,
      messages,
    });
    wasGenerating.current = generating;
    if (!reached || engagement || closed || readDramaSurveyDone(userScope)) return;
    const { engagedDramas, maxEpisode } = readDramaEngagement();
    if (engagedDramas < 1) return;
    setEngagement({ engaged_dramas: engagedDramas, max_episode: Math.max(1, maxEpisode) });
  }, [closed, engagement, failed, generating, messages, userScope]);

  useEffect(() => {
    if (status.data?.eligible && !closed && !readDramaSurveyDone(userScope)) setOpen(true);
  }, [closed, status.data?.eligible, userScope]);

  if (!engagement || !status.data || (!open && !closed)) return null;
  return (
    <DramaSurveySheet
      open={open}
      rewardCredits={status.data.reward_credits}
      platform={getTelegramPlatform()}
      engagement={engagement}
      onSubmitted={() => writeDramaSurveyDone(userScope)}
      onClose={(submitted) => {
        setOpen(false);
        setClosed(true);
        writeDramaSurveyDone(userScope);
        if (!submitted) dismiss.mutate({ platform: getTelegramPlatform(), engagement });
      }}
    />
  );
}
