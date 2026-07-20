export const MODEL_CATALOG_STALE_TIME_MS = 5 * 60 * 1000;

export function shouldRefreshModelCatalog(dataUpdatedAt: number, now = Date.now()): boolean {
  return dataUpdatedAt <= 0 || now - dataUpdatedAt > MODEL_CATALOG_STALE_TIME_MS;
}
