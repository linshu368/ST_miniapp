/**
 * 在架聊天模型名单，看板「聊天成功率」按它只看在架模型（docs/grafana/README.md）。
 * 口径与 st_chat_turns_total 的首发 platform/model/lane 一致：
 * - chat：模型目录里启用的模型（目录快照里只剩启用的）；
 * - free_zone：畅聊快照里在架的模型，上游按 freeModelUpstream 取。
 * 两份快照都是进程内缓存，不额外查库。
 */
import type { ListedChatModel } from '../../lib/engineering-observability.js';
import { fetchModelCatalogSnapshot } from '../../platform/model-tiers.js';
import { getFreeZoneSnapshot } from '../free-zone/snapshot.js';
import { freeModelUpstream } from '../free-zone/zone-view.js';

export async function loadListedChatModels(): Promise<ListedChatModel[]> {
  const [{ catalog }, freeZone] = await Promise.all([
    fetchModelCatalogSnapshot(),
    getFreeZoneSnapshot(),
  ]);
  const entries: ListedChatModel[] = [
    ...catalog.tiers.flatMap((tier) =>
      tier.models.map((model) => ({
        provider: model.provider,
        model: model.provider_model_id,
        lane: 'chat' as const,
      }))
    ),
    ...(freeZone?.listed ?? []).map((listed) => {
      const upstream = freeModelUpstream(listed);
      return {
        provider: upstream.provider,
        model: upstream.providerModelId,
        lane: 'free_zone' as const,
      };
    }),
  ];
  // 同一上游模型可能挂在多个档位里，一组标签只报一次
  const unique = new Map(
    entries.map((entry) => [`${entry.lane}|${entry.provider}|${entry.model}`, entry])
  );
  return [...unique.values()];
}
