import { redirect } from 'next/navigation';

// 剧场下线：旧分享链接与缓存页面统一回到占位页。
export default function DramaDetailPage() {
  redirect('/dramas');
}
