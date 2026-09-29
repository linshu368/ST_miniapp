import { Gift, Sparkles, Zap } from 'lucide-react';

/** 权益主视觉直接渲染，避免外部素材失败遮挡开通信息。 */
export function VipBenefitArt() {
  return (
    <section className="vip-benefit-frame relative overflow-hidden rounded-[24px] p-[1.5px] shadow-[0_0_24px_rgba(215,174,100,0.12)]">
      <div className="relative overflow-hidden rounded-[23px] bg-[#261e17] px-5 py-5 text-center">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(230,184,93,0.14),transparent_70%)]"
        />
        <div className="relative">
          <h2 className="vip-benefit-title bg-clip-text text-[25px] font-black tracking-[0.12em] text-transparent">
            VIP 会员
          </h2>
          <p className="mt-1 text-xs text-[#d6ba83]">专属特权 · 把每一段对话点亮</p>
          <div className="mt-4 flex justify-center gap-7">
            {[
              { Icon: Gift, label: '签到加成' },
              { Icon: Zap, label: '模型解锁' },
              { Icon: Sparkles, label: '专项星尘' },
            ].map(({ Icon, label }) => (
              <div key={label} className="flex flex-col items-center gap-1.5">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-[#a98342]/60 bg-[#bd903c]/10 shadow-[inset_0_1px_0_rgba(255,227,147,0.12)]">
                  <Icon className="h-[18px] w-[18px] text-[#e8c579]" aria-hidden />
                </span>
                <span className="text-[10px] text-[#d6ba83]">{label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
