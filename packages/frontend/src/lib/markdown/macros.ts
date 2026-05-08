// 简化版 substituteParams:只处理 {{user}} / {{char}}
// SillyTavern 完整宏系统不在本次范围;其他 {{...}} 占位符保留原文
export interface MacroContext {
  charName?: string;
  userName?: string;
}

export function substituteMacros(text: string, ctx: MacroContext): string {
  const charName = ctx.charName?.trim() || '角色';
  const userName = ctx.userName?.trim() || '你';
  return text.replace(/\{\{char\}\}/gi, charName).replace(/\{\{user\}\}/gi, userName);
}
