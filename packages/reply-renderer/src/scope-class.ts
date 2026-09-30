const SCOPE_CLASS = /^[a-z][a-z0-9_-]{0,63}$/;

/** 每条规则、每条消息一个 scope。类名只由消息身份和规则 id 决定，运营不能指定。 */
export function ruleScopeClass(messageKey: string, ruleId: string): string {
  let hash = 2166136261;
  const input = `${messageKey}\0${ruleId}`;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const suffix = ruleId.replace(/[^a-z0-9]/g, '').slice(0, 16);
  const token = `s${(hash >>> 0).toString(36)}${suffix}`;
  if (!SCOPE_CLASS.test(token)) {
    throw new Error('Invalid text postprocess scope class.');
  }
  return token;
}
