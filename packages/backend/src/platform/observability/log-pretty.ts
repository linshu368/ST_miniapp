/**
 * 决定是否启用 pino-pretty。
 * 缺包（prod 镜像只装 dependencies）时必须回退 JSON，否则 pino transport 会在启动期抛错。
 */
export function resolveLogPretty(input: {
  nodeEnv: string | undefined;
  logPrettyEnv: string | undefined;
  prettyAvailable: boolean;
}): boolean {
  if (input.logPrettyEnv === '0') return false;
  const wantPretty = input.logPrettyEnv === '1' || input.nodeEnv !== 'production';
  return wantPretty && input.prettyAvailable;
}
