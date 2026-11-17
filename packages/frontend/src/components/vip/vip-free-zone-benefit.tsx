'use client';

import { MessagesSquare } from 'lucide-react';
import { formatVipWeeklyWindow } from '@miniapp/shared';

import { useModelCatalogQuery } from '@/lib/api/models';

/**
 * 月卡里的「免费畅聊」权益：开通/续费立享几天 + 每周畅聊日。数字取目录接口里的畅聊规则；
 * 没开按身份开放（福利期或旧后端）时不显示。
 */
export function VipFreeZoneBenefit({ renewing }: { renewing: boolean }) {
  const catalog = useModelCatalogQuery();
  const access = catalog.data?.free_zone?.access;
  if (!access || access.audience === 'everyone') return null;
  const welcome = access.vip_welcome_days;
  return (
    <div className="mt-4 flex items-start gap-2 rounded-2xl border border-free-zone/25 bg-free-zone/[0.07] px-3 py-2.5">
      <MessagesSquare className="mt-0.5 size-3.5 shrink-0 text-free-zone" aria-hidden />
      <div>
        <p className="text-xs font-semibold text-free-zone">
          免费畅聊
          {welcome > 0 ? ` · ${renewing ? '续费' : '开通'}立享 ${welcome} 天` : ''}
        </p>
        <p className="mt-1 text-[10px] text-muted-foreground">
          之后每{formatVipWeeklyWindow(access.vip_weekly)}畅聊，每轮 0 星尘、不限次数
        </p>
      </div>
    </div>
  );
}
