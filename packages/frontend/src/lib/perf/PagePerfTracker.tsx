'use client';

import { usePathname } from 'next/navigation';
import { useEffect } from 'react';

import { installAssetFailureReporter } from './asset-failures';
import { beginPage } from './page-tracker';

/** 挂在 Providers 里：路由变化时开始计时，并安装一次资源加载失败监听。无渲染输出。 */
export function PagePerfTracker() {
  const pathname = usePathname();
  useEffect(() => {
    installAssetFailureReporter();
  }, []);
  useEffect(() => {
    beginPage(pathname);
  }, [pathname]);
  return null;
}
