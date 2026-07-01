import { BridgeError } from '@miniapp/bridge-protocol';
import type { ActionPayloadMap, ActionResultMap } from '@miniapp/bridge-protocol';
import '../st-types.js';

type Payload = ActionPayloadMap['changeModel'];
type Result = ActionResultMap['changeModel'];

// 非 custom 源时的下拉选择器映射（保留兼容；平台 MVP 实际固定走 custom 源）。
const SELECTOR_MAP: Record<string, string> = {
  openai: '#model_openai_select',
  claude: '#model_claude_select',
  makersuite: '#model_google_select',
  openrouter: '#model_openrouter_select',
};

export async function handleChangeModel(payload: Payload): Promise<Result> {
  const ctx = SillyTavern.getContext();
  const { provider, modelName } = payload;
  const settings = ctx.chatCompletionSettings as Record<string, unknown>;
  const $ = (window as unknown as { jQuery: JQueryStatic }).jQuery;

  // 平台经 LLM 代理固定使用 chat_completion_source='custom'，其模型存于
  // oai_settings.custom_model，权威入口是 #custom_model_id 文本输入（支持任意 model id，
  // 不受下拉选项限制）。此前按 provider='openrouter' 写 openrouter_model 完全不生效。
  const source = String(settings.chat_completion_source ?? '');

  if (source === 'custom') {
    settings.custom_model = modelName;
    // 触发 ST 的 #custom_model_id input 处理器，写入 oai_settings.custom_model 并保存。
    $('#custom_model_id').val(modelName).trigger('input');
  } else {
    const selector = SELECTOR_MAP[source] ?? SELECTOR_MAP[provider];
    if (!selector) {
      throw new BridgeError(
        'BRIDGE_EXEC_PRECONDITION_FAILED',
        `Unknown chat completion source/provider: ${source}/${provider}`
      );
    }
    settings[`${source || provider}_model`] = modelName;
    $(selector).val(modelName).trigger('change');
  }

  ctx.saveSettingsDebounced();

  // 主动广播模型变更：custom 源的 #custom_model_id input 不会触发
  // CHATCOMPLETION_MODEL_CHANGED，需手动 emit，让 forwarder 推 model:changed，
  // 前端 mirror.currentModel 同步、档位高亮跟随。
  try {
    await ctx.eventSource.emit(ctx.eventTypes.CHATCOMPLETION_MODEL_CHANGED, modelName);
  } catch {
    /* 广播失败不影响模型已切换的事实 */
  }

  return { appliedModel: ctx.getChatCompletionModel() };
}

// Minimal jQuery type declarations for the DOM interaction above
interface JQueryObject {
  val(value: string): JQueryObject;
  trigger(event: string): JQueryObject;
}

interface JQueryStatic {
  (selector: string): JQueryObject;
}
