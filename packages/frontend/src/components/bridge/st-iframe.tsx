'use client';

import { useRef, useEffect } from 'react';
import { useBridgeContext } from './bridge-provider';

const ST_IFRAME_URL = '/tavern/';

export function STIframe() {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const { registerIframe, isVisible } = useBridgeContext();

  useEffect(() => {
    if (iframeRef.current) {
      registerIframe(iframeRef.current);
    }
  }, [registerIframe]);

  return (
    <iframe
      ref={iframeRef}
      src={ST_IFRAME_URL}
      className={
        isVisible
          ? 'fixed inset-0 z-10 w-full h-full'
          : 'fixed inset-0 w-0 h-0 opacity-0 pointer-events-none'
      }
      sandbox="allow-scripts allow-same-origin allow-forms"
      title="SillyTavern"
    />
  );
}
