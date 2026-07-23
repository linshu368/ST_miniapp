/**
 * Telegram can expose a generated SVG initials avatar through initData even
 * when the user has not uploaded a real profile photo. Treat that URL as
 * missing so every consumer consistently falls back to the platform default.
 */
export function normalizeTelegramAvatarUrl(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized) return null;

  try {
    const url = new URL(normalized);
    if (
      url.hostname.toLowerCase() === 't.me' &&
      /^\/i\/userpic\/\d+\/[^/]+\.svg$/i.test(url.pathname)
    ) {
      return null;
    }
  } catch {
    // Preserve non-empty legacy values; downstream image handling remains unchanged.
  }

  return normalized;
}
