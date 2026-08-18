export interface OptimisticBridgeActionOptions<TPersisted> {
  applyOptimistic: () => void;
  persist: () => Promise<TPersisted>;
  bridge: (persisted: TPersisted) => Promise<void>;
  rollbackPersisted: (persisted: TPersisted) => Promise<unknown>;
  rollbackOptimistic: () => void;
  onRollbackError?: (error: unknown) => void;
}

/**
 * Coordinates UI optimism, backend persistence and Bridge application.
 * The original action error remains authoritative even if compensation fails.
 */
export async function optimisticBridgeAction<TPersisted>(
  options: OptimisticBridgeActionOptions<TPersisted>
): Promise<TPersisted> {
  let persisted: TPersisted | undefined;
  let persistenceCompleted = false;
  options.applyOptimistic();

  try {
    persisted = await options.persist();
    persistenceCompleted = true;
    await options.bridge(persisted);
    return persisted;
  } catch (error) {
    options.rollbackOptimistic();
    if (persistenceCompleted) {
      try {
        await options.rollbackPersisted(persisted as TPersisted);
      } catch (rollbackError) {
        options.onRollbackError?.(rollbackError);
      }
    }
    throw error;
  }
}
