'use client';

type NavigatorWithConnection = Navigator & {
  connection?: { saveData?: boolean; effectiveType?: string };
};

/** Background warming must never compete on hidden, offline, or constrained clients. */
export function canPrefetchInBackground(): boolean {
  if (typeof document === 'undefined' || document.visibilityState !== 'visible') return false;
  const connection = (navigator as NavigatorWithConnection).connection;
  return (
    navigator.onLine !== false &&
    connection?.saveData !== true &&
    connection?.effectiveType !== 'slow-2g' &&
    connection?.effectiveType !== '2g'
  );
}
