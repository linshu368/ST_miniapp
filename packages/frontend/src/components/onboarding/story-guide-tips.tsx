'use client';

import { CHAT_MESSAGE_EDIT_ROUNDS } from '@miniapp/shared';

interface TipGroup {
  heading: string;
  /** [功能, 一句话]。一眼能看懂的不写，不举例。 */
  tips: [title: string, what: string][];
}

/**
 * 工具箱「玩法小贴士」：聊天页里一眼看不明白的功能，每个一句话。
 * 档位名称、回复风格等由运营平台配置的内容不在这里写死，只讲它们是干嘛的。
 */
const TIP_GROUPS: TipGroup[] = [
  {
    heading: '聊偏了',
    tips: [
      ['换一个回复', '让 TA 重写最新一条'],
      ['编辑', `点话下面的「···」，你的和 TA 的都能改，最近 ${CHAT_MESSAGE_EDIT_ROUNDS} 轮内`],
      ['分支', '点回复的「···」，从那一轮另开一条线，原来的还在'],
    ],
  },
  {
    heading: '回复偏好',
    tips: [
      ['剧情模式', '剧情听谁的：你来带，还是 TA 多加戏'],
      ['文风偏好', '用自己的话写，比如「少用比喻，多写动作」，所有角色都生效'],
      ['记忆栏', '这段故事里 TA 记住的事'],
      ['可选项', '懒得打字，点一个接话'],
    ],
  },
  {
    heading: '听和看',
    tips: [
      ['听 TA 说', '点小喇叭，念的词可以自己改'],
      ['看看TA', '按眼下的剧情画一张，花星尘，没画出来不扣'],
    ],
  },
  {
    heading: '其他',
    tips: [
      ['深度思考', '想一想再回，更有条理，会慢一点'],
      ['补充设定', '给这张卡加人物或规则'],
      ['我的人设', '告诉 TA 你是谁，每张卡单独选'],
      ['状态栏', '右侧标签，看 TA 此刻的状态'],
      ['对话记录', '左上角图标，切换和置顶'],
      ['引擎', '角色名下面的胶囊，不同档位每轮花的星尘不同'],
      ['聊久了', '很早的内容会自动整理成前情提要'],
    ],
  },
];

export function StoryGuideTips() {
  return (
    <div className="space-y-5">
      {TIP_GROUPS.map((group) => (
        <section key={group.heading} aria-label={group.heading}>
          <h3 className="mb-2 px-1 text-[12px] font-semibold text-muted-foreground">
            {group.heading}
          </h3>
          <dl className="divide-y divide-border/60 overflow-hidden rounded-2xl border border-border bg-card">
            {group.tips.map(([title, what]) => (
              <div
                key={title}
                className="grid grid-cols-[5.25rem_minmax(0,1fr)] items-baseline gap-3 px-4 py-2.5"
              >
                <dt className="text-[13px] font-semibold text-foreground">{title}</dt>
                <dd className="text-[12px] leading-[19px] text-muted-foreground">{what}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}
