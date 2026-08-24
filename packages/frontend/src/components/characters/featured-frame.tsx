import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * 金框（is_featured）渲染的唯一出口。
 *
 * 后端已经把判定收敛到 features/lobby/featured.ts，三个接口返回的 is_featured 必然一致；
 * 但金框此前只在大厅卡片里画，详情页和收藏列表压根没读这个字段，于是同一张卡在大厅有框、
 * 点进去没框。三处各写一遍渐变边框只会重演一次同样的错位，所以这里收成一个组件。
 */
interface FeaturedFrameProps {
  featured: boolean;
  /**
   * 外框圆角必须比内层大 2px（正好是 p-[2px] 的厚度），否则四个角会露出内层的直角。
   * 需要撑高时一并在这里传 h-full。
   */
  className?: string;
  children: ReactNode;
}

export function FeaturedFrame({ featured, className, children }: FeaturedFrameProps) {
  if (!featured) return <>{children}</>;

  return <div className={cn('featured-character-frame p-[2px]', className)}>{children}</div>;
}
