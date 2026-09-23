'use client';

import { useState } from 'react';
import Image from 'next/image';

/** 可替换的静态权益图。加载失败时保留固定高度，避免详情页塌掉。 */
export function VipBenefitArt() {
  const [failed, setFailed] = useState(false);

  return (
    <div className="relative h-40 overflow-hidden rounded-[24px] border border-border bg-card">
      {failed ? (
        <div className="flex h-full items-center justify-center px-6 text-center text-[13px] text-muted-foreground">
          权益插图暂时无法显示
        </div>
      ) : (
        <Image
          src="/vip-benefits.png"
          alt=""
          fill
          unoptimized
          className="object-cover"
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
}
