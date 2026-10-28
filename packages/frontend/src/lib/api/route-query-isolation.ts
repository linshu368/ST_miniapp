'use client';

import { useEffect, useRef } from 'react';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';

type RouteQueryDomain = 'drama' | 'image-plaza';

const DOMAIN_QUERY_KEYS: Record<RouteQueryDomain, readonly QueryKey[]> = {
  drama: [['dramas'], ['drama']],
  'image-plaza': [['image-plaza']],
};

function getRouteQueryDomain(pathname: string | null): RouteQueryDomain | null {
  if (pathname === '/' || pathname === '/dramas' || pathname?.startsWith('/dramas/')) {
    return 'drama';
  }
  if (pathname === '/create' || pathname?.startsWith('/create/')) return 'image-plaza';
  return null;
}

/** Abort requests owned by the route being left so they cannot delay the next tab. */
export function useRouteQueryIsolation(pathname: string | null): void {
  const queryClient = useQueryClient();
  const previousDomainRef = useRef<RouteQueryDomain | null>(getRouteQueryDomain(pathname));

  useEffect(() => {
    const nextDomain = getRouteQueryDomain(pathname);
    const previousDomain = previousDomainRef.current;
    previousDomainRef.current = nextDomain;
    if (!previousDomain || previousDomain === nextDomain) return;

    for (const queryKey of DOMAIN_QUERY_KEYS[previousDomain]) {
      void queryClient.cancelQueries({ queryKey });
    }
  }, [pathname, queryClient]);

  useEffect(
    () => () => {
      const domain = previousDomainRef.current;
      if (!domain) return;
      for (const queryKey of DOMAIN_QUERY_KEYS[domain]) {
        void queryClient.cancelQueries({ queryKey });
      }
    },
    [queryClient]
  );
}
