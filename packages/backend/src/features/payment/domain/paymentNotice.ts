import type { PaymentProductType } from '@miniapp/shared';

export function paymentSuccessNotice(order: {
  id: string;
  product_type: PaymentProductType;
  product_id: string | null;
  credits_amount: number;
  bonus_credits: number;
  vip_duration_days: number | null;
  vip_bonus_credits: number | null;
}): { title: string; body: string } {
  if (order.product_type === 'vip') {
    const label =
      order.product_id === 'month' ? '月卡' : order.product_id === 'week' ? '周卡' : '会员';
    const days = order.vip_duration_days ?? 0;
    const bonus = order.vip_bonus_credits ?? 0;
    const bonusText = bonus > 0 ? `，${bonus} 专项星尘已到账` : '';
    return {
      title: `VIP ${label}已生效`,
      body: `订单 ${order.id} 已完成，会员已顺延 ${days} 天${bonusText}。`,
    };
  }

  const totalCredits = order.credits_amount + order.bonus_credits;
  return {
    title: '星尘充值到账',
    body: `订单 ${order.id} 已完成，${totalCredits} 星尘已到账。`,
  };
}
