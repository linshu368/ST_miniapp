import { prisma } from '../../lib/db.js';
import type {
  CsAuditLogData,
  CsMessageData,
  CsPersonaData,
  CsSendStatus,
  CsSessionData,
  CsSessionStatus,
  CsSopStageData,
  CsUserData,
} from '@miniapp/shared';

interface PersonaRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  color: string;
  sql_text: string;
  opening_script: string;
  sop: CsSopStageData[] | null;
  status: 'active' | 'archived';
  active_count: number;
  chatted_left_count: number;
  last_refreshed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface RefreshRow {
  result: {
    run_id: string;
    active_count: number;
    entered_count: number;
    chatted_left_count: number;
    refreshed_at: string;
  };
}

interface SessionRow {
  persona_id: string;
  user_id: string;
  status: CsSessionStatus;
  current_stage: string | null;
  current_question_key: string | null;
  next_touch_at: Date | string | null;
  completed_at: Date | string | null;
  skipped_at: Date | string | null;
  skip_reason: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface PublicUserRow {
  id: string;
  tg_id: string;
}

const DEFAULT_SOP: CsSopStageData[] = [
  {
    key: 'icebreaker',
    title: '破冰',
    prompt: 'Hi~ 我是XX的运营客服，想花几分钟听听你的使用感受，方便吗？',
  },
  {
    key: 'pain',
    title: '体验痛点',
    prompt:
      '您平时跟角色聊天的时候，有没有遇到什么让您特别不爽的地方？卡顿、bug、或者觉得哪里别扭的，都算。',
    followups: ['这种情况大概多久出现一次？', '当时是在什么场景下？'],
  },
  {
    key: 'feature',
    title: '最想要的功能',
    prompt: '如果我们接下来只能加一个新功能，您最希望是什么？',
    followups: ['这个功能对您来说主要是解决什么问题？'],
    fallback_options: [
      '① 语音消息（让角色用语音念出来）',
      '② 状态栏（看到角色心情/好感度）',
      '③ 超强记忆（聊几百回合不失忆）',
      '④ 生成图片（根据场景生成角色图）',
      '⑤ 自建角色卡（自己创建和保存角色）',
    ],
  },
  {
    key: 'role_preference',
    title: '角色卡偏好',
    prompt: '您有没有特别想聊但我们大厅里没有的角色类型？什么设定都行',
  },
  {
    key: 'closing',
    title: '收尾',
    prompt:
      '感谢你的真实反馈，这对我们很重要。以后有任何不爽的地方，随时找我，我帮您催开发！祝您玩得开心~',
  },
];

export class CsPlatformRepository {
  async listPersonas(): Promise<CsPersonaData[]> {
    const rows = await prisma.$queryRawUnsafe<PersonaRow[]>(
      `SELECT * FROM cs_platform.personas WHERE status = 'active' ORDER BY created_at ASC`
    );
    return rows.map(toPersonaData);
  }

  async getPersona(personaId: string): Promise<CsPersonaData | null> {
    const rows = await prisma.$queryRawUnsafe<PersonaRow[]>(
      `SELECT * FROM cs_platform.personas WHERE id = $1::uuid LIMIT 1`,
      personaId
    );
    return rows[0] ? toPersonaData(rows[0]) : null;
  }

  async createPersona(input: {
    name: string;
    description?: string;
    color?: string;
    sql: string;
    openingScript: string;
    sop?: CsSopStageData[];
    operatorId: string;
  }): Promise<CsPersonaData> {
    const normalizedSql = normalizePersonaSql(input.sql);
    await this.validatePersonaSql(normalizedSql);
    const rows = await prisma.$queryRawUnsafe<PersonaRow[]>(
      `INSERT INTO cs_platform.personas (slug, name, description, color, sql_text, opening_script, sop)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       RETURNING *`,
      createSlug(input.name),
      input.name,
      input.description ?? '',
      input.color ?? '#5BBD72',
      normalizedSql,
      input.openingScript,
      JSON.stringify(input.sop?.length ? input.sop : DEFAULT_SOP)
    );
    const persona = expectOne(rows, '创建画像簇失败：数据库未返回记录');
    await this.log(input.operatorId, 'persona.create', persona.id, null, { name: input.name });
    return toPersonaData(persona);
  }

  async updatePersona(
    personaId: string,
    input: Partial<{
      name: string;
      description: string;
      color: string;
      sql: string;
      openingScript: string;
      sop: CsSopStageData[];
      status: 'active' | 'archived';
    }> & { operatorId: string }
  ): Promise<CsPersonaData> {
    const current = await this.getPersona(personaId);
    if (!current) throw new Error('画像簇不存在');
    const normalizedSql = input.sql ? normalizePersonaSql(input.sql) : undefined;
    if (normalizedSql) await this.validatePersonaSql(normalizedSql);

    const rows = await prisma.$queryRawUnsafe<PersonaRow[]>(
      `UPDATE cs_platform.personas
       SET name = $2,
           description = $3,
           color = $4,
           sql_text = $5,
           opening_script = $6,
           sop = $7::jsonb,
           status = $8,
           updated_at = now()
       WHERE id = $1::uuid
       RETURNING *`,
      personaId,
      input.name ?? current.name,
      input.description ?? current.description,
      input.color ?? current.color,
      normalizedSql ?? current.sql,
      input.openingScript ?? current.opening_script,
      JSON.stringify(input.sop ?? current.sop),
      input.status ?? current.status
    );
    const persona = expectOne(rows, '更新画像簇失败：数据库未返回记录');
    await this.log(input.operatorId, 'persona.update', personaId, null, {});
    return toPersonaData(persona);
  }

  async archivePersona(personaId: string, operatorId: string): Promise<CsPersonaData> {
    const rows = await prisma.$queryRawUnsafe<PersonaRow[]>(
      `UPDATE cs_platform.personas
       SET status = 'archived',
           updated_at = now()
       WHERE id = $1::uuid
         AND status = 'active'
       RETURNING *`,
      personaId
    );
    const persona = expectOne(rows, '删除画像簇失败：画像簇不存在或已删除');
    await this.log(operatorId, 'persona.archive', personaId, null, { name: persona.name });
    return toPersonaData(persona);
  }

  async refreshPersona(personaId: string, operatorId: string): Promise<RefreshRow['result']> {
    const rows = await prisma.$queryRawUnsafe<RefreshRow[]>(
      `SELECT cs_platform.refresh_persona_members($1::uuid, $2::text) AS result`,
      personaId,
      operatorId
    );
    return expectOne(rows, '刷新画像簇失败：数据库未返回记录').result;
  }

  async listUsers(
    personaId: string
  ): Promise<{ active: CsUserData[]; chatted_left: CsUserData[] }> {
    const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT * FROM cs_platform.persona_users_detail
       WHERE persona_id = $1::uuid
       ORDER BY last_active_at DESC NULLS LAST`,
      personaId
    );
    const users = rows.map(toUserData);
    return {
      active: users.filter((user) => user.membership_status === 'active'),
      chatted_left: users.filter((user) => user.membership_status === 'chatted_left'),
    };
  }

  async getSession(personaId: string, userId: string): Promise<CsSessionData> {
    const [persona, session] = await Promise.all([
      this.getPersona(personaId),
      this.getOrCreateSession(personaId, userId),
    ]);
    if (!persona) throw new Error('画像簇不存在');
    return toSessionData(session, persona.sop);
  }

  async advanceSession(
    personaId: string,
    userId: string,
    input: {
      nextStage?: string;
      nextQuestionKey?: string;
      status?: CsSessionStatus;
      operatorId: string;
    }
  ): Promise<CsSessionData> {
    const status = input.status ?? 'following_up';
    const rows = await prisma.$queryRawUnsafe<SessionRow[]>(
      `UPDATE cs_platform.outreach_sessions
       SET status = $3,
           current_stage = $4,
           current_question_key = $5,
           completed_at = CASE WHEN $3 = 'completed' THEN now() ELSE completed_at END,
           updated_at = now()
       WHERE persona_id = $1::uuid AND user_id = $2::uuid
       RETURNING *`,
      personaId,
      userId,
      status,
      input.nextStage ?? null,
      input.nextQuestionKey ?? input.nextStage ?? null
    );
    await this.log(input.operatorId, 'session.advance', personaId, userId, { status });
    const persona = await this.getPersona(personaId);
    return toSessionData(
      expectOne(rows, '推进会话失败：数据库未返回记录'),
      persona?.sop ?? DEFAULT_SOP
    );
  }

  async snoozeSession(
    personaId: string,
    userId: string,
    input: { nextTouchAt?: string; operatorId: string }
  ): Promise<CsSessionData> {
    const nextTouchAt =
      input.nextTouchAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const rows = await prisma.$queryRawUnsafe<SessionRow[]>(
      `UPDATE cs_platform.outreach_sessions
       SET status = 'snoozed', next_touch_at = $3::timestamptz, updated_at = now()
       WHERE persona_id = $1::uuid AND user_id = $2::uuid
       RETURNING *`,
      personaId,
      userId,
      nextTouchAt
    );
    await this.log(input.operatorId, 'session.snooze', personaId, userId, { nextTouchAt });
    const persona = await this.getPersona(personaId);
    return toSessionData(
      expectOne(rows, '稍后跟进失败：数据库未返回记录'),
      persona?.sop ?? DEFAULT_SOP
    );
  }

  async skipSession(
    personaId: string,
    userId: string,
    input: { reason?: string; operatorId: string }
  ): Promise<CsSessionData> {
    const rows = await prisma.$queryRawUnsafe<SessionRow[]>(
      `UPDATE cs_platform.outreach_sessions
       SET status = 'skipped', skipped_at = now(), skip_reason = $3, updated_at = now()
       WHERE persona_id = $1::uuid AND user_id = $2::uuid
       RETURNING *`,
      personaId,
      userId,
      input.reason ?? null
    );
    await this.log(input.operatorId, 'session.skip', personaId, userId, { reason: input.reason });
    const persona = await this.getPersona(personaId);
    return toSessionData(
      expectOne(rows, '跳过会话失败：数据库未返回记录'),
      persona?.sop ?? DEFAULT_SOP
    );
  }

  async listMessages(personaId: string, userId: string): Promise<CsMessageData[]> {
    const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT * FROM cs_platform.outreach_messages
       WHERE persona_id = $1::uuid AND user_id = $2::uuid
       ORDER BY created_at ASC`,
      personaId,
      userId
    );
    return rows.map(toMessageData);
  }

  async createPendingAgentMessage(input: {
    personaId: string;
    userId: string;
    telegramUserId: string;
    content: string;
    sopStage?: string;
    questionKey?: string;
    idempotencyKey?: string;
    operatorId: string;
  }): Promise<CsMessageData> {
    await this.getOrCreateSession(input.personaId, input.userId);
    const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `INSERT INTO cs_platform.outreach_messages (
        persona_id, user_id, telegram_user_id, direction, sop_stage, question_key,
        content, send_status, idempotency_key, operator_id
       )
       VALUES ($1::uuid, $2::uuid, $3, 'agent', $4, $5, $6, 'pending', $7, $8)
       RETURNING *`,
      input.personaId,
      input.userId,
      input.telegramUserId,
      input.sopStage ?? null,
      input.questionKey ?? null,
      input.content,
      input.idempotencyKey ?? null,
      input.operatorId
    );
    return toMessageData(expectOne(rows, '创建消息失败：数据库未返回记录'));
  }

  async markAgentMessage(input: {
    messageId: string;
    personaId: string;
    userId: string;
    status: Extract<CsSendStatus, 'sent' | 'failed'>;
    telegramMessageId?: string;
    failedReason?: string;
    sopStage?: string;
    questionKey?: string;
    operatorId: string;
  }): Promise<CsMessageData> {
    const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `UPDATE cs_platform.outreach_messages
       SET send_status = $2,
           telegram_message_id = $3,
           sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE NULL END,
           failed_reason = $4
       WHERE id = $1::uuid
       RETURNING *`,
      input.messageId,
      input.status,
      input.telegramMessageId ?? null,
      input.failedReason ?? null
    );

    await prisma.$executeRawUnsafe(
      `INSERT INTO cs_platform.outreach_sessions (
        persona_id, user_id, status, current_stage, current_question_key, updated_at
       )
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, now())
       ON CONFLICT (persona_id, user_id) DO UPDATE
       SET status = EXCLUDED.status,
           current_stage = EXCLUDED.current_stage,
           current_question_key = EXCLUDED.current_question_key,
           updated_at = now()`,
      input.personaId,
      input.userId,
      input.status === 'sent' ? 'waiting_reply' : 'send_failed',
      input.sopStage ?? input.questionKey ?? 'manual',
      input.questionKey ?? input.sopStage ?? 'manual'
    );

    if (input.status === 'sent') {
      await prisma.$executeRawUnsafe(
        `UPDATE cs_platform.persona_member_state
         SET first_contacted_at = COALESCE(first_contacted_at, now()),
             last_contacted_at = now()
         WHERE persona_id = $1::uuid AND user_id = $2::uuid`,
        input.personaId,
        input.userId
      );
    }

    await this.log(
      input.operatorId,
      input.status === 'sent' ? 'message.send' : 'message.send_failed',
      input.personaId,
      input.userId,
      {
        messageId: input.messageId,
        telegramMessageId: input.telegramMessageId,
        failedReason: input.failedReason,
      }
    );

    return toMessageData(expectOne(rows, '更新消息失败：数据库未返回记录'));
  }

  async receiveTelegramMessage(input: {
    telegramUserId: string;
    content: string;
    telegramMessageId?: string;
  }): Promise<CsMessageData | null> {
    const user = await this.findUserByTelegramId(input.telegramUserId);
    if (!user) return null;

    const sessions = await prisma.$queryRawUnsafe<SessionRow[]>(
      `SELECT * FROM cs_platform.outreach_sessions
       WHERE user_id = $1::uuid
         AND status IN ('waiting_reply', 'following_up', 'icebreaking', 'snoozed', 'send_failed')
       ORDER BY updated_at DESC
       LIMIT 1`,
      user.id
    );
    const session = sessions[0];
    if (!session) return null;

    const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `INSERT INTO cs_platform.outreach_messages (
        persona_id, user_id, telegram_user_id, direction, sop_stage, question_key,
        content, send_status, telegram_message_id, received_at
       )
       VALUES ($1::uuid, $2::uuid, $3, 'user', $4, $5, $6, 'received', $7, now())
       RETURNING *`,
      session.persona_id,
      session.user_id,
      input.telegramUserId,
      session.current_stage,
      session.current_question_key,
      input.content,
      input.telegramMessageId ?? null
    );

    await prisma.$executeRawUnsafe(
      `UPDATE cs_platform.outreach_sessions
       SET status = 'following_up', updated_at = now()
       WHERE persona_id = $1::uuid AND user_id = $2::uuid`,
      session.persona_id,
      session.user_id
    );

    return toMessageData(expectOne(rows, '接收 Telegram 消息失败：数据库未返回记录'));
  }

  async findUserByTelegramId(telegramUserId: string): Promise<PublicUserRow | null> {
    const rows = await prisma.$queryRawUnsafe<PublicUserRow[]>(
      `SELECT id, tg_id FROM public.users WHERE tg_id = $1 LIMIT 1`,
      telegramUserId
    );
    return rows[0] ?? null;
  }

  async listAuditLogs(): Promise<CsAuditLogData[]> {
    const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT * FROM cs_platform.audit_logs ORDER BY created_at DESC LIMIT 100`
    );
    return rows.map((row) => ({
      id: String(row.id),
      operator_id: String(row.operator_id),
      action: String(row.action),
      persona_id: (row.persona_id as string | null) ?? null,
      user_id: (row.user_id as string | null) ?? null,
      metadata: (row.metadata as Record<string, unknown> | null) ?? {},
      created_at: toIso(row.created_at),
    }));
  }

  async log(
    operatorId: string,
    action: string,
    personaId: string | null,
    userId: string | null,
    metadata: Record<string, unknown>
  ): Promise<void> {
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO cs_platform.audit_logs (operator_id, action, persona_id, user_id, metadata)
         VALUES ($1, $2, $3::uuid, $4::uuid, $5::jsonb)`,
        operatorId,
        action,
        personaId,
        userId,
        JSON.stringify(metadata)
      );
    } catch (error) {
      console.warn(
        `[cs-platform] 写审计日志失败：${error instanceof Error ? error.message : error}`
      );
    }
  }

  private async getOrCreateSession(personaId: string, userId: string): Promise<SessionRow> {
    const existing = await prisma.$queryRawUnsafe<SessionRow[]>(
      `SELECT * FROM cs_platform.outreach_sessions
       WHERE persona_id = $1::uuid AND user_id = $2::uuid
       LIMIT 1`,
      personaId,
      userId
    );
    if (existing[0]) return existing[0];

    const rows = await prisma.$queryRawUnsafe<SessionRow[]>(
      `INSERT INTO cs_platform.outreach_sessions (persona_id, user_id)
       VALUES ($1::uuid, $2::uuid)
       RETURNING *`,
      personaId,
      userId
    );
    return expectOne(rows, '创建会话失败：数据库未返回记录');
  }

  private async validatePersonaSql(sql: string): Promise<void> {
    await prisma.$executeRawUnsafe(`SELECT cs_platform.validate_persona_sql($1::text)`, sql);
    try {
      await prisma.$queryRawUnsafe(
        `SELECT q.user_id::uuid FROM (${sql}) AS q WHERE q.user_id IS NOT NULL LIMIT 0`
      );
    } catch {
      throw new Error('SQL 规则必须 SELECT user_id，且 user_id 必须是 public.users.id UUID');
    }
  }
}

/**
 * 画像 SQL 只需要产出 user_id 集合，顶层 ORDER BY 对刷新结果无意义。
 * 同时 PostgreSQL 会拒绝 `SELECT DISTINCT user_id ... ORDER BY <非 select 字段>`，
 * 所以保存前剥离顶层排序，避免 refresh 时被数据库函数误伤。
 */
function normalizePersonaSql(sql: string): string {
  const trimmed = sql.trim();
  if (/\b(limit|offset|fetch)\b/i.test(trimmed)) return trimmed;
  return trimmed.replace(/\s+order\s+by\s+[\s\S]*$/i, '').trim();
}

function toPersonaData(row: PersonaRow): CsPersonaData {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    color: row.color,
    sql: row.sql_text,
    opening_script: row.opening_script,
    sop: row.sop?.length ? row.sop : DEFAULT_SOP,
    status: row.status,
    active_count: Number(row.active_count ?? 0),
    chatted_left_count: Number(row.chatted_left_count ?? 0),
    last_refreshed_at: row.last_refreshed_at ? toIso(row.last_refreshed_at) : null,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

function expectOne<T>(rows: T[], message: string): T {
  const row = rows[0];
  if (!row) throw new Error(message);
  return row;
}

function toUserData(row: Record<string, unknown>): CsUserData {
  return {
    user_id: String(row.user_id),
    telegram_user_id: String(row.telegram_user_id),
    display_name: String(row.display_name ?? row.telegram_user_id ?? 'Unknown'),
    username: (row.username as string | null) ?? null,
    register_days: Number(row.register_days ?? 0),
    total_paid_amount: String(row.total_paid_amount ?? '0.00'),
    paid_count: Number(row.paid_count ?? 0),
    total_round: Number(row.total_round ?? 0),
    last_active_at: row.last_active_at ? toIso(row.last_active_at) : null,
    last_active_label: formatRelativeTime(row.last_active_at ? toIso(row.last_active_at) : null),
    membership_status: row.membership_status === 'chatted_left' ? 'chatted_left' : 'active',
    session_status: (row.session_status as CsSessionStatus | null) ?? 'not_started',
    current_stage: (row.current_stage as string | null) ?? null,
    chatted_at: row.chatted_at ? toIso(row.chatted_at) : null,
    left_note: (row.left_note as string | null) ?? null,
  };
}

function toMessageData(row: Record<string, unknown>): CsMessageData {
  return {
    id: String(row.id),
    persona_id: String(row.persona_id),
    user_id: String(row.user_id),
    telegram_user_id: String(row.telegram_user_id),
    direction: row.direction === 'user' ? 'user' : 'agent',
    sop_stage: (row.sop_stage as string | null) ?? null,
    question_key: (row.question_key as string | null) ?? null,
    content: String(row.content ?? ''),
    send_status: (row.send_status as CsSendStatus | null) ?? 'pending',
    telegram_message_id: (row.telegram_message_id as string | null) ?? null,
    sent_at: row.sent_at ? toIso(row.sent_at) : null,
    received_at: row.received_at ? toIso(row.received_at) : null,
    failed_reason: (row.failed_reason as string | null) ?? null,
    created_at: toIso(row.created_at),
  };
}

function toSessionData(row: SessionRow, sop: CsSopStageData[]): CsSessionData {
  const normalizedSop = sop.length ? sop : DEFAULT_SOP;
  const currentKey = row.current_question_key ?? row.current_stage ?? normalizedSop[0]?.key ?? null;
  const stage = normalizedSop.find((item) => item.key === currentKey) ?? normalizedSop[0];
  return {
    persona_id: row.persona_id,
    user_id: row.user_id,
    status: row.status,
    current_stage: row.current_stage,
    current_question_key: row.current_question_key,
    next_touch_at: row.next_touch_at ? toIso(row.next_touch_at) : null,
    completed_at: row.completed_at ? toIso(row.completed_at) : null,
    skipped_at: row.skipped_at ? toIso(row.skipped_at) : null,
    skip_reason: row.skip_reason,
    suggested_prompt: stage?.prompt ?? null,
    available_actions: buildAvailableActions(row.status),
  };
}

function buildAvailableActions(status: CsSessionStatus): CsSessionData['available_actions'] {
  if (status === 'completed' || status === 'skipped') return [];
  if (status === 'send_failed') return ['retry', 'skip'];
  return ['send', 'advance', 'snooze', 'skip', 'complete'];
}

function createSlug(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${base || 'persona'}-${Date.now().toString(36)}`;
}

function formatRelativeTime(value: string | null): string {
  if (!value) return '未知';
  const diffMs = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return '刚刚';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${Math.max(minutes, 1)}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  return `${Math.floor(hours / 24)}天前`;
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}
