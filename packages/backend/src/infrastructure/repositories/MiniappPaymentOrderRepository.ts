import { getDomainDb } from '../../lib/supabase.js';
import type { PaymentOrder, PaymentOrderStatus, PaymentType } from '@miniapp/shared';

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
}

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

  /**
   * 判过期前需要跟厂商对一次账的订单：已到期但还没入账的 pending，
   * 以及窗口内已被判过期、仍未入账的订单。
   */
  async listUnsettledAroundExpiry(input: {
    since: string;
    until: string;
    limit: number;
  }): Promise<MiniappPaymentOrderRow[]> {
    const { data, error } = await this.db
      .from('payment_orders')
      .select('*')
      .in('status', ['pending', 'expired'])
      .eq('credits_added', false)
      .gte('expires_at', input.since)
      .lte('expires_at', input.until)
      .order('expires_at', { ascending: true })
      .limit(input.limit);

    if (error) throw new Error(`查询待对账支付订单失败：${error.message}`);
    return (data ?? []) as MiniappPaymentOrderRow[];
  }

  async listDueForReconciliation(input: {
    now: string;
    limit: number;
  }): Promise<MiniappPaymentOrderRow[]> {
    const { data, error } = await this.db
      .from('payment_orders')
      .select('*')
      .eq('status', 'pending')
      .eq('credits_added', false)
      .gt('expires_at', input.now)
      .lte('next_reconcile_at', input.now)
      .or(`reconcile_locked_until.is.null,reconcile_locked_until.lt.${input.now}`)
      .order('next_reconcile_at', { ascending: true })
      .limit(input.limit);

    if (error) throw new Error(`查询待快速对账支付订单失败：${error.message}`);
    return (data ?? []) as MiniappPaymentOrderRow[];
  }

  async claimForReconciliation(input: {
    candidate: MiniappPaymentOrderRow;
    now: string;
    lockedUntil: string;
  }): Promise<MiniappPaymentOrderRow | null> {
    const { candidate } = input;
    const { data, error } = await this.db
      .from('payment_orders')
      .update({
        last_reconciled_at: input.now,
        reconcile_attempts: candidate.reconcile_attempts + 1,
        reconcile_locked_until: input.lockedUntil,
      })
      .eq('id', candidate.id)
      .eq('status', 'pending')
      .eq('credits_added', false)
      .eq('next_reconcile_at', candidate.next_reconcile_at)
      .eq('reconcile_attempts', candidate.reconcile_attempts)
      .or(`reconcile_locked_until.is.null,reconcile_locked_until.lt.${input.now}`)
      .select('*')
      .maybeSingle();

    if (error) throw new Error(`领取快速对账支付订单失败：${error.message}`);
    return (data as MiniappPaymentOrderRow | null) ?? null;
  }

  async releaseReconciliationClaim(input: {
    id: string;
    lockedUntil: string;
    nextReconcileAt: string;
  }): Promise<boolean> {
    const { data, error } = await this.db
      .from('payment_orders')
      .update({
        next_reconcile_at: input.nextReconcileAt,
        reconcile_locked_until: null,
      })
      .eq('id', input.id)
      .eq('status', 'pending')
      .eq('credits_added', false)
      .eq('reconcile_locked_until', input.lockedUntil)
      .select('id')
      .maybeSingle();

    if (error) throw new Error(`释放快速对账支付订单失败：${error.message}`);
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

  /** 把已超时但没入账的订单放回 pending，让迟到的已验签回调还能补账。
   *  complete_payment_order 只接受 pending，没有这一步，回调晚于 15 分钟到达
   *  就等于用户付了钱而星尘永久拿不到。 */
  async reopenExpired(id: string): Promise<void> {
    const { error } = await this.db
      .from('payment_orders')
      .update({ status: 'pending' })
      .eq('id', id)
      .eq('status', 'expired')
      .eq('credits_added', false);

    if (error) throw new Error(`恢复超时支付订单失败：${error.message}`);
  }

  async markFailed(id: string): Promise<void> {
    const { error } = await this.db
      .from('payment_orders')
      .update({ status: 'failed' })
      .eq('id', id);
    if (error) throw new Error(`标记支付订单失败失败：${error.message}`);
  }

  async complete(
    id: string,
    providerTransactionId: string | null
  ): Promise<MiniappPaymentOrderRow> {
    const { data, error } = await this.db.rpc('complete_payment_order', {
      p_order_id: id,
      p_provider_transaction_id: providerTransactionId,
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
  };
}
