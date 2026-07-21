'use client';

import { useEffect, useRef, useState } from 'react';
import { useEffectivePresetQuery, useModelCatalogQuery } from '@/lib/api/models';
import { syncModelPresetToST, useBridgeStatus } from '@/lib/bridge';

export function ModelPresetReconciler() {
  const bridgeStatus = useBridgeStatus();
  const catalogQuery = useModelCatalogQuery();
  const config = catalogQuery.data;
  const presetQuery = useEffectivePresetQuery({
    modelId: config?.selected_model_id,
    assignmentVersion: config?.preset_assignments_version,
    effectivePresetId: config?.effective_preset_id,
    enabled: bridgeStatus === 'ready' && Boolean(config?.selected_model_id),
  });
  const lastAppliedKey = useRef<string | null>(null);
  const inFlightKey = useRef<string | null>(null);
  const bridgeEpoch = useRef(0);
  const retryTimer = useRef<number | null>(null);
  const [retryTick, setRetryTick] = useState(0);

  useEffect(() => {
    bridgeEpoch.current += 1;
    lastAppliedKey.current = null;
    inFlightKey.current = null;
  }, [bridgeStatus]);

  useEffect(() => {
    if (config?.preset_degraded) {
      console.warn('[ModelPresetReconciler] preset configuration degraded', {
        code: config.preset_config_code,
        modelId: config.selected_model_id,
      });
    }
  }, [config?.preset_config_code, config?.preset_degraded, config?.selected_model_id]);

  useEffect(() => {
    const preset = presetQuery.data;
    if (
      bridgeStatus !== 'ready' ||
      !config ||
      !preset ||
      preset.model_id !== config.selected_model_id
    ) {
      return;
    }

    const key = `${preset.model_id}:${preset.preset_assignments_version}:${preset.effective_preset_id}`;
    if (lastAppliedKey.current === key || inFlightKey.current === key) return;
    inFlightKey.current = key;
    const syncEpoch = bridgeEpoch.current;

    void syncModelPresetToST(preset)
      .then(() => {
        if (bridgeEpoch.current === syncEpoch) lastAppliedKey.current = key;
      })
      .catch((error) => {
        console.error('[ModelPresetReconciler] model preset sync failed:', error);
        if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
        retryTimer.current = window.setTimeout(() => setRetryTick((value) => value + 1), 5_000);
      })
      .finally(() => {
        if (bridgeEpoch.current === syncEpoch) inFlightKey.current = null;
      });
  }, [bridgeStatus, config, presetQuery.data, retryTick]);

  useEffect(
    () => () => {
      if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
    },
    []
  );

  return null;
}
