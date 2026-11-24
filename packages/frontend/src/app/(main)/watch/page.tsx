import { redirect } from 'next/navigation';

// 剧场下线：放映页入口统一回到占位页。
export default function WatchPage() {
  redirect('/dramas');
}
