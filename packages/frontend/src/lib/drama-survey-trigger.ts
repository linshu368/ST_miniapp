import { DRAMA_SURVEY_KEY, DRAMA_SURVEY_TRIGGER_ROUNDS } from '@miniapp/shared';

type SurveyStorage = Pick<Storage, 'getItem' | 'setItem'>;
function browserStorage(): SurveyStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}
const storageKey = (userScope: string) => `st.drama-survey.${DRAMA_SURVEY_KEY}:${userScope}`;

/** 提交过或叉掉过都算 done；只在本机记录，换设备最多再弹一次。 */
export function readDramaSurveyDone(
  userScope: string,
  storage: SurveyStorage | null = browserStorage()
): boolean {
  try {
    return storage?.getItem(storageKey(userScope)) === 'done';
  } catch {
    return false;
  }
}

export function writeDramaSurveyDone(
  userScope: string,
  storage: SurveyStorage | null = browserStorage()
): void {
  try {
    storage?.setItem(storageKey(userScope), 'done');
  } catch {
    // WebView 禁用存储时只是可能再弹一次，不影响聊天。
  }
}

/**
 * AI 回复刚完成（generating true→false、没有出错）且当前对话已有 ≥4 条用户消息。
 * 只认这一个边沿：打开一个已有很多轮的旧对话不会立刻弹，要等下一次回复完成。
 */
export function reachedDramaSurveyRound(input: {
  wasGenerating: boolean;
  generating: boolean;
  failed: boolean;
  messages: readonly { role: string }[];
}): boolean {
  if (!input.wasGenerating || input.generating || input.failed) return false;
  if (input.messages.at(-1)?.role !== 'assistant') return false;
  let rounds = 0;
  for (const message of input.messages) if (message.role === 'user') rounds += 1;
  return rounds >= DRAMA_SURVEY_TRIGGER_ROUNDS;
}

/** 选项随机排序，减少位置偏差；「其他」由调用方固定放最后。 */
export function shuffled<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    const current = copy[index] as T;
    copy[index] = copy[swap] as T;
    copy[swap] = current;
  }
  return copy;
}
