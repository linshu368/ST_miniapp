/**
 * 读畅聊按身份开放要用的用户事实：注册时间、会员到期、最近一次开通。
 *
 * 只在福利期外、开关开着时才需要（needsAccessFacts），所以做成惰性加载：
 * 生成链路只有选着免费模型时才会真的去读。一次请求里多次判定共用同一次读取。
 * 读失败返回 null，由判定按「临时放行」处理并打 warn——不能因为一次读抖动就扣会员的星尘。
 */
import { createLogger } from '../../lib/logger.js';
import { findUserCreatedAt } from '../../lib/user.js';
import { MiniappVipRepository } from '../../infrastructure/repositories/MiniappVipRepository.js';
import type { FreeZoneAccessFacts } from './access.js';

const log = createLogger('free-zone');
// 仓库构造时就建数据库客户端，延迟到第一次用，避免 import 本模块就连库。
let vipRepository: MiniappVipRepository | null = null;
const vip = () => (vipRepository ??= new MiniappVipRepository());

export type AccessFactsLoader = () => Promise<FreeZoneAccessFacts | null>;

export function createAccessFactsLoader(input: {
  userId: string;
  /** 调用方已有就传，省一次读；undefined 表示要读 */
  createdAt?: string | null;
  vipValidUntil: string | null;
  now?: () => Date;
  deps?: {
    findCreatedAt?: (userId: string) => Promise<string | null>;
    readLatestGrantAt?: (userId: string) => Promise<string | null>;
  };
}): AccessFactsLoader {
  const findCreatedAt = input.deps?.findCreatedAt ?? findUserCreatedAt;
  const readLatestGrantAt =
    input.deps?.readLatestGrantAt ?? ((userId: string) => vip().readLatestGrantAt(userId));
  let pending: Promise<FreeZoneAccessFacts | null> | null = null;

  const load = async (): Promise<FreeZoneAccessFacts | null> => {
    const started = Date.now();
    const now = (input.now ?? (() => new Date()))().getTime();
    const vipUntil = input.vipValidUntil ? Date.parse(input.vipValidUntil) : Number.NaN;
    // 开通礼只对有效会员有意义，非会员不必读开通记录。
    const vipActive = Number.isFinite(vipUntil) && vipUntil > now;
    try {
      const [createdAt, lastVipGrantAt] = await Promise.all([
        input.createdAt !== undefined ? input.createdAt : findCreatedAt(input.userId),
        vipActive ? readLatestGrantAt(input.userId) : null,
      ]);
      return { createdAt, vipValidUntil: input.vipValidUntil, lastVipGrantAt };
    } catch (err) {
      log.sys.warn(
        {
          err,
          event: 'free_zone.access_facts_failed',
          userId: input.userId,
          durationMs: Date.now() - started,
        },
        '畅聊开放判定读用户事实失败，本次临时放行'
      );
      return null;
    }
  };

  return () => (pending ??= load());
}
