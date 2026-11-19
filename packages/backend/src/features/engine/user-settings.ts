import type { EngineUserSettings } from './types.js';

const NOTES_HEADER = '【用户补充设定】\n以下是用户为这个角色补充的设定，与角色卡一起生效。';
const PERSONA_HEADER = '【主角人设】\n以下是用户扮演的主角（{{user}}）的人设。';

/**
 * 把用户设定渲染成一条 system 消息正文；两段都空返回 null，调用方据此不加消息，
 * 让没有设置过的用户 prompt 与改动前完全一致。
 */
export function renderUserSettings(settings: EngineUserSettings): string | null {
  const sections: string[] = [];
  const notes = settings.notes.trim();
  if (notes) sections.push(`${NOTES_HEADER}\n${notes}`);
  const persona = settings.personaDescription.trim();
  if (persona) sections.push(`${PERSONA_HEADER}\n${persona}`);
  return sections.length > 0 ? sections.join('\n\n') : null;
}
