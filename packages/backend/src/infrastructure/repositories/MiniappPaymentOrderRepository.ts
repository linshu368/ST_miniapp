import { getSupabaseClient } from '../../lib/supabase.js';
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
  private readonly db = getSupabaseClient().schema('miniapp');

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
