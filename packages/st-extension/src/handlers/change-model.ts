import { BridgeError } from '@miniapp/bridge-protocol';
import type { ActionPayloadMap, ActionResultMap } from '@miniapp/bridge-protocol';
import '../st-types.js';

type Payload = ActionPayloadMap['changeModel'];
type Result = ActionResultMap['changeModel'];

const SELECTOR_MAP: Record<string, string> = {
  openai: '#model_openai_select',
  claude: '#model_claude_select',
  makersuite: '#model_google_select',
  openrouter: '#model_openrouter_select',
};

export async function handleChangeModel(payload: Payload): Promise<Result> {
  const ctx = SillyTavern.getContext();
  const { provider, modelName } = payload;

  const selector = SELECTOR_MAP[provider];
  if (!selector) {
    throw new BridgeError('BRIDGE_EXEC_PRECONDITION_FAILED', `Unknown provider: ${provider}`);
  }

  const settingsKey = `${provider}_model`;
  (ctx.chatCompletionSettings as Record<string, unknown>)[settingsKey] = modelName;

  // Trigger DOM change to drive ST internal cascade logic
  const $ = (window as unknown as { jQuery: JQueryStatic }).jQuery;
  $(selector).val(modelName).trigger('change');

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
