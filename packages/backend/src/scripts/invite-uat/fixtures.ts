/**
 * backend / scripts / invite-uat / fixtures.ts
 *
 * 裂变邀请阶段三 UAT 的测试数据与库侧读写。
 *
 * 数据隔离与阶段一沙盘同口径：st_handle 前缀 + 待清理 tg_id 落盘登记，跑完自动清理零残留。
 * 归属域按 docs/schema归属地图.md：users 在 app_core，invite 三表在 miniapp_traffic，
 * 钱包与流水在 billing。新增表必须在 FIXTURE_TABLE_DOMAIN 登记，否则不过编译。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config } from '../../platform/config.js';
import { type DomainSchema } from '../../lib/supabase.js';

/**
 * 脚本专用 Supabase 客户端：与 lib/supabase.ts 的差别只有一个带重试的 fetch。
 *
 * 为什么不复用 getDomainDb：本脚本从本机直连 Supabase 公网端点，单次运行要发几百个
 * 请求，偶发 `TypeError: fetch failed` 会把断言染成假红。重试属于测试脚手架的诉求，
 * 不该塞进生产客户端去改线上行为，所以在这里单独开一个。
 */
let scriptClient: SupabaseClient | null = null;

async function retryingFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      return await fetch(input, init);
    } catch (error) {
      // 只重试网络层失败；HTTP 4xx/5xx 会正常返回 Response，不走这里。
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 250));
    }
  }
  throw lastError;
}

function getScriptDb(domain: DomainSchema) {
  scriptClient ??= createClient(config.supabase.url, config.supabase.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: retryingFetch },
  });
  return scriptClient.schema(domain);
}

/** 与 mvp-regression 的 mvp_regr_ 前缀并列，互不干扰。 */
const HANDLE_PREFIX = 'invite_uat_';

/**
 * 新建测试用户用的 tg_id 起点，与 mvp-regression 的 8_8xx 段错开。
 *
 * ⚠️ 这个段位**不保证**空着：真实 Telegram id 是单调递增的外部序列，本库里已经出现
 *    8_866_xxx_xxx 量级的真实账号，8_9xx 段被真人占用只是时间问题。所以它只用于
 *    「往哪写」，绝不可反过来当成「这段里的都是测试数据」的删除依据 —— 认领一律走
 *    st_handle 前缀或 PENDING_LEDGER_PATH 的精确登记。
 */
const TG_ID_BASE = 8_900_000_000;

/**
 * 待清理 tg_id 的落盘登记表。
 *
 * 场景让接口层的 getOrCreateDbUser 自己建号时（真实首开链路），建出来的 st_handle 是
 * tg-<id>，不带 invite_uat_ 前缀，进程若在建号后、登记 user id 前被杀就没人认领得到。
 * 因此在发请求**之前**先把 tg_id 同步写进这个文件：崩了下次开跑照样能精确清掉，
 * 又不必对整段 tg_id 行使删除权。
 */
const PENDING_LEDGER_PATH = fileURLToPath(
  new URL('../../../.invite-uat-pending.json', import.meta.url)
);

function readPendingTgIds(): string[] {
  if (!existsSync(PENDING_LEDGER_PATH)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(PENDING_LEDGER_PATH, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    // 登记表损坏时宁可少清一次，也不要让脚本起不来。
    return [];
  }
}

function writePendingTgIds(tgIds: string[]): void {
  writeFileSync(PENDING_LEDGER_PATH, `${JSON.stringify(tgIds)}\n`, 'utf8');
}

/** 同步落盘：必须在发起建号请求前调用，异步写会在硬杀时丢掉。 */
export function recordPendingTgId(tgId: string): void {
  const pending = readPendingTgIds();
  if (pending.includes(tgId)) return;
  writePendingTgIds([...pending, tgId]);
}

/** 对应 tg_id 已确认清理干净，从登记表划掉。 */
export function clearPendingTgIds(tgIds: string[]): void {
  if (tgIds.length === 0) return;
  const done = new Set(tgIds);
  writePendingTgIds(readPendingTgIds().filter((tgId) => !done.has(tgId)));
}

const FIXTURE_TABLE_DOMAIN = {
  users: 'app_core',
  runtime_config: 'app_core',
  miniapp_user_settings: 'app_core',
  invite_codes: 'miniapp_traffic',
  invite_relations: 'miniapp_traffic',
  invite_reward_logs: 'miniapp_traffic',
  user_wallets: 'billing',
  wallet_ledger: 'billing',
} as const satisfies Record<string, DomainSchema>;

function db(table: keyof typeof FIXTURE_TABLE_DOMAIN) {
  return getScriptDb(FIXTURE_TABLE_DOMAIN[table]).from(table);
}

export interface InviteTestUser {
  userId: string;
  tgId: string;
  stHandle: string;
}

let tgIdCursor = 0;

/** 单进程内递增，避免同一次运行里两个用户撞到同一个 tg_id。 */
export function nextTgId(): string {
  tgIdCursor += 1;
  return String(TG_ID_BASE + ((Date.now() % 1_000_000) * 100 + tgIdCursor));
}

/** 认领由接口层自己建出来的用户（真实首开链路），供清理登记用。 */
export async function findUserIdByTgId(tgId: string): Promise<string | null> {
  const { data, error } = await db('users').select('id').eq('tg_id', tgId).maybeSingle();
  if (error) throw new Error(`按 tg_id 查用户失败：${error.message}`);
  return (data as { id: string } | null)?.id ?? null;
}

/**
 * 造一个 MiniApp 用户。
 *
 * 注意：插入 app_core.users 会触发 031 的注册赠送 trigger（钱包 +600 bonus 与一条
 * adjustment 流水），这是真实链路的一部分，断言邀请奖励时只看 entry_type='invite_reward'。
 */
export async function createTestUser(): Promise<InviteTestUser> {
  const tgId = nextTgId();
  const stHandle = `${HANDLE_PREFIX}${tgId}`;
  const { data, error } = await db('users')
    .insert({ tg_id: tgId, st_handle: stHandle })
    .select('id')
    .single();
  if (error) throw new Error(`创建 UAT 用户失败：${error.message}`);
  return { userId: (data as { id: string }).id, tgId, stHandle };
}

/** 把 created_at 回拨，制造"已有账户"（超出 bind_invite 的 30 分钟新用户判定窗）。 */
export async function ageUser(userId: string, minutesAgo: number): Promise<void> {
  const createdAt = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const { error } = await db('users').update({ created_at: createdAt }).eq('id', userId);
  if (error) throw new Error(`回拨 created_at 失败：${error.message}`);
}

export async function setSourceId(userId: string, sourceId: string | null): Promise<void> {
  const { error } = await db('users').update({ source_id: sourceId }).eq('id', userId);
  if (error) throw new Error(`设置 source_id 失败：${error.message}`);
}

export async function getSourceId(userId: string): Promise<string | null> {
  const { data, error } = await db('users').select('source_id').eq('id', userId).maybeSingle();
  if (error) throw new Error(`查询 source_id 失败：${error.message}`);
  return (data as { source_id: string | null } | null)?.source_id ?? null;
}

export async function setTotalRound(userId: string, totalRound: number): Promise<void> {
  const now = new Date().toISOString();
  const userUpdate = await db('users')
    .update({ total_round: totalRound, updated_at: now })
    .eq('id', userId);
  if (userUpdate.error) throw new Error(`设置 users.total_round 失败：${userUpdate.error.message}`);

  const settingsUpdate = await db('miniapp_user_settings')
    .update({ total_round: totalRound, updated_at: now })
    .eq('user_id', userId);
  if (settingsUpdate.error) {
    throw new Error(`设置 miniapp_user_settings.total_round 失败：${settingsUpdate.error.message}`);
  }
}

/** 直接给用户造一个固定邀请码，省掉走 center-view 的往返。 */
export async function seedInviteCode(userId: string, code: string): Promise<string> {
  const { error } = await db('invite_codes').insert({ user_id: userId, code });
  if (error) throw new Error(`写入邀请码失败：${error.message}`);
  return code;
}

export interface InviteRelationRow {
  id: string;
  inviter_user_id: string;
  invitee_user_id: string;
  invite_code: string;
  bound_at: string;
}

export interface InviteRewardLogRow {
  id: string;
  relation_id: string;
  inviter_user_id: string;
  rule_key: string;
  event_ref: string;
  credits: number;
  granted_at: string;
}

export interface WalletLedgerRow {
  id: string;
  user_id: string;
  entry_type: string;
  amount: number;
  bonus_delta: number;
  reference_type: string | null;
  reference_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export async function listRelationsByInvitee(inviteeId: string): Promise<InviteRelationRow[]> {
  const { data, error } = await db('invite_relations').select('*').eq('invitee_user_id', inviteeId);
  if (error) throw new Error(`查询邀请关系（invitee）失败：${error.message}`);
  return (data ?? []) as InviteRelationRow[];
}

export async function listRelationsByInviter(inviterId: string): Promise<InviteRelationRow[]> {
  const { data, error } = await db('invite_relations')
    .select('*')
    .eq('inviter_user_id', inviterId)
    .order('bound_at', { ascending: false });
  if (error) throw new Error(`查询邀请关系（inviter）失败：${error.message}`);
  return (data ?? []) as InviteRelationRow[];
}

export async function listRewardLogsByInviter(inviterId: string): Promise<InviteRewardLogRow[]> {
  const { data, error } = await db('invite_reward_logs')
    .select('*')
    .eq('inviter_user_id', inviterId)
    .order('granted_at', { ascending: false });
  if (error) throw new Error(`查询发奖明细失败：${error.message}`);
  return (data ?? []) as InviteRewardLogRow[];
}

export async function listRewardLogsByRelation(relationId: string): Promise<InviteRewardLogRow[]> {
  const { data, error } = await db('invite_reward_logs')
    .select('*')
    .eq('relation_id', relationId)
    .order('granted_at', { ascending: true });
  if (error) throw new Error(`查询关系发奖明细失败：${error.message}`);
  return (data ?? []) as InviteRewardLogRow[];
}

/** 只取邀请奖励流水：注册赠送（adjustment）不在本次断言范围内。 */
export async function listInviteLedger(userId: string): Promise<WalletLedgerRow[]> {
  const { data, error } = await db('wallet_ledger')
    .select('*')
    .eq('user_id', userId)
    .eq('entry_type', 'invite_reward')
    .order('created_at', { ascending: true });
  if (error) throw new Error(`查询 invite_reward 流水失败：${error.message}`);
  return (data ?? []) as WalletLedgerRow[];
}

export async function getBonusCredits(userId: string): Promise<number> {
  const { data, error } = await db('user_wallets')
    .select('bonus_credits')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(`查询钱包失败：${error.message}`);
  return Number((data as { bonus_credits?: number } | null)?.bonus_credits ?? 0);
}

export async function getInviteCodeRow(
  userId: string
): Promise<{ code: string; center_first_entered_at: string | null } | null> {
  const { data, error } = await db('invite_codes')
    .select('code, center_first_entered_at')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(`查询邀请码失败：${error.message}`);
  return (data as { code: string; center_first_entered_at: string | null } | null) ?? null;
}

/** 直接调 RPC，用于库层重放与并发用例（绕过 HTTP，验证约束本身）。 */
export async function callBindInviteRpc(
  inviteeUserId: string,
  inviteCode: string
): Promise<{ status: string; inviter_user_id: string | null; relation_id: string | null }> {
  const { data, error } = await getScriptDb('miniapp_traffic').rpc('bind_invite', {
    p_invitee_user_id: inviteeUserId,
    p_invite_code: inviteCode,
  });
  if (error) throw new Error(`bind_invite RPC 失败：${error.message}`);
  const row = (
    data as Array<{
      status: string;
      inviter_user_id: string | null;
      relation_id: string | null;
    }> | null
  )?.[0];
  if (!row) throw new Error('bind_invite RPC 返回空');
  return row;
}

export async function callGrantRewardRpc(
  relationId: string,
  ruleKey: string,
  eventRef: string
): Promise<{ status: string; credits: number }> {
  const { data, error } = await getScriptDb('miniapp_traffic').rpc('grant_invite_reward', {
    p_relation_id: relationId,
    p_rule_key: ruleKey,
    p_event_ref: eventRef,
  });
  if (error) throw new Error(`grant_invite_reward RPC 失败：${error.message}`);
  const row = (data as Array<{ status: string; credits: number }> | null)?.[0];
  if (!row) throw new Error('grant_invite_reward RPC 返回空');
  return { status: row.status, credits: Number(row.credits) };
}

export async function callCheckInviteChatRoundsRewardRpc(inviteeUserId: string): Promise<{
  status: string;
  credits: number;
  total_round: number;
  threshold_rounds: number | null;
}> {
  const { data, error } = await getScriptDb('miniapp_traffic').rpc(
    'check_invite_chat_rounds_reward',
    {
      p_invitee_user_id: inviteeUserId,
    }
  );
  if (error) throw new Error(`check_invite_chat_rounds_reward RPC 失败：${error.message}`);
  const row = (
    data as Array<{
      status: string;
      credits: number;
      total_round: number;
      threshold_rounds: number | null;
    }> | null
  )?.[0];
  if (!row) throw new Error('check_invite_chat_rounds_reward RPC 返回空');
  return {
    status: row.status,
    credits: Number(row.credits),
    total_round: Number(row.total_round),
    threshold_rounds: row.threshold_rounds === null ? null : Number(row.threshold_rounds),
  };
}

export async function callEnsureInviteCodeRpc(
  userId: string
): Promise<{ code: string; first_visit: boolean }> {
  const { data, error } = await getScriptDb('miniapp_traffic').rpc('ensure_invite_code', {
    p_user_id: userId,
  });
  if (error) throw new Error(`ensure_invite_code RPC 失败：${error.message}`);
  const row = (data as Array<{ code: string; first_visit: boolean }> | null)?.[0];
  if (!row) throw new Error('ensure_invite_code RPC 返回空');
  return row;
}

export interface RuntimeConfigSnapshot {
  key: string;
  value: unknown;
  version: number;
}

export interface ConfigOverride {
  /** 还原为快照原值（含 version），跑完必须调用。 */
  restore(): Promise<void>;
}

async function readConfig(key: string): Promise<RuntimeConfigSnapshot> {
  const { data, error } = await db('runtime_config')
    .select('key, value, version')
    .eq('key', key)
    .maybeSingle();
  if (error) throw new Error(`读取 ${key} 失败：${error.message}`);
  if (!data) throw new Error(`${key} 不存在，105 迁移未在本库执行？`);
  return data as RuntimeConfigSnapshot;
}

async function writeConfig(key: string, value: unknown, version: number): Promise<void> {
  const { error } = await db('runtime_config').update({ value, version }).eq('key', key);
  if (error) throw new Error(`写入 ${key} 失败：${error.message}`);
}

/**
 * 临时覆盖一个 runtime_config key。
 *
 * ⚠️ 这是**共享配置**，改的瞬间同一 test 库上的其他人也会看到。调用方必须保证
 *    restore() 一定执行（run.ts 用 try/finally + SIGINT 兜底）。
 */
export async function overrideConfig(key: string, value: unknown): Promise<ConfigOverride> {
  const snapshot = await readConfig(key);
  await writeConfig(key, value, snapshot.version + 1);
  return {
    async restore() {
      await writeConfig(key, snapshot.value, snapshot.version);
    },
  };
}

export async function readRewardRules(): Promise<{
  total_cap_credits: number;
  rules: Array<{ rule_key: string; credits: number; enabled: boolean; threshold_rounds?: number }>;
}> {
  const snapshot = await readConfig('miniapp_invite_reward_rules');
  return snapshot.value as {
    total_cap_credits: number;
    rules: Array<{
      rule_key: string;
      credits: number;
      enabled: boolean;
      threshold_rounds?: number;
    }>;
  };
}

export async function readEntryEnabledRaw(): Promise<unknown> {
  return (await readConfig('miniapp_invite_entry_enabled')).value;
}

/**
 * 清理一批用户的全部邀请与账务痕迹。
 *
 * 删除顺序受外键约束：reward_logs → relations → invite_codes，
 * 再删 ledger / wallet（注册赠送 trigger 造的行也一并清掉）→ 最后删 users。
 */
export async function cleanupUsers(userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;

  // 关系可能以 inviter 或 invitee 身份存在，两侧都要认领。
  const relByInviter = await db('invite_relations').select('id').in('inviter_user_id', userIds);
  if (relByInviter.error) throw new Error(`清理时查询邀请关系失败：${relByInviter.error.message}`);
  const relByInvitee = await db('invite_relations').select('id').in('invitee_user_id', userIds);
  if (relByInvitee.error) throw new Error(`清理时查询邀请关系失败：${relByInvitee.error.message}`);
  const relationIds = [
    ...((relByInviter.data ?? []) as Array<{ id: string }>),
    ...((relByInvitee.data ?? []) as Array<{ id: string }>),
  ].map((row) => row.id);

  // 任何一步失败都必须抛：静默跳过会留下「钱包清了、用户还在」的半删状态，
  // 而 users 上大量外键是 ON DELETE CASCADE，删成功与否的差别是实打实的数据差异。
  const del = async (
    table:
      | 'invite_reward_logs'
      | 'invite_relations'
      | 'invite_codes'
      | 'wallet_ledger'
      | 'user_wallets'
      | 'miniapp_user_settings'
      | 'users',
    column: string,
    values: string[]
  ): Promise<void> => {
    const { error } = await db(table).delete().in(column, values);
    if (error) throw new Error(`清理 ${table} 失败：${error.message}`);
  };

  if (relationIds.length > 0) {
    await del('invite_reward_logs', 'relation_id', relationIds);
    await del('invite_relations', 'id', relationIds);
  }
  await del('invite_codes', 'user_id', userIds);
  await del('wallet_ledger', 'user_id', userIds);
  await del('user_wallets', 'user_id', userIds);
  await del('miniapp_user_settings', 'user_id', userIds);
  await del('users', 'id', userIds);
}

/**
 * 上次异常退出遗留的数据。开跑前扫一遍，比指望每次都优雅退出可靠。
 *
 * 两条认领路径都是精确匹配，不做任何段位/范围推断：脚本直插的用户带 invite_uat_ 前缀
 * st_handle；接口层建出来的用户 st_handle 是 tg-<id>，靠 PENDING_LEDGER_PATH 里事先
 * 登记的 tg_id 逐个 eq 认领。
 *
 * 曾经这里用 `like('tg_id', '89________')` 扫整段 8_9xx_xxx_xxx，那等于对一整个
 * 十亿号段行使删除权 —— 真实 Telegram id 迟早涨进来，届时会连人带钱包流水一起删掉。
 */
export async function sweepOrphanFixtures(): Promise<number> {
  const byHandle = await db('users').select('id').like('st_handle', `${HANDLE_PREFIX}%`);
  if (byHandle.error) throw new Error(`扫描遗留 UAT 用户失败：${byHandle.error.message}`);

  const pendingTgIds = readPendingTgIds();
  let byPending: Array<{ id: string }> = [];
  if (pendingTgIds.length > 0) {
    const found = await db('users').select('id').in('tg_id', pendingTgIds);
    if (found.error) throw new Error(`扫描遗留 UAT 用户失败：${found.error.message}`);
    byPending = (found.data ?? []) as Array<{ id: string }>;
  }

  const userIds = [
    ...new Set([...(byHandle.data ?? []), ...byPending].map((row) => (row as { id: string }).id)),
  ];
  await cleanupUsers(userIds);
  // 登记表里没建成号的 tg_id 也一并划掉：本轮已确认库里没有对应用户。
  clearPendingTgIds(pendingTgIds);
  return userIds.length;
}
