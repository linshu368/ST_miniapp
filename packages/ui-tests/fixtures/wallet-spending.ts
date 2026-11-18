import type { WalletSpendingRecord } from '@miniapp/shared';

export function walletSpendingFixture(scenario: string): WalletSpendingRecord[] {
  if (scenario !== 'spending-video') return [];
  return [
    {
      id: 'video-refund:fixture-attempt',
      model_id: null,
      model_display_name: '视频退款',
      charged_amount: 40.5,
      status: 'charged',
      finish_reason: null,
      reply_outcome: null,
      status_label: '已原路退回',
      created_at: '2026-11-18T14:01:00Z',
      main_delta: 10,
      bonus_delta: 30.5,
      source_label: '原路退款',
      refund_of: 'video:fixture-attempt',
    },
    {
      id: 'video:fixture-attempt',
      model_id: null,
      model_display_name: '视频消费',
      charged_amount: 40.5,
      status: 'charged',
      finish_reason: null,
      reply_outcome: null,
      status_label: '已预扣',
      created_at: '2026-11-18T14:00:00Z',
      main_delta: -10,
      bonus_delta: -30.5,
      source_label: '视频预扣',
    },
  ];
}
