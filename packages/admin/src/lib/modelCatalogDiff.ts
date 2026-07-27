import { ModelCatalogSchema, type ModelCatalog } from '@miniapp/shared';

function modelMap(catalog: ModelCatalog) {
  return new Map(
    catalog.tiers.flatMap((tier) =>
      tier.models.map(
        (model) => [model.id, { ...model, tier: tier.tier, tierLabel: tier.label }] as const
      )
    )
  );
}

export function getModelCatalogChangeSummary(before: unknown, after: unknown): string | null {
  const previous = ModelCatalogSchema.safeParse(before);
  const next = ModelCatalogSchema.safeParse(after);
  if (!previous.success || !next.success) return null;

  const beforeModels = modelMap(previous.data);
  const afterModels = modelMap(next.data);
  const changes: string[] = [];

  for (const [id, model] of afterModels) {
    const oldModel = beforeModels.get(id);
    if (!oldModel) {
      changes.push(`新增模型“${model.display_name}”`);
      continue;
    }
    if (oldModel.enabled !== model.enabled) {
      changes.push(`${model.enabled ? '上架' : '下架'}“${model.display_name}”`);
    }
    if (oldModel.openrouter_model_id !== model.openrouter_model_id) {
      changes.push(`更新“${model.display_name}”的 OpenRouter 映射`);
    }
    if (
      oldModel.price_input !== model.price_input ||
      oldModel.price_output !== model.price_output
    ) {
      changes.push(`调整“${model.display_name}”展示价格`);
    }
    if (oldModel.markup !== model.markup) {
      changes.push(`调整“${model.display_name}”默认倍率：${oldModel.markup} → ${model.markup}`);
    }
    if (
      oldModel.markup === 0 &&
      model.markup === 0 &&
      oldModel.deduct_markup !== model.deduct_markup
    ) {
      changes.push(
        `调整“${model.display_name}”扣费倍率：${oldModel.deduct_markup} → ${model.deduct_markup}`
      );
    }
    if (
      oldModel.display_name !== model.display_name ||
      oldModel.tagline !== model.tagline ||
      oldModel.tier !== model.tier ||
      oldModel.sort_order !== model.sort_order
    ) {
      changes.push(`更新“${model.display_name}”展示信息`);
    }
  }

  for (const [id, model] of beforeModels) {
    if (!afterModels.has(id)) changes.push(`删除模型“${model.display_name}”`);
  }

  if (previous.data.default_model_id !== next.data.default_model_id) {
    const defaultModel = afterModels.get(next.data.default_model_id);
    changes.push(`默认模型改为“${defaultModel?.display_name ?? next.data.default_model_id}”`);
  }

  if (changes.length === 0) return '模型目录内容未变化';
  return `${changes.length} 项：${changes.slice(0, 5).join('；')}${changes.length > 5 ? '…' : ''}`;
}
