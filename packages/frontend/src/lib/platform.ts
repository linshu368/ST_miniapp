export function isIOSLikeDevice(): boolean {
  if (typeof navigator === 'undefined') return false;

  const userAgent = navigator.userAgent;
  if (/iPad|iPhone|iPod/i.test(userAgent)) return true;

  // iPadOS 13+ can report a desktop-class Macintosh user agent.
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
}
