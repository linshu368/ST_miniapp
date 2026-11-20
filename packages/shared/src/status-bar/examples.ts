/**
 * 官方示例（全部成人向、人物一律成年）。创作者"从示例开始"用；说明按"这是什么 → 怎么变/写什么 → 特殊规则"写，
 * 也是 AI 生成状态栏时的参考范例。对账测试保证每套都过模板校验、开局值写法对得上样式。
 */
import type { StatusBarTemplate } from './schema';

export interface StatusBarExample {
  id: string;
  label: string;
  template: StatusBarTemplate;
}

export const STATUS_BAR_EXAMPLES: StatusBarExample[] = [
  {
    id: 'ex-ex',
    label: '前任重逢（林晚）',
    template: {
      version: 1,
      note: '分手三年的前任，深夜醉酒打电话来；关系能不能修复，看你怎么接。',
      sections: [
        {
          id: 'ex-ex-s1',
          title: '',
          repeat: null,
          items: [
            {
              id: 'ex-ex-i1',
              name: '时间',
              style: 'line',
              desc: '剧情里此刻的时间，写到几点，比如"周六 晚上十一点半"。',
              init: '周五 凌晨一点',
            },
            {
              id: 'ex-ex-i2',
              name: '地点',
              style: 'line',
              desc: '此刻所在的具体地方，写到哪个房间或哪个角落。',
              init: '她家楼下的便利店门口',
            },
          ],
        },
        {
          id: 'ex-ex-s2',
          title: '林晚',
          repeat: null,
          items: [
            {
              id: 'ex-ex-i3',
              name: '好感度',
              style: 'bar',
              desc: '她对你重新心动的程度。你认真回应她、提起你们的好回忆会涨；翻旧账、敷衍她会掉。三年的心结没解开前，每轮最多涨3。',
              max: 100,
              init: '30/100',
            },
            {
              id: 'ex-ex-i4',
              name: '关系',
              style: 'stage',
              desc: '你们现在的关系。只有剧情里把话说开、明确确认了才往前走一格，不会跳级。',
              stages: ['前任', '朋友', '暧昧', '复合', '同居'],
              init: '前任（1/5）',
            },
            {
              id: 'ex-ex-i5',
              name: '醉意',
              style: 'percent',
              desc: '她喝醉的程度。越高越敢说真话、越黏人；过80%会断片，之后不记得自己说过什么。不再喝酒时每轮降一些。',
              init: '65%',
            },
            {
              id: 'ex-ex-i6',
              name: '衣着',
              style: 'line',
              desc: '她此刻身上穿的，从外到里写清楚；换了、脱了、弄乱了都要如实更新。',
              init: '吊带裙外披着你的旧外套',
            },
            {
              id: 'ex-ex-i7',
              name: '心情',
              style: 'tags',
              desc: '她此刻的情绪，2到3个词，比如委屈、想你、嘴硬。',
              init: '委屈、想你、嘴硬',
            },
            {
              id: 'ex-ex-i8',
              name: '心里话',
              style: 'para',
              desc: '她此刻想说却没说出口的一句话，用她自己的口吻、第一人称，常常和嘴上说的相反。',
              init: '其实我一直没删你的号码，只是不敢打。',
            },
          ],
        },
        {
          id: 'ex-ex-s3',
          title: '旧物',
          repeat: null,
          items: [
            {
              id: 'ex-ex-i9',
              name: '还留着的',
              style: 'bullets',
              desc: '她还留着的、和你有关的旧东西，每样一行；剧情里提到新的就加上，扔了就删掉。',
              init: '- 你送的那件白衬衫\n- 两张没用掉的电影票',
            },
          ],
        },
      ],
    },
  },
  {
    id: 'romance',
    label: '恋爱',
    template: {
      version: 1,
      note: '',
      sections: [
        {
          id: 'romance-s1',
          title: '',
          repeat: null,
          items: [
            {
              id: 'romance-i1',
              name: '时间',
              style: 'line',
              desc: '剧情里此刻的时间，写到几点，比如"周六 晚上十一点半"。',
              init: '周六 晚上十点',
            },
            {
              id: 'romance-i2',
              name: '地点',
              style: 'line',
              desc: '此刻所在的具体地方，写到哪个房间或哪个角落。',
              init: '她公寓的沙发上',
            },
          ],
        },
        {
          id: 'romance-s2',
          title: '她',
          repeat: null,
          items: [
            {
              id: 'romance-i3',
              name: '好感度',
              style: 'bar',
              desc: '她对你的心动程度。你认真听她说话、记得她的小事、夸她会涨；忽视她、和别的女生走太近会掉。每轮最多变5。',
              max: 100,
              init: '25/100',
            },
            {
              id: 'romance-i4',
              name: '关系',
              style: 'stage',
              desc: '你们现在的关系。表白被接受才算恋人；只有剧情里关系真的变了才往前走一格。',
              stages: ['陌生', '心动', '暧昧', '恋人', '离不开你'],
              init: '心动（2/5）',
            },
            {
              id: 'romance-i5',
              name: '衣着',
              style: 'line',
              desc: '她此刻穿的衣服和打扮，换了或乱了要更新。',
              init: '宽松的白衬衫，光着腿',
            },
            {
              id: 'romance-i6',
              name: '心情',
              style: 'tags',
              desc: '她此刻的情绪，2到3个词，比如害羞、期待、生闷气。',
              init: '紧张、期待',
            },
            {
              id: 'romance-i7',
              name: '心里话',
              style: 'para',
              desc: '她此刻想说却没说出口的一句话，用她自己的口吻、第一人称。',
              init: '他再看我一眼，我就装不下去了。',
            },
          ],
        },
      ],
    },
  },
  {
    id: 'desire',
    label: '情欲升温',
    template: {
      version: 1,
      note: '',
      sections: [
        {
          id: 'desire-s1',
          title: '',
          repeat: null,
          items: [
            {
              id: 'desire-i1',
              name: '时间',
              style: 'line',
              desc: '剧情里此刻的时间，写到几点，比如"周六 晚上十一点半"。',
              init: '周六 深夜',
            },
            {
              id: 'desire-i2',
              name: '地点',
              style: 'line',
              desc: '此刻所在的具体地方，写到哪个房间或哪个角落。',
              init: '她卧室的床边',
            },
          ],
        },
        {
          id: 'desire-s2',
          title: '人物名',
          repeat: { what: '在场的她', max: 2 },
          items: [
            {
              id: 'desire-i3',
              name: '好感',
              style: 'bar',
              desc: '她对你的心动程度。你温柔、体贴、夸她会涨；冷落、敷衍、粗暴对她会掉。每轮最多变5。',
              max: 100,
              init: '40/100',
            },
            {
              id: 'desire-i4',
              name: '情欲',
              style: 'percent',
              desc: '她此刻身体和心里想要的程度。暧昧的话、触碰、亲密动作会让它涨，被打断或冷场会降。越高她越主动，到100%会失控。',
              init: '30%',
            },
            {
              id: 'desire-i5',
              name: '亲密进度',
              style: 'stage',
              desc: '你们已经做到的最亲密的一步。剧情里真的发生了才往前走，不会倒退。',
              stages: ['牵手', '接吻', '爱抚', '初夜', '食髓知味'],
              init: '接吻（2/5）',
            },
            {
              id: 'desire-i6',
              name: '衣着',
              style: 'line',
              desc: '她此刻身上穿的，从外到里写清楚；被脱掉、弄乱、换了都要如实更新。',
              init: '吊带睡裙，肩带滑了一边',
            },
            {
              id: 'desire-i7',
              name: '身体反应',
              style: 'tags',
              desc: '她此刻身体的直观反应，2到4个词，比如脸红、腿软、呼吸变快。',
              init: '脸红、呼吸变快',
            },
            {
              id: 'desire-i8',
              name: '想和你做的事',
              style: 'checks',
              desc: '她心里想和你一起做的事，3到5条；剧情里做到了就打勾，新冒出来的想法就加上。',
              init: '[x] 一起泡澡\n[ ] 留下来过夜',
            },
          ],
        },
      ],
    },
  },
  {
    id: 'train',
    label: '调教',
    template: {
      version: 1,
      note: '',
      sections: [
        {
          id: 'train-s1',
          title: '她',
          repeat: null,
          items: [
            {
              id: 'train-i1',
              name: '服从度',
              style: 'bar',
              desc: '她愿意听你命令的程度。被耐心引导、做到约定后被奖励会涨；逼得太狠、羞辱过头会掉。每轮最多变5。',
              max: 100,
              init: '15/100',
            },
            {
              id: 'train-i2',
              name: '羞耻心',
              style: 'percent',
              desc: '她对露骨的事还会害羞、抗拒的程度。越低越放得开；每次大胆的经历后明显下降，很难再升回去。',
              init: '90%',
            },
            {
              id: 'train-i3',
              name: '阶段',
              style: 'stage',
              desc: '她对你的整体态度。服从度和羞耻心都到位、剧情里她有明显转变时才往前走一格。',
              stages: ['抗拒', '动摇', '顺从', '依赖', '沉沦'],
              init: '抗拒（1/5）',
            },
            {
              id: 'train-i4',
              name: '今晚的约定',
              style: 'checks',
              desc: '你们今晚说好要做的事，2到4条；她做到了就打勾，明确拒绝的就删掉。',
              init: '[x] 叫你主人\n[ ] 穿你挑的衣服',
            },
            {
              id: 'train-i5',
              name: '心里话',
              style: 'para',
              desc: '她嘴上不说、心里真实的想法，第一人称，可以和她表现出来的相反。',
              init: '我才不会就这样认输。',
            },
          ],
        },
      ],
    },
  },
  {
    id: 'harem',
    label: '后宫',
    template: {
      version: 1,
      note: '',
      sections: [
        {
          id: 'harem-s1',
          title: '',
          repeat: null,
          items: [
            {
              id: 'harem-i1',
              name: '时间',
              style: 'line',
              desc: '剧情里此刻的时间，写到几点，比如"周六 晚上十一点半"。',
              init: '深夜',
            },
            {
              id: 'harem-i2',
              name: '地点',
              style: 'line',
              desc: '此刻所在的具体地方，写到哪个房间或哪个角落。',
              init: '别墅客厅',
            },
          ],
        },
        {
          id: 'harem-s2',
          title: '人物名',
          repeat: { what: '在场的她', max: 3 },
          items: [
            {
              id: 'harem-i3',
              name: '好感',
              style: 'bar',
              desc: '这个女孩对你的心动程度。单独陪她、给她特别的照顾会涨；冷落她、偏心别人会掉。每轮最多变5。',
              max: 100,
              init: '50/100',
            },
            {
              id: 'harem-i4',
              name: '醋意',
              style: 'percent',
              desc: '她看你对别的女孩好时吃醋的程度。你和别人亲近就涨，单独哄她会降；80%以上她会闹脾气。',
              init: '20%',
            },
            {
              id: 'harem-i5',
              name: '关系',
              style: 'stage',
              desc: '她和你现在的关系，确认关系的事真的发生了才往前走一格。',
              stages: ['室友', '暧昧', '恋人', '只属于你'],
              init: '暧昧（2/4）',
            },
            {
              id: 'harem-i6',
              name: '心情',
              style: 'tags',
              desc: '她此刻的情绪，2到3个词。',
              init: '撒娇、吃醋',
            },
          ],
        },
      ],
    },
  },
  {
    id: 'affair',
    label: '偷情',
    template: {
      version: 1,
      note: '',
      sections: [
        {
          id: 'affair-s1',
          title: '她',
          repeat: null,
          items: [
            {
              id: 'affair-i1',
              name: '心动',
              style: 'bar',
              desc: '她对你的心动程度。你懂她、给她丈夫给不了的关心会涨；让她难堪、逼得太紧会掉。每轮最多变5。',
              max: 100,
              init: '35/100',
            },
            {
              id: 'affair-i2',
              name: '背德感',
              style: 'percent',
              desc: '她觉得对不起丈夫的程度。越高越挣扎也越刺激；每越过一条界线先升后降。',
              init: '70%',
            },
            {
              id: 'affair-i3',
              name: '暴露风险',
              style: 'stars',
              desc: '你们的事被她丈夫或旁人发现的可能。在她家、人多的地方、留下痕迹会加星，小心行事会减星；满5颗就会出事。',
              total: 5,
              init: '★★☆☆☆',
            },
            {
              id: 'affair-i4',
              name: '关系',
              style: 'stage',
              desc: '你们走到了哪一步。剧情里真的越过界线才往前走一格。',
              stages: ['邻居', '试探', '越界', '偷情', '沦陷'],
              init: '试探（2/5）',
            },
            {
              id: 'affair-i5',
              name: '心里话',
              style: 'para',
              desc: '她此刻心里真实的想法，第一人称，常常和嘴上说的相反。',
              init: '他就在隔壁，我却在想你。',
            },
          ],
        },
      ],
    },
  },
  {
    id: 'otome',
    label: '女性向',
    template: {
      version: 1,
      note: '',
      sections: [
        {
          id: 'otome-s1',
          title: '他',
          repeat: null,
          items: [
            {
              id: 'otome-i1',
              name: '好感',
              style: 'bar',
              desc: '他对你的心动程度。你依赖他、在他面前示弱会涨；你和别的男人走太近会掉。每轮最多变5。',
              max: 100,
              init: '30/100',
            },
            {
              id: 'otome-i2',
              name: '占有欲',
              style: 'percent',
              desc: '他想把你据为己有的程度。你和别的男人说话、晚回消息会涨；你主动靠近他会降。越高他越强势。',
              init: '40%',
            },
            {
              id: 'otome-i3',
              name: '关系',
              style: 'stage',
              desc: '你们现在的关系，确认关系的事真的发生了才往前走一格。',
              stages: ['上司', '暧昧', '恋人', '同居'],
              init: '上司（1/4）',
            },
            {
              id: 'otome-i4',
              name: '他想和你做的事',
              style: 'checks',
              desc: '他心里想和你一起做的事，3到5条，做到了就打勾。',
              init: '[x] 送你回家\n[ ] 留下来过夜',
            },
            {
              id: 'otome-i5',
              name: '心里话',
              style: 'para',
              desc: '他此刻想说却没说出口的话，用他的口吻、第一人称。',
              init: '她今天的口红颜色，是给谁看的。',
            },
          ],
        },
      ],
    },
  },
];
