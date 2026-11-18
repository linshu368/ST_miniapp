'use client';

import { CHAT_MESSAGE_EDIT_ROUNDS } from '@miniapp/shared';

interface Tip {
  title: string;
  /** 一句大白话，说清它是干嘛的。 */
  what: string;
  /** 一个具体例子，不要长。 */
  example: string;
}

interface TipGroup {
  heading: string;
  tips: Tip[];
}

/**
 * 工具箱「玩法小贴士」：把聊天页里一眼看不明白的功能讲清楚。
 * 写法约定：说人话、每条一句解释 + 一个例子，不展开。
 * 档位名称、回复风格等由运营平台配置的内容不在这里写死，只讲它们是干嘛的。
 */
const TIP_GROUPS: TipGroup[] = [
  {
    heading: '聊偏了怎么办',
    tips: [
      {
        title: '换一个回复',
        what: '对最新这条不满意，点回复下面的「换一个回复」，让 TA 重写一条。',
        example: '例：TA 突然翻脸，点一下换个说法。只能换最新的一条。',
      },
      {
        title: '编辑',
        what: `直接改某句话（你的或 TA 的），后面按改好的接着聊。最近 ${CHAT_MESSAGE_EDIT_ROUNDS} 轮可改。`,
        example: '例：TA 把你的名字说错了，改回来再聊。点话下面的「···」。',
      },
      {
        title: '分支',
        what: '从某一轮另开一条线重新聊，原来的对话还在。点回复的「···」。',
        example: '例：想看“当时拒绝了会怎样”，开个分支试试，不满意回原来的。',
      },
    ],
  },
  {
    heading: '让回复更对味（输入框上方的「回复偏好」）',
    tips: [
      {
        title: '回复长度',
        what: '控制 TA 每次回多少字。',
        example: '例：想快速一来一回选短的，想看大段描写选长的。',
      },
      {
        title: '剧情模式',
        what: '决定剧情主要听谁的。每一档下面有一句小字说明。',
        example:
          '例：想自己带节奏，就选“你说一句 TA 接一句”的那档；想要惊喜，选让 TA 多加戏的那档。',
      },
      {
        title: '文风偏好',
        what: '用你自己的话写想要的文风，对所有角色都生效。',
        example: '例：「少用比喻，多写动作」。',
      },
    ],
  },
  {
    heading: '回复下面多出来的几栏',
    tips: [
      {
        title: '状态栏',
        what: '回复末尾显示 TA 此刻的状态。',
        example: '例：时间、地点、心情。',
      },
      {
        title: '记忆栏',
        what: '把这段故事里该记住的事列出来，方便你对照。',
        example: '例：你答应了明晚赴约。',
      },
      {
        title: '可选项',
        what: '回复末尾给几个能直接点的接话选项，懒得打字就点。',
        example: '例：① 推门进去　② 先在外面看看。',
      },
      {
        title: '展开 / 收起',
        what: '每一栏旁边的小按钮，决定它平时是展开还是收起，需要时随时点开。',
        example: '例：嫌状态栏占地方，就设成收起。',
      },
    ],
  },
  {
    heading: '听和看',
    tips: [
      {
        title: '听 TA 说',
        what: '回复下面的小喇叭，让 TA 把这段念给你听。念的词不满意，点「自定义本次语音」改。',
        example: '例：睡前关灯听。声音和语速在工具箱「语音设置」里换。',
      },
      {
        title: '看看TA',
        what: '回复下面的「看看TA」，按眼下的剧情画一张图。',
        example: '例：想看 TA 现在穿什么。要花星尘，没画出来不扣。',
      },
    ],
  },
  {
    heading: '其他',
    tips: [
      {
        title: '深度思考',
        what: '开了以后 TA 先想一想再回，通常更有条理，但会慢一点。',
        example: '例：人物多、剧情绕的时候开。',
      },
      {
        title: '角色设定',
        what: '补充设定：给这张卡加你自己的设定，只对这张卡生效。我的人设：告诉 TA 你是谁，可以存几个，每张卡单独选。',
        example: '例：补充「苏棠：住对门，总穿吊带裙来借东西」，人设选「夜班调酒师」。',
      },
      {
        title: '对话记录',
        what: '左上角的图标，翻看和切换这个角色的所有对话，也能置顶。想另起一段，点顶上的「新对话」，原来的还在。',
        example: '例：把最爱的一段置顶，下次一眼找到。',
      },
      {
        title: '简介和评论',
        what: '点顶上的角色名，看角色介绍和大家的评论。',
        example: '例：开聊前先看看别人怎么玩这张卡。',
      },
      {
        title: '切换引擎',
        what: '角色名下面的胶囊，换驱动对话的模型。不同档位每轮花的星尘不同，点开有说明。',
        example: '例：日常闲聊用省的，想要更细腻的再换好的。',
      },
      {
        title: '聊久了不会忘',
        what: '很早之前的内容会被自动整理成“前情提要”，不用担心 TA 忘了。',
        example: '例：聊了几百轮，TA 还记得你们最初的约定。',
      },
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
          <div className="divide-y divide-border/60 overflow-hidden rounded-2xl border border-border bg-card">
            {group.tips.map((tip) => (
              <div key={tip.title} className="px-4 py-3">
                <p className="text-[13px] font-semibold text-foreground">{tip.title}</p>
                <p className="mt-0.5 text-[12px] leading-[19px] text-muted-foreground">
                  {tip.what}
                </p>
                <p className="mt-1 text-[11px] leading-[18px] text-primary/90">{tip.example}</p>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
