/**
 * backend / scripts / invite-uat / scenarios.ts
 *
 * 裂变邀请阶段三的 UAT 用例集：PRD「边界情况」全量 + 防刷并发重放 + 数据中心口径。
 *
 * 与 docs/裂变工程落地实施方案.md 阶段三产物的对应关系：
 *   §1 UAT 边界用例   → attribution_* / idempotency_* / reward_cap / entry_switch / auth_guard
 *   §2 数据中心口径    → stats_alignment / stats_latency
 *   防刷并发重放       → concurrency_*（库层直调 RPC + 接口层并发 HTTP 双打）
 *
 * 每个场景自己造用户、自己登记待清理 id；场景之间不共享状态，可单独 --scenario 跑。
 */

import { INVITE_SOURCE_ID } from '@miniapp/shared';
import {
  ageUser,
  callBindInviteRpc,
  callCheckInviteChatRoundsRewardRpc,
  callCheckInviteFirstPaidRewardRpc,
  callEnsureInviteCodeRpc,
  callGrantRewardRpc,
  cleanupUsers,
  clearPendingTgIds,
  createTestUser,
  findUserIdByTgId,
  nextTgId,
  recordPendingTgId,
  getBonusCredits,
  getInviteCodeRow,
  getSourceId,
  listInviteLedger,
  listRelationsByInvitee,
  listRelationsByInviter,
  listRewardLogsByInviter,
  listRewardLogsByRelation,
  overrideConfig,
  readRewardRules,
  seedInviteCode,
  seedPendingPaymentOrder,
  setSourceId,
  setTotalRound,
  settlePaymentOrder,
  type InviteTestUser,
} from './fixtures.js';
import { buildInitData, getEntryStatus, getStats, postBind, postCenterView } from './client.js';

export interface CheckResult {
  label: string;
  passed: boolean;
  expected: unknown;
  actual: unknown;
}

export interface ScenarioResult {
  name: string;
  description: string;
  outcome: 'passed' | 'failed';
  checks: CheckResult[];
  observed: Record<string, unknown>;
}

export interface ScenarioContext {
  baseUrl: string;
}

export interface Scenario {
  name: string;
  description: string;
  run(ctx: ScenarioContext): Promise<ScenarioResult>;
}

const CHAT_ROUNDS_RULE_KEY = 'invitee_chat_rounds';
const FIRST_PAID_RULE_KEY = 'invitee_first_paid';

type RewardRulesConfig = Awaited<ReturnType<typeof readRewardRules>>;
type RewardRule = RewardRulesConfig['rules'][number];

function getChatRoundsRule(rules: RewardRulesConfig): RewardRule {
  const rule = rules.rules.find((item) => item.rule_key === CHAT_ROUNDS_RULE_KEY);
  if (!rule) throw new Error(`奖励规则缺少 ${CHAT_ROUNDS_RULE_KEY}`);
  return rule;
}

function getThresholdRounds(rule: RewardRule): number {
  return typeof rule.threshold_rounds === 'number' ? rule.threshold_rounds : 3;
}

function getFirstPaidRule(rules: RewardRulesConfig): RewardRule {
  const rule = rules.rules.find((item) => item.rule_key === FIRST_PAID_RULE_KEY);
  if (!rule) throw new Error(`奖励规则缺少 ${FIRST_PAID_RULE_KEY}`);
  return rule;
}

function withFirstPaidEnabled(rules: RewardRulesConfig): RewardRulesConfig {
  return {
    ...rules,
    rules: rules.rules.map((rule) =>
      rule.rule_key === FIRST_PAID_RULE_KEY ? { ...rule, enabled: true } : rule
    ),
  };
}

function withFirstPaidDisabled(rules: RewardRulesConfig): RewardRulesConfig {
  return {
    ...rules,
    rules: rules.rules.map((rule) =>
      rule.rule_key === FIRST_PAID_RULE_KEY ? { ...rule, enabled: false } : rule
    ),
  };
}

/** 收集断言与待清理用户，让每个场景的样板代码收敛到一处。 */
class ScenarioRecorder {
  readonly checks: CheckResult[] = [];
  readonly observed: Record<string, unknown> = {};
  readonly userIds: string[] = [];

  expect(label: string, expected: unknown, actual: unknown): void {
    this.checks.push({
      label,
      passed: JSON.stringify(expected) === JSON.stringify(actual),
      expected,
      actual,
    });
  }

  note(key: string, value: unknown): void {
    this.observed[key] = value;
  }

  async user(): Promise<InviteTestUser> {
    const created = await createTestUser();
    this.userIds.push(created.userId);
    return created;
  }

  /**
   * 只占一个 tg_id，不建库行——让接口层的 getOrCreateDbUser 自己建号，
   * 这才是被邀请人首次打开 MiniApp 的真实链路。返回的 claim 用于事后认领清理。
   *
   * 先落盘再返回：接口层建号成功后、claim() 登记 user id 前进程被杀，这个文件是
   * 下次开跑唯一能精确认领到该用户的线索。
   */
  freshTgId(): string {
    const tgId = nextTgId();
    recordPendingTgId(tgId);
    this.pendingTgIds.push(tgId);
    return tgId;
  }

  readonly pendingTgIds: string[] = [];

  /** 把接口层建出来的用户登记进待清理列表，并返回其 user id。 */
  async claim(tgId: string): Promise<string> {
    const userId = await findUserIdByTgId(tgId);
    if (userId === null) throw new Error(`期望接口层已创建 tg_id=${tgId} 的用户，实际查无此人`);
    if (!this.userIds.includes(userId)) this.userIds.push(userId);
    return userId;
  }

  /** 造一个"邀请人 + 已有邀请码"的组合，绝大多数场景的起点。 */
  async inviter(code: string): Promise<InviteTestUser & { code: string }> {
    const user = await this.user();
    await seedInviteCode(user.userId, code);
    return { ...user, code };
  }
}

/** 每次运行唯一的码后缀，避免与库里既有码或并行运行撞车。 */
let codeCursor = 0;
function nextCode(): string {
  codeCursor += 1;
  const body = (Date.now() % 100_000).toString(36).toUpperCase().padStart(4, '0').slice(-4);
  return `U${body}${String(codeCursor).padStart(3, '0')}`.slice(0, 8).padEnd(8, '0');
}

function defineScenario(
  name: string,
  description: string,
  body: (ctx: ScenarioContext, rec: ScenarioRecorder) => Promise<void>
): Scenario {
  return {
    name,
    description,
    async run(ctx) {
      const rec = new ScenarioRecorder();
      try {
        await body(ctx, rec);
      } finally {
        // 清理失败记成断言失败而不是抛出：抛出会盖掉 body 里真正的错因。
        // 失败时不划掉登记表，留给下次开跑的 sweep 兜底。
        try {
          await cleanupUsers(rec.userIds);
          clearPendingTgIds(rec.pendingTgIds);
        } catch (error) {
          rec.expect('清理本场景测试数据', '清理成功', (error as Error).message);
        }
      }
      return {
        name,
        description,
        outcome: rec.checks.every((check) => check.passed) ? 'passed' : 'failed',
        checks: rec.checks,
        observed: rec.observed,
      };
    },
  };
}

const attributionHappyPath = defineScenario(
  'attribution_happy_path',
  '新用户经有效链接首次登录 → 建立唯一关系，不立即发奖，source_id 记 invite',
  async (ctx, rec) => {
    const inviter = await rec.inviter(nextCode());
    const bonusBefore = await getBonusCredits(inviter.userId);

    // 被邀请人此前没有库行：bind 请求自身触发 getOrCreateDbUser 建号（真实首开链路）。
    const inviteeTgId = rec.freshTgId();
    const bind = await postBind(ctx.baseUrl, buildInitData(inviteeTgId), inviter.code);
    rec.expect('bind 返回 bound', 'bound', bind.data?.status);
    const inviteeId = await rec.claim(inviteeTgId);
    const relations = await listRelationsByInvitee(inviteeId);
    rec.expect('invite_relations 恰 1 行', 1, relations.length);
    rec.expect('关系挂在正确的邀请人下', inviter.userId, relations[0]?.inviter_user_id);
    rec.expect('留档的邀请码正确', inviter.code, relations[0]?.invite_code);

    const rewards = await listRewardLogsByInviter(inviter.userId);
    rec.expect('绑定后发奖明细仍为 0 行', 0, rewards.length);

    const ledger = await listInviteLedger(inviter.userId);
    rec.expect('绑定后 invite_reward 流水仍为 0 条', 0, ledger.length);

    const bonusAfter = await getBonusCredits(inviter.userId);
    rec.expect('绑定后邀请人 bonus 无变化', 0, bonusAfter - bonusBefore);
    rec.expect('被邀请人 source_id 记为 invite', INVITE_SOURCE_ID, await getSourceId(inviteeId));

    rec.note('bonus_delta', bonusAfter - bonusBefore);
  }
);

const attributionSelfInvite = defineScenario(
  'attribution_self_invite',
  'A 点自己的链接注册 → 不建关系不发奖（PRD 边界：自邀）',
  async (ctx, rec) => {
    const self = await rec.inviter(nextCode());
    const bonusBefore = await getBonusCredits(self.userId);

    const bind = await postBind(ctx.baseUrl, buildInitData(self.tgId), self.code);
    rec.expect('bind 返回 self_invite', 'self_invite', bind.data?.status);
    rec.expect('无邀请关系', 0, (await listRelationsByInvitee(self.userId)).length);
    rec.expect('无发奖明细', 0, (await listRewardLogsByInviter(self.userId)).length);
    rec.expect('bonus 无变化', bonusBefore, await getBonusCredits(self.userId));
  }
);

const attributionLastClickWins = defineScenario(
  'attribution_last_click_wins',
  'B 点 A 链接未注册，之后点 C 链接注册 → 归 C（PRD 边界：绑定发生在注册时刻）',
  async (ctx, rec) => {
    const inviterA = await rec.inviter(nextCode());
    const inviterC = await rec.inviter(nextCode());

    // "点了 A 但没注册"在真实链路里就是：前端缓存了 A 的码，但从未走到 bind
    // （bind 只在完成登录后发出）。随后用户点 C 的链接注册，前端缓存被 C 覆盖。
    const inviteeTgId = rec.freshTgId();
    const bind = await postBind(ctx.baseUrl, buildInitData(inviteeTgId), inviterC.code);
    rec.expect('bind 返回 bound', 'bound', bind.data?.status);

    const inviteeId = await rec.claim(inviteeTgId);
    const relations = await listRelationsByInvitee(inviteeId);
    rec.expect('关系恰 1 行', 1, relations.length);
    rec.expect('归属于 C 而非 A', inviterC.userId, relations[0]?.inviter_user_id);
    rec.expect('A 名下零关系', 0, (await listRelationsByInviter(inviterA.userId)).length);
    rec.expect('A 名下零发奖', 0, (await listRewardLogsByInviter(inviterA.userId)).length);

    // 已绑定后再点 A 的链接：不覆盖（UNIQUE 兜底）。
    const rebind = await postBind(ctx.baseUrl, buildInitData(inviteeTgId), inviterA.code);
    rec.expect('再点 A 链接返回 already_bound', 'already_bound', rebind.data?.status);
    const after = await listRelationsByInvitee(inviteeId);
    rec.expect('关系仍恰 1 行', 1, after.length);
    rec.expect('归属仍为 C，未被覆盖', inviterC.userId, after[0]?.inviter_user_id);
  }
);

const attributionExistingUser = defineScenario(
  'attribution_existing_user',
  '已注册用户（超出 30 分钟新用户窗）反复点他人链接 → not_new_user，不新增不覆盖',
  async (ctx, rec) => {
    const inviter = await rec.inviter(nextCode());
    const oldUser = await rec.user();
    await ageUser(oldUser.userId, 60);

    const first = await postBind(ctx.baseUrl, buildInitData(oldUser.tgId), inviter.code);
    rec.expect('首次点击返回 not_new_user', 'not_new_user', first.data?.status);

    const second = await postBind(ctx.baseUrl, buildInitData(oldUser.tgId), inviter.code);
    rec.expect('重复点击仍为 not_new_user（幂等终态）', 'not_new_user', second.data?.status);

    rec.expect('零关系', 0, (await listRelationsByInvitee(oldUser.userId)).length);
    rec.expect('邀请人零发奖', 0, (await listRewardLogsByInviter(inviter.userId)).length);
    rec.expect('未写入 source_id', null, await getSourceId(oldUser.userId));
  }
);

const attributionInvalidCode = defineScenario(
  'attribution_invalid_code',
  '无效 / 失效 / 非法格式邀请码 → invalid_code，不建关系（前端降级展示）',
  async (ctx, rec) => {
    const inviteeTgId = rec.freshTgId();
    const initData = buildInitData(inviteeTgId);

    // 格式合法但库里不存在的码：走到 RPC 后按 invalid_code 返回。
    const unknown = await postBind(ctx.baseUrl, initData, 'ZZZZ9999');
    rec.expect('不存在的码 → invalid_code', 'invalid_code', unknown.data?.status);

    const inviteeId = await rec.claim(inviteeTgId);

    // 格式非法：后端 INVITE_CODE_RE 在进 RPC 前兜底（前端未拦截时的防线）。
    const malformed: Array<[string, unknown]> = [
      ['过短', 'ABC'],
      ['过长', 'ABCDEFGHI'],
      ['含连字符', 'ABCD-123'],
      ['空串', ''],
      ['纯空格', '    '],
      ['非字符串（数字）', 12345678],
      ['非字符串（null）', null],
      ['SQL 注入样本', "' OR 1=1--"],
    ];
    for (const [label, value] of malformed) {
      const result = await postBind(ctx.baseUrl, initData, value);
      rec.expect(`${label} → invalid_code`, 'invalid_code', result.data?.status);
      rec.expect(`${label} 不报 5xx`, 200, result.status);
    }

    rec.expect('全程零关系', 0, (await listRelationsByInvitee(inviteeId)).length);
  }
);

const attributionCodeNormalization = defineScenario(
  'attribution_code_normalization',
  '邀请码大小写与首尾空格归一 → 仍能正确绑定（深链复制粘贴容错）',
  async (ctx, rec) => {
    const inviter = await rec.inviter(nextCode());
    const inviteeTgId = rec.freshTgId();

    // 后端只 trim，大小写归一在 RPC 内（upper(trim(...))）。
    const bind = await postBind(
      ctx.baseUrl,
      buildInitData(inviteeTgId),
      inviter.code.toLowerCase()
    );
    rec.expect('小写码可绑定', 'bound', bind.data?.status);

    const inviteeId = await rec.claim(inviteeTgId);
    const relations = await listRelationsByInvitee(inviteeId);
    rec.expect('归属正确', inviter.userId, relations[0]?.inviter_user_id);
    rec.expect('留档为大写规范形式', inviter.code, relations[0]?.invite_code);

    const other = rec.freshTgId();
    const padded = await postBind(ctx.baseUrl, buildInitData(other), `  ${inviter.code}  `);
    rec.expect('带首尾空格可绑定', 'bound', padded.data?.status);
    await rec.claim(other);
  }
);

const attributionSourceIdGuard = defineScenario(
  'attribution_source_id_guard',
  '已有渠道归因的用户绑定成功 → source_id 不被 invite 覆盖（守卫式 UPDATE）',
  async (ctx, rec) => {
    const inviter = await rec.inviter(nextCode());
    const invitee = await rec.user();
    await setSourceId(invitee.userId, 'existing_channel');

    const bind = await postBind(ctx.baseUrl, buildInitData(invitee.tgId), inviter.code);
    rec.expect('绑定成功', 'bound', bind.data?.status);
    rec.expect('既有 source_id 未被覆盖', 'existing_channel', await getSourceId(invitee.userId));
    rec.expect('关系正常建立', 1, (await listRelationsByInvitee(invitee.userId)).length);
  }
);

const chatRoundRewardThreshold = defineScenario(
  'chat_round_reward_threshold',
  '被邀请人 total_round 达到配置阈值 → invitee_chat_rounds 发奖一次',
  async (ctx, rec) => {
    const rules = await readRewardRules();
    const chatRule = getChatRoundsRule(rules);
    const threshold = getThresholdRounds(chatRule);
    const expectedCredits = chatRule.enabled ? chatRule.credits : 0;

    const inviter = await rec.inviter(nextCode());
    const inviteeTgId = rec.freshTgId();
    const bind = await postBind(ctx.baseUrl, buildInitData(inviteeTgId), inviter.code);
    rec.expect('绑定成功', 'bound', bind.data?.status);
    const inviteeId = await rec.claim(inviteeTgId);
    const relationId = (await listRelationsByInvitee(inviteeId))[0]?.id ?? '';
    const bonusBefore = await getBonusCredits(inviter.userId);

    await setTotalRound(inviteeId, Math.max(0, threshold - 1));
    const below = await callCheckInviteChatRoundsRewardRpc(inviteeId);
    rec.expect('未达阈值 → below_threshold', 'below_threshold', below.status);
    rec.expect('未达阈值金额为 0', 0, below.credits);
    rec.expect('未达阈值无发奖明细', 0, (await listRewardLogsByRelation(relationId)).length);

    await setTotalRound(inviteeId, threshold);
    const granted = await callCheckInviteChatRoundsRewardRpc(inviteeId);
    rec.expect('达阈值 → granted', chatRule.enabled ? 'granted' : 'skipped', granted.status);
    rec.expect('发奖金额等于 invitee_chat_rounds 规则值', expectedCredits, granted.credits);
    rec.expect('返回阈值等于配置值', threshold, granted.threshold_rounds);

    const rewards = await listRewardLogsByRelation(relationId);
    rec.expect('达标后发奖明细恰 1 行', chatRule.enabled ? 1 : 0, rewards.length);
    if (chatRule.enabled) {
      rec.expect('发奖规则为 invitee_chat_rounds', CHAT_ROUNDS_RULE_KEY, rewards[0]?.rule_key);
      rec.expect('event_ref 为被邀请人 id', inviteeId, rewards[0]?.event_ref);
    }
    rec.expect(
      'invite_reward 流水条数匹配',
      chatRule.enabled ? 1 : 0,
      (await listInviteLedger(inviter.userId)).length
    );
    rec.expect(
      '邀请人 bonus 增量 = 发奖金额',
      expectedCredits,
      (await getBonusCredits(inviter.userId)) - bonusBefore
    );

    const duplicated = await callCheckInviteChatRoundsRewardRpc(inviteeId);
    rec.expect(
      '达标检查重放 → duplicated',
      chatRule.enabled ? 'duplicated' : 'skipped',
      duplicated.status
    );
    rec.expect('重放金额为 0', 0, duplicated.credits);
    rec.expect(
      '重放后明细条数不变',
      chatRule.enabled ? 1 : 0,
      (await listRewardLogsByRelation(relationId)).length
    );
  }
);

const chatRoundRewardBindBackfill = defineScenario(
  'chat_round_reward_bind_backfill',
  '绑定补报前 total_round 已达阈值 → bind_invite 内补做达标检查并发奖',
  async (ctx, rec) => {
    const rules = await readRewardRules();
    const chatRule = getChatRoundsRule(rules);
    const threshold = getThresholdRounds(chatRule);
    const inviter = await rec.inviter(nextCode());
    const invitee = await rec.user();
    await setTotalRound(invitee.userId, threshold);
    const bonusBefore = await getBonusCredits(inviter.userId);

    const bind = await postBind(ctx.baseUrl, buildInitData(invitee.tgId), inviter.code);
    rec.expect('绑定成功', 'bound', bind.data?.status);

    const relationId = (await listRelationsByInvitee(invitee.userId))[0]?.id ?? '';
    const rewards = await listRewardLogsByRelation(relationId);
    rec.expect('绑定补报触发达标发奖', chatRule.enabled ? 1 : 0, rewards.length);
    if (chatRule.enabled) {
      rec.expect('补发规则为 invitee_chat_rounds', CHAT_ROUNDS_RULE_KEY, rewards[0]?.rule_key);
      rec.expect('补发金额等于规则值', chatRule.credits, rewards[0]?.credits);
    }
    rec.expect(
      '邀请人 bonus 增量匹配',
      chatRule.enabled ? chatRule.credits : 0,
      (await getBonusCredits(inviter.userId)) - bonusBefore
    );
  }
);

const legacyRegisteredRewardNoDoublePay = defineScenario(
  'legacy_registered_reward_no_double_pay',
  '历史 invitee_registered 已发奖关系达到新阈值 → 不再补发 invitee_chat_rounds',
  async (_ctx, rec) => {
    const rules = await readRewardRules();
    const chatRule = getChatRoundsRule(rules);
    const threshold = getThresholdRounds(chatRule);
    const inviter = await rec.inviter(nextCode());
    const invitee = await rec.user();
    const bound = await callBindInviteRpc(invitee.userId, inviter.code);
    rec.expect('前置绑定成功', 'bound', bound.status);
    const relationId = bound.relation_id ?? '';

    const legacyOverride = await overrideConfig('miniapp_invite_reward_rules', {
      total_cap_credits: rules.total_cap_credits,
      rules: [
        { rule_key: 'invitee_registered', credits: 200, enabled: true },
        {
          rule_key: CHAT_ROUNDS_RULE_KEY,
          credits: chatRule.credits,
          enabled: chatRule.enabled,
          threshold_rounds: threshold,
        },
        ...rules.rules.filter(
          (rule) => !['invitee_registered', CHAT_ROUNDS_RULE_KEY].includes(rule.rule_key)
        ),
      ],
    });
    try {
      const legacy = await callGrantRewardRpc(relationId, 'invitee_registered', invitee.userId);
      rec.expect('模拟历史注册奖发放成功', 'granted', legacy.status);
    } finally {
      await legacyOverride.restore();
    }

    const bonusBefore = await getBonusCredits(inviter.userId);
    await setTotalRound(invitee.userId, threshold);
    const check = await callCheckInviteChatRoundsRewardRpc(invitee.userId);
    rec.expect('新达标检查识别历史奖励为 duplicated', 'duplicated', check.status);
    rec.expect('新达标检查不发金额', 0, check.credits);

    const rewards = await listRewardLogsByRelation(relationId);
    rec.expect('仍只有历史注册奖 1 行', 1, rewards.length);
    rec.expect(
      '没有新增 invitee_chat_rounds',
      false,
      rewards.some((r) => r.rule_key === CHAT_ROUNDS_RULE_KEY)
    );
    rec.expect('bonus 无新增变化', bonusBefore, await getBonusCredits(inviter.userId));
  }
);

const firstPaidRewardGrant = defineScenario(
  'first_paid_reward_grant',
  '被邀请人首笔订单入账 → invitee_first_paid 发奖一次；同单重放与第二笔均不再发',
  async (ctx, rec) => {
    const original = await readRewardRules();
    const expectedCredits = getFirstPaidRule(original).credits;

    const inviter = await rec.inviter(nextCode());
    const inviteeTgId = rec.freshTgId();
    const bind = await postBind(ctx.baseUrl, buildInitData(inviteeTgId), inviter.code);
    rec.expect('绑定成功', 'bound', bind.data?.status);
    const inviteeId = await rec.claim(inviteeTgId);
    const relationId = (await listRelationsByInvitee(inviteeId))[0]?.id ?? '';
    const bonusBefore = await getBonusCredits(inviter.userId);

    const override = await overrideConfig(
      'miniapp_invite_reward_rules',
      withFirstPaidEnabled(original)
    );
    try {
      const firstOrder = await seedPendingPaymentOrder(inviteeId);
      const beforeSettle = await callCheckInviteFirstPaidRewardRpc(inviteeId, firstOrder);
      rec.expect('订单尚未入账 → not_settled', 'not_settled', beforeSettle.status);

      await settlePaymentOrder(firstOrder);
      const granted = await callCheckInviteFirstPaidRewardRpc(inviteeId, firstOrder);
      rec.expect('首笔入账 → granted', 'granted', granted.status);
      rec.expect('发奖金额等于 invitee_first_paid 规则值', expectedCredits, granted.credits);

      // 四条入账路径都会重放挂点，重放必须零账务变化。
      const replay = await callCheckInviteFirstPaidRewardRpc(inviteeId, firstOrder);
      rec.expect('同一订单重放 → duplicated', 'duplicated', replay.status);
      rec.expect('重放金额为 0', 0, replay.credits);

      const secondOrder = await seedPendingPaymentOrder(inviteeId);
      await settlePaymentOrder(secondOrder);
      const second = await callCheckInviteFirstPaidRewardRpc(inviteeId, secondOrder);
      rec.expect('同一被邀请人复购 → not_first_paid', 'not_first_paid', second.status);
      rec.expect('复购金额为 0', 0, second.credits);

      const logs = await listRewardLogsByRelation(relationId);
      rec.expect('发奖明细恰 1 行', 1, logs.length);
      rec.expect('明细规则为 invitee_first_paid', FIRST_PAID_RULE_KEY, logs[0]?.rule_key);
      rec.expect('明细 event_ref 为首笔订单号', firstOrder, logs[0]?.event_ref);

      const ledger = await listInviteLedger(inviter.userId);
      rec.expect('invite_reward 流水恰 1 条', 1, ledger.length);
      rec.expect('流水 bonus_delta = 发奖金额', expectedCredits, ledger[0]?.bonus_delta);
      rec.expect(
        '邀请人 bonus 只增加一次发奖金额',
        expectedCredits,
        (await getBonusCredits(inviter.userId)) - bonusBefore
      );
    } finally {
      await override.restore();
    }

    rec.expect('config 已还原为原值', original, await readRewardRules());
  }
);

const firstPaidRewardLateEnable = defineScenario(
  'first_paid_reward_late_enable',
  '规则启用前被邀请人已付过款 → 启用后的复购不补发首付奖励',
  async (ctx, rec) => {
    const original = await readRewardRules();

    const inviter = await rec.inviter(nextCode());
    const inviteeTgId = rec.freshTgId();
    const bind = await postBind(ctx.baseUrl, buildInitData(inviteeTgId), inviter.code);
    rec.expect('绑定成功', 'bound', bind.data?.status);
    const inviteeId = await rec.claim(inviteeTgId);
    const relationId = (await listRelationsByInvitee(inviteeId))[0]?.id ?? '';
    const bonusBefore = await getBonusCredits(inviter.userId);

    const disabledOverride = await overrideConfig(
      'miniapp_invite_reward_rules',
      withFirstPaidDisabled(original)
    );
    try {
      // 规则关着时也照样付一笔并跑挂点：真实链路里挂点无条件调用，靠 grant 返回 skipped 兜住。
      const earlyOrder = await seedPendingPaymentOrder(inviteeId);
      await settlePaymentOrder(earlyOrder);
      const skipped = await callCheckInviteFirstPaidRewardRpc(inviteeId, earlyOrder);
      rec.expect('规则未启用 → skipped', 'skipped', skipped.status);
      rec.expect('未启用时金额为 0', 0, skipped.credits);
    } finally {
      await disabledOverride.restore();
    }

    const enabledOverride = await overrideConfig(
      'miniapp_invite_reward_rules',
      withFirstPaidEnabled(original)
    );
    try {
      const laterOrder = await seedPendingPaymentOrder(inviteeId);
      await settlePaymentOrder(laterOrder);
      const later = await callCheckInviteFirstPaidRewardRpc(inviteeId, laterOrder);
      rec.expect('启用后的复购 → not_first_paid', 'not_first_paid', later.status);
      rec.expect('金额为 0', 0, later.credits);
      rec.expect('全程无发奖明细', 0, (await listRewardLogsByRelation(relationId)).length);
      rec.expect('邀请人 bonus 零变化', bonusBefore, await getBonusCredits(inviter.userId));
    } finally {
      await enabledOverride.restore();
    }

    rec.expect('config 已还原为原值', original, await readRewardRules());
  }
);

const idempotencyReplay = defineScenario(
  'idempotency_replay',
  '绑定与达标事件重放多次 → invite_reward_logs 唯一键只入账一次（接口层 + 库层双打）',
  async (ctx, rec) => {
    const chatRule = getChatRoundsRule(await readRewardRules());
    const threshold = getThresholdRounds(chatRule);
    const inviter = await rec.inviter(nextCode());
    const inviteeTgId = rec.freshTgId();
    const initData = buildInitData(inviteeTgId);

    const first = await postBind(ctx.baseUrl, initData, inviter.code);
    rec.expect('首次 bound', 'bound', first.data?.status);
    const inviteeId = await rec.claim(inviteeTgId);

    const bonusAfterBind = await getBonusCredits(inviter.userId);
    const relationId = (await listRelationsByInvitee(inviteeId))[0]?.id ?? '';

    // 接口层重放：前端网络抖动 / 用户重开 MiniApp 都会走到这里。
    for (let i = 0; i < 5; i += 1) {
      const replay = await postBind(ctx.baseUrl, initData, inviter.code);
      rec.expect(`第 ${i + 1} 次接口重放 → already_bound`, 'already_bound', replay.data?.status);
    }

    rec.expect('绑定重放后仍无发奖明细', 0, (await listRewardLogsByRelation(relationId)).length);

    await setTotalRound(inviteeId, threshold);
    const firstGrant = await callCheckInviteChatRoundsRewardRpc(inviteeId);
    rec.expect('首次达标检查发奖', 'granted', firstGrant.status);

    // 库层重放：直接对同一 (relation, rule_key, event_ref) 调发奖 RPC。
    for (let i = 0; i < 3; i += 1) {
      const replay = await callGrantRewardRpc(relationId, CHAT_ROUNDS_RULE_KEY, inviteeId);
      rec.expect(`第 ${i + 1} 次 RPC 重放 → duplicated`, 'duplicated', replay.status);
      rec.expect(`第 ${i + 1} 次 RPC 重放金额为 0`, 0, replay.credits);
    }

    rec.expect('关系仍恰 1 行', 1, (await listRelationsByInvitee(inviteeId)).length);
    rec.expect('发奖明细仍恰 1 行', 1, (await listRewardLogsByRelation(relationId)).length);
    rec.expect('invite_reward 流水仍恰 1 条', 1, (await listInviteLedger(inviter.userId)).length);
    rec.expect(
      'bonus 只增加首次达标发奖金额',
      firstGrant.credits,
      (await getBonusCredits(inviter.userId)) - bonusAfterBind
    );
  }
);

const idempotencyRuleDisabled = defineScenario(
  'idempotency_rule_disabled',
  '未启用的规则（invitee_first_paid）→ skipped，不写明细不动账',
  async (ctx, rec) => {
    const inviter = await rec.inviter(nextCode());
    const inviteeTgId = rec.freshTgId();

    const bind = await postBind(ctx.baseUrl, buildInitData(inviteeTgId), inviter.code);
    rec.expect('绑定成功', 'bound', bind.data?.status);
    const inviteeId = await rec.claim(inviteeTgId);
    const relationId = (await listRelationsByInvitee(inviteeId))[0]?.id ?? '';

    const bonusBefore = await getBonusCredits(inviter.userId);
    const skipped = await callGrantRewardRpc(relationId, 'invitee_first_paid', 'order-uat-001');
    rec.expect('未启用规则 → skipped', 'skipped', skipped.status);
    rec.expect('金额为 0', 0, skipped.credits);

    const unknown = await callGrantRewardRpc(relationId, 'rule_that_does_not_exist', 'ref-001');
    rec.expect('配置中不存在的规则 → skipped', 'skipped', unknown.status);

    rec.expect('绑定后仍无发奖明细', 0, (await listRewardLogsByRelation(relationId)).length);
    rec.expect('bonus 零变化', bonusBefore, await getBonusCredits(inviter.userId));
  }
);

const rewardCap = defineScenario(
  'reward_cap',
  '累计触及 2200 上限 → 本次截断至恰好 cap，再发 cap_reached（跑完还原 config）',
  async (ctx, rec) => {
    const original = await readRewardRules();
    const cap = original.total_cap_credits;

    const inviter = await rec.inviter(nextCode());
    const inviteeTgId = rec.freshTgId();
    const bind = await postBind(ctx.baseUrl, buildInitData(inviteeTgId), inviter.code);
    rec.expect('绑定成功', 'bound', bind.data?.status);
    const inviteeId = await rec.claim(inviteeTgId);
    const relationId = (await listRelationsByInvitee(inviteeId))[0]?.id ?? '';
    const grantedAtStart = (await listRewardLogsByRelation(relationId)).reduce(
      (sum, log) => sum + log.credits,
      0
    );
    const bonusBefore = await getBonusCredits(inviter.userId);

    // 把第二条规则的金额抬到远超 cap，验证截断而非拒发。
    const override = await overrideConfig('miniapp_invite_reward_rules', {
      total_cap_credits: cap,
      rules: [
        { rule_key: 'invitee_registered', credits: 200, enabled: false },
        { rule_key: CHAT_ROUNDS_RULE_KEY, credits: 200, enabled: true, threshold_rounds: 3 },
        { rule_key: 'invitee_first_paid', credits: cap * 10, enabled: true },
      ],
    });
    try {
      const truncated = await callGrantRewardRpc(relationId, 'invitee_first_paid', 'order-cap-001');
      rec.expect('超限时仍发放（截断）', 'granted', truncated.status);
      rec.expect('截断金额 = cap - 已发', cap - grantedAtStart, truncated.credits);

      const total = (await listRewardLogsByRelation(relationId)).reduce(
        (sum, log) => sum + log.credits,
        0
      );
      rec.expect('单关系累计恰为 cap', cap, total);

      const again = await callGrantRewardRpc(relationId, 'invitee_first_paid', 'order-cap-002');
      rec.expect('已达上限再发 → cap_reached', 'cap_reached', again.status);
      rec.expect('金额为 0', 0, again.credits);

      const afterTotal = (await listRewardLogsByRelation(relationId)).reduce(
        (sum, log) => sum + log.credits,
        0
      );
      rec.expect('累计仍为 cap，未穿透', cap, afterTotal);

      // 账务对齐：钱包增量 = invite_reward 流水和 = 明细和。
      const ledgerSum = (await listInviteLedger(inviter.userId)).reduce(
        (sum, row) => sum + row.bonus_delta,
        0
      );
      rec.expect(
        '钱包增量 = 本场景发放总额',
        cap - grantedAtStart,
        (await getBonusCredits(inviter.userId)) - bonusBefore
      );
      rec.expect('流水和 = 明细和', cap, ledgerSum);
    } finally {
      await override.restore();
    }

    const restored = await readRewardRules();
    rec.expect('config 已还原为原值', original, restored);
  }
);

/** 并发用例的并发度：足够压出竞态，又不至于把 test 库打满。 */
const CONCURRENCY = 8;

function tally(statuses: string[]): Record<string, number> {
  return statuses.reduce<Record<string, number>>((acc, status) => {
    acc[status] = (acc[status] ?? 0) + 1;
    return acc;
  }, {});
}

const concurrencyBindRpc = defineScenario(
  'concurrency_bind_rpc',
  '库层并发：N 条连接同时对同一 invitee 调 bind_invite → 关系恰 1 行且不立即发奖',
  async (_ctx, rec) => {
    const inviter = await rec.inviter(nextCode());
    const invitee = await rec.user();
    const bonusBefore = await getBonusCredits(inviter.userId);

    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => callBindInviteRpc(invitee.userId, inviter.code))
    );
    const counts = tally(results.map((result) => result.status));
    rec.note('status_tally', counts);

    rec.expect('恰一个 bound', 1, counts['bound'] ?? 0);
    rec.expect('其余全为 already_bound', CONCURRENCY - 1, counts['already_bound'] ?? 0);
    rec.expect('无其它状态', 2, Object.keys(counts).length);

    const relations = await listRelationsByInvitee(invitee.userId);
    rec.expect('invite_relations 恰 1 行', 1, relations.length);
    const rewards = await listRewardLogsByRelation(relations[0]?.id ?? '');
    rec.expect('发奖明细仍为 0 行', 0, rewards.length);
    const ledger = await listInviteLedger(inviter.userId);
    rec.expect('invite_reward 流水仍为 0 条', 0, ledger.length);
    rec.expect('绑定后钱包无变化', 0, (await getBonusCredits(inviter.userId)) - bonusBefore);
  }
);

const concurrencyBindHttp = defineScenario(
  'concurrency_bind_http',
  '接口层并发：用户行尚未创建时 N 个并发 bind 请求（首开竞态）→ 仍只绑一次且不立即发奖',
  async (ctx, rec) => {
    const inviter = await rec.inviter(nextCode());
    // 关键：此刻库里还没有这个用户，N 个请求会同时走 getOrCreateDbUser 建号。
    // 这正是阶段一 D4 时间窗要吸收的竞态，此前只在库层验证过。
    const inviteeTgId = rec.freshTgId();
    const initData = buildInitData(inviteeTgId);
    const bonusBefore = await getBonusCredits(inviter.userId);

    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => postBind(ctx.baseUrl, initData, inviter.code))
    );
    const statuses = results.map((result) => result.data?.status ?? `http_${result.status}`);
    const counts = tally(statuses);
    rec.note('status_tally', counts);

    rec.expect('全部 200', [200], [...new Set(results.map((r) => r.status))]);
    rec.expect('恰一个 bound', 1, counts['bound'] ?? 0);
    rec.expect('其余全为 already_bound', CONCURRENCY - 1, counts['already_bound'] ?? 0);

    const inviteeId = await rec.claim(inviteeTgId);
    const relations = await listRelationsByInvitee(inviteeId);
    rec.expect('invite_relations 恰 1 行', 1, relations.length);
    const rewards = await listRewardLogsByRelation(relations[0]?.id ?? '');
    rec.expect('发奖明细仍为 0 行', 0, rewards.length);
    rec.expect('invite_reward 流水仍为 0 条', 0, (await listInviteLedger(inviter.userId)).length);
    rec.expect('绑定后钱包无变化', 0, (await getBonusCredits(inviter.userId)) - bonusBefore);
    rec.expect('source_id 恰为 invite', INVITE_SOURCE_ID, await getSourceId(inviteeId));
  }
);

const concurrencyGrantReward = defineScenario(
  'concurrency_grant_reward',
  '库层并发：同参数并发调 invitee_chat_rounds 发奖 → 唯一键吸收，只入账一次',
  async (_ctx, rec) => {
    const chatRule = getChatRoundsRule(await readRewardRules());
    const inviter = await rec.inviter(nextCode());
    const invitee = await rec.user();
    const bound = await callBindInviteRpc(invitee.userId, inviter.code);
    rec.expect('前置绑定成功', 'bound', bound.status);
    const relationId = bound.relation_id ?? '';

    const bonusBefore = await getBonusCredits(inviter.userId);
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        callGrantRewardRpc(relationId, CHAT_ROUNDS_RULE_KEY, invitee.userId)
      )
    );
    const counts = tally(results.map((result) => result.status));
    rec.note('status_tally', counts);

    rec.expect('恰一个 granted', 1, counts['granted'] ?? 0);
    rec.expect('其余全为 duplicated', CONCURRENCY - 1, counts['duplicated'] ?? 0);
    rec.expect('发奖明细仍恰 1 行', 1, (await listRewardLogsByRelation(relationId)).length);
    rec.expect('invite_reward 流水仍恰 1 条', 1, (await listInviteLedger(inviter.userId)).length);
    rec.expect(
      'bonus 只增加一笔发奖金额',
      chatRule.credits,
      (await getBonusCredits(inviter.userId)) - bonusBefore
    );
  }
);

const concurrencyChatRoundCheck = defineScenario(
  'concurrency_chat_round_check',
  '库层并发：多次达标检查同时触发 → 只发一笔 invitee_chat_rounds',
  async (_ctx, rec) => {
    const chatRule = getChatRoundsRule(await readRewardRules());
    const threshold = getThresholdRounds(chatRule);
    const inviter = await rec.inviter(nextCode());
    const invitee = await rec.user();
    const bound = await callBindInviteRpc(invitee.userId, inviter.code);
    rec.expect('前置绑定成功', 'bound', bound.status);
    await setTotalRound(invitee.userId, threshold);
    const relationId = bound.relation_id ?? '';
    const bonusBefore = await getBonusCredits(inviter.userId);

    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => callCheckInviteChatRoundsRewardRpc(invitee.userId))
    );
    const counts = tally(results.map((result) => result.status));
    rec.note('status_tally', counts);

    rec.expect('恰一个 granted', 1, counts['granted'] ?? 0);
    rec.expect('其余全为 duplicated', CONCURRENCY - 1, counts['duplicated'] ?? 0);
    rec.expect('发奖明细恰 1 行', 1, (await listRewardLogsByRelation(relationId)).length);
    rec.expect('invite_reward 流水恰 1 条', 1, (await listInviteLedger(inviter.userId)).length);
    rec.expect(
      'bonus 只增加一笔发奖金额',
      chatRule.credits,
      (await getBonusCredits(inviter.userId)) - bonusBefore
    );
  }
);

const concurrencyEnsureCode = defineScenario(
  'concurrency_ensure_code',
  '并发进入邀请中心 → 邀请码唯一且固定，首次进入标记只落一次',
  async (ctx, rec) => {
    const user = await rec.user();

    // 库层并发：撞码重试与 center_first_entered_at 的 IS NULL 守卫。
    const rpcResults = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => callEnsureInviteCodeRpc(user.userId))
    );
    const codes = [...new Set(rpcResults.map((result) => result.code))];
    rec.expect('并发下只产生一个邀请码', 1, codes.length);
    rec.note('code', codes[0]);

    const row = await getInviteCodeRow(user.userId);
    rec.expect('邀请码行存在', codes[0], row?.code);
    rec.expect('首次进入时间已落库', true, row?.center_first_entered_at !== null);

    // 接口层并发：center-view 是幂等 POST，重复调用码不变。
    const other = await rec.user();
    const initData = buildInitData(other.tgId);
    const httpResults = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => postCenterView(ctx.baseUrl, initData))
    );
    rec.expect('全部 200', [200], [...new Set(httpResults.map((r) => r.status))]);
    const httpCodes = [...new Set(httpResults.map((result) => result.data?.invite_code))];
    rec.expect('接口层并发下码唯一', 1, httpCodes.length);

    const firstVisitCount = httpResults.filter((r) => r.data?.first_visit === true).length;
    // ensure_invite_code 的语义：首次进入的那一刻起 center_first_entered_at 非空，
    // 但并发批次里可能有多个请求同时读到 NULL。至少要保证后续请求稳定为 false。
    rec.note('first_visit_count_in_burst', firstVisitCount);
    const settled = await postCenterView(ctx.baseUrl, initData);
    rec.expect('并发批次之后 first_visit 恒为 false', false, settled.data?.first_visit);
    rec.expect('码保持不变', httpCodes[0], settled.data?.invite_code);
  }
);

const authGuard = defineScenario(
  'auth_guard',
  '四条路由未鉴权 → 401（脚本已关 DEV_AUTH_BYPASS，否则会被兜底成固定用户）',
  async (ctx, rec) => {
    rec.expect('entry-status 无 header → 401', 401, (await getEntryStatus(ctx.baseUrl)).status);
    rec.expect('center-view 无 header → 401', 401, (await postCenterView(ctx.baseUrl)).status);
    rec.expect(
      'bind 无 header → 401',
      401,
      (await postBind(ctx.baseUrl, undefined, 'ABCD1234')).status
    );
    rec.expect('stats 无 header → 401', 401, (await getStats(ctx.baseUrl)).status);

    // 畸形 initData 同样必须被拒（MOCK_AUTH 分支解析失败会落到验签路径）。
    rec.expect(
      '畸形 initData → 401',
      401,
      (await getEntryStatus(ctx.baseUrl, 'not-a-valid-init-data')).status
    );
  }
);

const entrySwitch = defineScenario(
  'entry_switch',
  '入口总开关 false → entry_enabled 关闭；开关不影响绑定链路本身',
  async (ctx, rec) => {
    const user = await rec.user();
    const initData = buildInitData(user.tgId);

    const enabledOverride = await overrideConfig('miniapp_invite_entry_enabled', true);
    try {
      const on = await getEntryStatus(ctx.baseUrl, initData);
      rec.expect('开关 true → entry_enabled=true', true, on.data?.entry_enabled);
    } finally {
      await enabledOverride.restore();
    }

    const disabledOverride = await overrideConfig('miniapp_invite_entry_enabled', false);
    try {
      const off = await getEntryStatus(ctx.baseUrl, initData);
      rec.expect('开关 false → entry_enabled=false', false, off.data?.entry_enabled);

      // 开关只控制入口显隐，不阻断已发出的深链绑定（避免关开关期间漏归因）。
      const inviter = await rec.inviter(nextCode());
      const inviteeTgId = rec.freshTgId();
      const bind = await postBind(ctx.baseUrl, buildInitData(inviteeTgId), inviter.code);
      rec.expect('开关关闭时绑定链路仍生效', 'bound', bind.data?.status);
      await rec.claim(inviteeTgId);
    } finally {
      await disabledOverride.restore();
    }
  }
);

const centerViewSemantics = defineScenario(
  'center_view_semantics',
  '邀请中心初始化：码永久固定、first_visit 只 true 一次、链接与文案契约完整',
  async (ctx, rec) => {
    const user = await rec.user();
    const initData = buildInitData(user.tgId);

    const before = await getEntryStatus(ctx.baseUrl, initData);
    rec.expect('进入前 center_entered=false', false, before.data?.center_entered);

    const first = await postCenterView(ctx.baseUrl, initData);
    rec.expect('首次进入 first_visit=true', true, first.data?.first_visit);
    rec.expect('邀请码为 8 位大写', true, /^[A-Z0-9]{8}$/.test(first.data?.invite_code ?? ''));
    rec.expect('文案库非空', true, (first.data?.copy_templates.length ?? 0) > 0);
    rec.expect(
      '文案含 {link} 占位符',
      true,
      (first.data?.copy_templates ?? []).every((template) => template.includes('{link}'))
    );
    rec.note('invite_link', first.data?.invite_link);
    rec.note('poster_url', first.data?.poster_url);

    // 链接要么是完整深链（带 inv_ 前缀的 startapp），要么是空串（无 bot token 降级）。
    const link = first.data?.invite_link ?? '';
    const linkOk =
      link === '' ||
      (link.startsWith('https://t.me/') &&
        link.includes(`startapp=inv_${first.data?.invite_code}`));
    rec.expect('invite_link 形态合法（完整深链或降级空串）', true, linkOk);

    const second = await postCenterView(ctx.baseUrl, initData);
    rec.expect('再次进入 first_visit=false', false, second.data?.first_visit);
    rec.expect('邀请码不变', first.data?.invite_code, second.data?.invite_code);

    const after = await getEntryStatus(ctx.baseUrl, initData);
    rec.expect('进入后 center_entered=true（服务端字段）', true, after.data?.center_entered);
  }
);

/** 数据中心「最近到账」的下发条数上限，与 routes/invite.ts 的 RECENT_REWARDS_LIMIT 一致。 */
const RECENT_REWARDS_LIMIT = 10;

const statsAlignment = defineScenario(
  'stats_alignment',
  '数据中心口径：人数 = relations count、星尘 = reward_logs sum、到账记录时间倒序且截断到 10 条',
  async (ctx, rec) => {
    const inviter = await rec.inviter(nextCode());
    const inviterInitData = buildInitData(inviter.tgId);

    const empty = await getStats(ctx.baseUrl, inviterInitData);
    rec.expect('无下级时人数为 0', 0, empty.data?.invited_count);
    rec.expect('无下级时星尘为 0', 0, empty.data?.total_reward_credits);
    rec.expect('无下级时到账记录为空', 0, empty.data?.recent_rewards.length);
    rec.expect('update_mode 恒为 realtime', 'realtime', empty.data?.update_mode);

    // 造 3 个下级关系；再给其中一个补一笔额外奖励，让"人数 ≠ 记录条数"。
    const inviteeCount = 3;
    for (let i = 0; i < inviteeCount; i += 1) {
      const tgId = rec.freshTgId();
      const bind = await postBind(ctx.baseUrl, buildInitData(tgId), inviter.code);
      rec.expect(`第 ${i + 1} 个下级绑定成功`, 'bound', bind.data?.status);
      await rec.claim(tgId);
    }

    const relations = await listRelationsByInviter(inviter.userId);
    rec.expect('库内关系数 = 3', inviteeCount, relations.length);

    const extraOverride = await overrideConfig('miniapp_invite_reward_rules', {
      total_cap_credits: 2200,
      rules: [
        { rule_key: 'invitee_registered', credits: 200, enabled: false },
        { rule_key: CHAT_ROUNDS_RULE_KEY, credits: 200, enabled: true, threshold_rounds: 3 },
        { rule_key: 'invitee_first_paid', credits: 300, enabled: true },
      ],
    });
    try {
      const extra = await callGrantRewardRpc(
        relations[0]?.id ?? '',
        'invitee_first_paid',
        'order-stats-001'
      );
      rec.expect('额外奖励发放成功', 'granted', extra.status);
    } finally {
      await extraOverride.restore();
    }

    const logs = await listRewardLogsByInviter(inviter.userId);
    const expectedSum = logs.reduce((sum, log) => sum + log.credits, 0);

    const stats = await getStats(ctx.baseUrl, inviterInitData);
    rec.expect('人数 = relations count', relations.length, stats.data?.invited_count);
    rec.expect('星尘 = reward_logs sum', expectedSum, stats.data?.total_reward_credits);
    rec.expect(
      '到账记录条数 = min(明细数, 10)',
      Math.min(logs.length, RECENT_REWARDS_LIMIT),
      stats.data?.recent_rewards.length
    );

    const returned = stats.data?.recent_rewards ?? [];
    const timestamps = returned.map((record) => new Date(record.granted_at).getTime());
    const sortedDesc = [...timestamps].sort((a, b) => b - a);
    rec.expect('到账记录按时间倒序', sortedDesc, timestamps);
    rec.expect(
      '逐条金额与库内明细对齐',
      logs.slice(0, RECENT_REWARDS_LIMIT).map((log) => log.credits),
      returned.map((record) => record.credits)
    );
    rec.expect(
      '逐条 rule_key 与库内明细对齐',
      logs.slice(0, RECENT_REWARDS_LIMIT).map((log) => log.rule_key),
      returned.map((record) => record.rule_key)
    );

    // 钱包与流水的三方对齐（PRD：奖励状态与到账时间需可追踪）。
    const ledgerSum = (await listInviteLedger(inviter.userId)).reduce(
      (sum, row) => sum + row.bonus_delta,
      0
    );
    rec.expect('invite_reward 流水和 = 明细和', expectedSum, ledgerSum);
    rec.note('reward_log_count', logs.length);
    rec.note('total_credits', expectedSum);
  }
);

const statsTruncation = defineScenario(
  'stats_truncation',
  '到账记录超过 10 条 → 只下发最近 10 条，累计星尘仍为全量和',
  async (ctx, rec) => {
    const inviter = await rec.inviter(nextCode());
    const invitee = await rec.user();
    const bound = await callBindInviteRpc(invitee.userId, inviter.code);
    rec.expect('前置绑定成功', 'bound', bound.status);
    const relationId = bound.relation_id ?? '';

    // 用不同 event_ref 造 12 笔明细：唯一键是 (relation, rule_key, event_ref)，
    // 换 event_ref 即为不同事件，正好模拟"多次奖励事件"。
    const override = await overrideConfig('miniapp_invite_reward_rules', {
      total_cap_credits: 100_000,
      rules: [
        { rule_key: 'invitee_registered', credits: 200, enabled: false },
        { rule_key: CHAT_ROUNDS_RULE_KEY, credits: 200, enabled: true, threshold_rounds: 3 },
        { rule_key: 'invitee_first_paid', credits: 50, enabled: true },
      ],
    });
    try {
      for (let i = 0; i < 12; i += 1) {
        const result = await callGrantRewardRpc(
          relationId,
          'invitee_first_paid',
          `order-trunc-${String(i).padStart(3, '0')}`
        );
        rec.expect(`第 ${i + 1} 笔发放成功`, 'granted', result.status);
      }
    } finally {
      await override.restore();
    }

    const logs = await listRewardLogsByInviter(inviter.userId);
    rec.expect('库内明细共 12 条', 12, logs.length);

    const stats = await getStats(ctx.baseUrl, buildInitData(inviter.tgId));
    rec.expect('下发恰 10 条', RECENT_REWARDS_LIMIT, stats.data?.recent_rewards.length);
    rec.expect(
      '累计星尘为全量和（不受截断影响）',
      logs.reduce((sum, log) => sum + log.credits, 0),
      stats.data?.total_reward_credits
    );
    rec.expect('人数仍为 1（一个下级多笔奖励）', 1, stats.data?.invited_count);
  }
);

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

const statsLatency = defineScenario(
  'stats_latency',
  '实时查询压测：数据中心聚合相对基线路由无显著额外开销 → 维持实时方案，不启动批量快照预案',
  async (ctx, rec) => {
    const inviter = await rec.inviter(nextCode());
    const inviterInitData = buildInitData(inviter.tgId);

    // 造 10 个下级，让聚合查询有真实数据量（count + sum 都不是空表）。
    for (let i = 0; i < 10; i += 1) {
      const tgId = rec.freshTgId();
      await postBind(ctx.baseUrl, buildInitData(tgId), inviter.code);
      await rec.claim(tgId);
    }

    // 判据取「两条路由的最快样本之差」，而不是绝对毫秒或分位数比值。
    //
    // 原因：本机跑脚本时后端到 Supabase 走公网，绝对延迟主要由公网往返决定（实测同一
    // 份代码在链路劣化时 p50 从 1.1s 涨到 11s、p95 到 79s），分位数会把环境问题误报成
    // 性能不达标。网络抖动只会让样本变慢、不会变快，所以最小值是受污染最少的估计量。
    //
    // entry-status 与 stats 都是「鉴权 + 两个并行 Supabase 查询」的同构形状：前者是
    // 单行读，后者是 count + 聚合。两者最快样本之差即聚合本身的额外开销，公网 RTT 在
    // 相减时被抵消掉。
    //
    // ⚠️ 这只能证明「聚合没有数量级开销」。真实用户侧延迟必须在部署环境测（Railway 与
    // Supabase 同区，无公网绕行），归入阶段四上线后观测。
    const rounds = 4;
    const baseline: number[] = [];
    const target: number[] = [];

    for (let round = 0; round < rounds; round += 1) {
      // 交替测量，让两组样本承受同一段时间窗内的网络状况。
      const batch = await Promise.all([
        ...Array.from({ length: CONCURRENCY / 2 }, async () => {
          const start = performance.now();
          const result = await getEntryStatus(ctx.baseUrl, inviterInitData);
          return {
            kind: 'baseline' as const,
            ms: performance.now() - start,
            status: result.status,
          };
        }),
        ...Array.from({ length: CONCURRENCY / 2 }, async () => {
          const start = performance.now();
          const result = await getStats(ctx.baseUrl, inviterInitData);
          return { kind: 'target' as const, ms: performance.now() - start, status: result.status };
        }),
      ]);
      for (const item of batch) {
        rec.expect('压测请求全部 200', 200, item.status);
        (item.kind === 'baseline' ? baseline : target).push(item.ms);
      }
    }

    const baseSorted = [...baseline].sort((a, b) => a - b);
    const targetSorted = [...target].sort((a, b) => a - b);
    const baseFloor = baseSorted[0] ?? 0;
    const targetFloor = targetSorted[0] ?? 0;
    const overheadMs = targetFloor - baseFloor;

    rec.note('samples_per_group', baseline.length);
    rec.note('baseline_min_ms', Math.round(baseFloor));
    rec.note('stats_min_ms', Math.round(targetFloor));
    rec.note('aggregation_overhead_ms', Math.round(overheadMs));
    rec.note('baseline_p50_ms', Math.round(percentile(baseSorted, 0.5)));
    rec.note('stats_p50_ms', Math.round(percentile(targetSorted, 0.5)));
    rec.note('link_degraded', percentile(baseSorted, 0.5) > 2000);

    // 阈值 500ms：count + 聚合比单行读多一次往返是正常的，但不该出现数量级差异。
    // 超过说明缺索引或数据量已压不住，该按方案 §6 启动批量快照预案。
    rec.expect('数据中心聚合额外开销 < 500ms（最快样本之差）', true, overheadMs < 500);
  }
);

/**
 * 执行顺序：先归因边界（最贴 PRD），再幂等与上限，再并发防刷，最后接口层与数据口径。
 * 顺序无依赖，任一场景可用 --scenario 单跑。
 */
export const SCENARIOS: Scenario[] = [
  attributionHappyPath,
  attributionSelfInvite,
  attributionLastClickWins,
  attributionExistingUser,
  attributionInvalidCode,
  attributionCodeNormalization,
  attributionSourceIdGuard,
  chatRoundRewardThreshold,
  chatRoundRewardBindBackfill,
  legacyRegisteredRewardNoDoublePay,
  firstPaidRewardGrant,
  firstPaidRewardLateEnable,
  idempotencyReplay,
  idempotencyRuleDisabled,
  rewardCap,
  concurrencyBindRpc,
  concurrencyBindHttp,
  concurrencyGrantReward,
  concurrencyChatRoundCheck,
  concurrencyEnsureCode,
  authGuard,
  entrySwitch,
  centerViewSemantics,
  statsAlignment,
  statsTruncation,
  statsLatency,
];
