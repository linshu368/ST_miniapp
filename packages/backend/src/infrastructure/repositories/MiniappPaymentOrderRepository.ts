import { getDomainDb } from '../../lib/supabase.js';
import type {
  PaymentOrder,
  PaymentOrderStatus,
  PaymentProductType,
  PaymentSettlementSource,
  PaymentType,
} from '@miniapp/shared';

export interface MiniappPaymentOrderRow {
  id: string;
  user_id: string;
  status: PaymentOrderStatus;
  payment_type: PaymentType;
  amount_cents: number;
  credits_amount: number;
  bonus_credits: number;
  provider_transaction_id: string | null;
  credits_added: boolean;
  created_at: string;
  expires_at: string;
  paid_at: string | null;
  /** 入账获胜路径；migration 103 之前入账的历史订单为 null */
  settled_by: PaymentSettlementSource | null;
  product_type: PaymentProductType;
  product_id: string | null;
  vip_duration_days: number | null;
  vip_bonus_credits: number | null;
  vip_bonus_main_credits?: number;
  fulfillment_applied: boolean;
  vip_valid_until: string | null;
  next_reconcile_at: string;
  last_reconciled_at: string | null;
  reconcile_attempts: number;
  reconcile_locked_until: string | null;
}

export interface CreateMiniappPaymentOrderInput {
  id: string;
  user_id: string;
  payment_type: PaymentType;
  amount_cents: number;
  credits_amount: number;
  bonus_credits: number;
  expires_at: string;
  product_type: PaymentProductType;
  product_id: string;
  vip_duration_days: number | null;
  vip_bonus_credits: number | null;
  vip_bonus_main_credits?: number;
}

export interface PaymentOperationEventInput {
  event_key: string;
  order_id: string | null;
  user_id: string | null;
  event_kind:
    | 'checkout_confirmation'
    | 'order_creation'
    | 'gateway_create'
    | 'webhook'
    | 'return'
    | 'payment_query'
    | 'settlement'
    | 'fast_reconcile'
    | 'expiry_reconcile';
  stage: 'order' | 'checkout' | 'gateway' | 'callback' | 'query' | 'settlement';
  outcome: 'started' | 'succeeded' | 'failed' | 'unpaid' | 'paid' | 'skipped';
  source: 'client' | 'backend' | 'gateway' | 'cron';
  trigger:
    | 'initial_open'
    | 'reopen'
    | 'webhook'
    | 'return'
    | 'user_poll'
    | 'fast_reconcile'
    | 'expiry_reconcile'
    | 'create_order'
    | 'settlement';
  error_class?: string | null;
  duration_ms?: number | null;
  occurred_at: string;
  metadata?: Record<string, string | number | boolean | null>;
}

/** 日报按天全量取，单页上限只是为了不把一天的订单压成一次超大响应。 */
const REPORT_PAGE_SIZE = 500;

export class MiniappPaymentOrderRepository {
  private readonly db = getDomainDb('billing');

  async create(input: CreateMiniappPaymentOrderInput): Promise<MiniappPaymentOrderRow> {
    const { data, error } = await this.db.from('payment_orders').insert(input).select('*').single();
    if (error) throw new Error(`创建支付订单失败：${error.message}`);
    return data as MiniappPaymentOrderRow;
  }

  async findById(id: string): Promise<MiniappPaymentOrderRow | null> {
    const { data, error } = await this.db
      .from('payment_orders')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(`查询支付订单失败：${error.message}`);
    return (data as MiniappPaymentOrderRow | null) ?? null;
  }

  async findByIdForUser(id: string, userId: string): Promise<MiniappPaymentOrderRow | null> {
    const { data, error } = await this.db
      .from('payment_orders')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw new Error(`查询用户支付订单失败：${error.message}`);
    return (data as MiniappPaymentOrderRow | null) ?? null;
  }

  /** event_key 是事实的去重键：同一事实重复上报（如对账每轮都看到同一异常）直接忽略，不算失败。 */
  async recordOperationEvent(input: PaymentOperationEventInput): Promise<void> {
    const { error } = await this.db.from('payment_operation_events').upsert(
      {
        ...input,
        error_class: input.error_class ?? null,
        duration_ms: input.duration_ms ?? null,
        metadata: input.metadata ?? {},
      },
      { onConflict: 'event_key', ignoreDuplicates: true }
    );
    if (error) throw new Error(`记录支付操作事件失败：${error.message}`);
  }

  async listByUser(input: {
    userId: string;
    status?: PaymentOrderStatus;
    cursor?: string;
    limit: number;
  }): Promise<MiniappPaymentOrderRow[]> {
    let query = this.db
      .from('payment_orders')
      .select('*')
      .eq('user_id', input.userId)
      .order('created_at', { ascending: false })
      .limit(input.limit);

    if (input.status) {
      query = query.eq('status', input.status);
    }
    if (input.cursor) {
      query = query.lt('created_at', input.cursor);
    }

    const { data, error } = await query;
    if (error) throw new Error(`查询支付订单列表失败：${error.message}`);
    return (data ?? []) as MiniappPaymentOrderRow[];
  }

  /**
   * 回调监控日报口径：按 created_at 取一整天的订单。
   * 划天用 created_at 而不是 paid_at，问的是「当天下的单最后由哪条路径入账」，
   * 跨天才入账的订单仍归它下单的那天，否则兜底路径的耗时会被算到第二天。
   */
  async listCreatedBetween(input: {
    since: string;
    until: string;
    status?: PaymentOrderStatus;
  }): Promise<MiniappPaymentOrderRow[]> {
    const rows: MiniappPaymentOrderRow[] = [];

    for (let offset = 0; ; offset += REPORT_PAGE_SIZE) {
      let query = this.db
        .from('payment_orders')
        .select('*')
        .gte('created_at', input.since)
        .lt('created_at', input.until)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(offset, offset + REPORT_PAGE_SIZE - 1);

      if (input.status) {
        query = query.eq('status', input.status);
      }

      const { data, error } = await query;
      if (error) throw new Error(`查询区间支付订单失败：${error.message}`);

      const page = (data ?? []) as MiniappPaymentOrderRow[];
      rows.push(...page);
      if (page.length < REPORT_PAGE_SIZE) return rows;
    }
  }

  async expirePendingForUser(userId: string): Promise<number> {
    const { data, error } = await this.db.rpc('expire_payment_orders', {
      p_user_id: userId,
    });
    if (error) throw new Error(`过期用户支付订单失败：${error.message}`);
    return typeof data === 'number' ? data : 0;
  }

  async expireAllPending(): Promise<number> {
    const { data, error } = await this.db.rpc('expire_payment_orders', {
      p_user_id: null,
    });
    if (error) throw new Error(`过期支付订单失败：${error.message}`);
    return typeof data === 'number' ? data : 0;
  }

  /** 包含建单响应丢失、无交易号的易支付订单；按持久化轮询时间排序避免慢单饿死后续订单。 */
  async listRecentUnsettled(input: {
    since: string;
    limit: number;
    now: string;
    signal?: AbortSignal;
  }): Promise<MiniappPaymentOrderRow[]> {
    const { data, error } = await this.db
      .from('payment_orders')
      .select('*')
      .in('status', ['pending', 'expired'])
      .eq('credits_added', false)
      .eq('fulfillment_applied', false)
      .like('id', 'EP%')
      .gte('created_at', input.since)
      .lte('next_reconcile_at', input.now)
      .order('next_reconcile_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(input.limit)
      .abortSignal(input.signal ?? AbortSignal.timeout(5_000));

    if (error) throw new Error(`查询待对账支付订单失败：${error.message}`);
    return (data ?? []) as MiniappPaymentOrderRow[];
  }

  /** 查询前先排到队尾；崩溃后到期可重试，多实例重复只读查询仍由结算幂等兜底。 */
  async scheduleReconciliation(id: string, nextAt: string, signal?: AbortSignal): Promise<void> {
    const { error } = await this.db
      .from('payment_orders')
      .update({ next_reconcile_at: nextAt })
      .eq('id', id)
      .in('status', ['pending', 'expired'])
      .abortSignal(signal ?? AbortSignal.timeout(5_000));
    if (error) throw new Error('安排支付对账失败', { cause: error });
  }

  /** 查单确认未支付且超过本地期限后标记过期；迟到支付仍允许恢复履约。 */
  async expirePendingById(id: string): Promise<boolean> {
    const { data, error } = await this.db
      .from('payment_orders')
      .update({ status: 'expired' })
      .eq('id', id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle();

    if (error) throw new Error(`关闭支付订单失败：${error.message}`);
    return data !== null;
  }

  async expirePendingByIdForUser(id: string, userId: string): Promise<void> {
    const { error } = await this.db
      .from('payment_orders')
      .update({ status: 'expired' })
      .eq('id', id)
      .eq('user_id', userId)
      .eq('status', 'pending')
      .lte('expires_at', new Date().toISOString());

    if (error) throw new Error(`过期支付订单失败：${error.message}`);
  }

  /** 把已超时但未履约的订单放回 pending，让迟到的已验签回调还能补账。
   *  履约 RPC 只接受 pending。VIP 的 credits_added 恒为 false，所以还必须看 fulfillment_applied，
   *  避免把已经发过会员的过期行重新打开。 */
  async reopenExpired(id: string): Promise<void> {
    const { error } = await this.db
      .from('payment_orders')
      .update({ status: 'pending' })
      .eq('id', id)
      .eq('status', 'expired')
      .eq('credits_added', false)
      .eq('fulfillment_applied', false);

    if (error) throw new Error(`恢复超时支付订单失败：${error.message}`);
  }

  /** 以 CAS 固定首次交易号，允许通知先到/重复关联，永远不覆盖其他交易号。 */
  async attachProviderTransaction(id: string, providerTransactionId: string): Promise<boolean> {
    const { data, error } = await this.db
      .from('payment_orders')
      .update({ provider_transaction_id: providerTransactionId })
      .eq('id', id)
      .in('status', ['pending', 'expired'])
      .is('provider_transaction_id', null)
      .select('id')
      .maybeSingle();
    if (error) throw new Error(`记录支付平台单号失败：${error.message}`);
    if (data !== null) return true;
    const existing = await this.findById(id);
    return existing?.provider_transaction_id === providerTransactionId;
  }

  async markFailed(id: string): Promise<void> {
    const { error } = await this.db
      .from('payment_orders')
      .update({ status: 'failed' })
      .eq('id', id)
      .eq('status', 'pending')
      .is('provider_transaction_id', null);
    if (error) throw new Error(`标记支付订单失败失败：${error.message}`);
  }

  async complete(
    id: string,
    providerTransactionId: string | null,
    settledBy: PaymentSettlementSource
  ): Promise<MiniappPaymentOrderRow> {
    const { data, error } = await this.db.rpc('complete_payment_order', {
      p_order_id: id,
      p_provider_transaction_id: providerTransactionId,
      p_settled_by: settledBy,
    });
    if (error) throw new Error(`完成支付订单失败：${error.message}`);
    return data as MiniappPaymentOrderRow;
  }
}

export function toPaymentOrder(row: MiniappPaymentOrderRow): PaymentOrder {
  return {
    id: row.id,
    status: row.status,
    payment_type: row.payment_type,
    amount_cents: row.amount_cents,
    credits_amount: row.credits_amount,
    bonus_credits: row.bonus_credits,
    created_at: row.created_at,
    expires_at: row.expires_at,
    paid_at: row.paid_at,
    provider_transaction_id: row.provider_transaction_id,
    settled_by: row.settled_by,
    product_type: row.product_type,
    product_id: row.product_id,
    fulfillment_applied: row.fulfillment_applied,
    vip_duration_days: row.vip_duration_days,
    vip_bonus_credits: row.vip_bonus_credits,
    vip_bonus_main_credits: row.vip_bonus_main_credits ?? 0,
    vip_valid_until: row.vip_valid_until,
  };
}
