import type {
  ConversationStatusData,
  ConversationStatusRefreshData,
  MemoryBarState,
} from '@miniapp/shared';

/**
 * 聊天页右侧面板里的记忆栏（时间线）预览：虚构的多人物公寓故事，人物与情节均为示意。
 * 只在这两个场景下接管 GET/POST …/status 与 PUT …/memory-request，其他场景不受影响。
 */
export const MEMORY_PANEL_SCENARIOS = {
  'memory-panel': {
    label: '记忆栏时间线',
    description:
      '状态栏下面是记忆：近、中两档排成时间线，里程碑跟在对应记录下，更早的记忆可展开；已写记忆要求',
  },
  'memory-only': {
    label: '只有记忆栏',
    description: '卡没有状态栏：入口写「记忆」，面板里只有记忆；还没写记忆要求',
  },
} as const;

export type MemoryPanelScenario = keyof typeof MEMORY_PANEL_SCENARIOS;

const isMemoryScenario = (scenario: string): scenario is MemoryPanelScenario =>
  scenario in MEMORY_PANEL_SCENARIOS;

const record = (from: number, tier: 'near' | 'mid' | 'far', text: string) => ({
  from_turn: from,
  to_turn: from + 2,
  tier,
  text,
});

const STATE: MemoryBarState = {
  version: 1,
  covered_turn: 27,
  summary:
    '你在一个雨夜接手了这栋六层的老公寓，前任房东留下一本写满欠租名单的账本；刚搬来时认识了对门的林晚、三楼的苏棠和地下室的阿杰。',
  milestones: [
    { turn: 15, text: '和苏棠为房租第一次正面冲突' },
    { turn: 21, text: '林晚第一次说喜欢你，两人接吻' },
    { turn: 27, text: '温言入住五楼' },
  ],
  records: [
    record(1, 'far', '你挨家挨户收了第一轮房租。'),
    record(4, 'far', '苏棠连着两个月拖欠房租。'),
    record(7, 'mid', '林晚帮你修好漏水的水管，留你在她家吃饭，两人第一次聊到深夜。'),
    record(13, 'mid', '你宣布全楼涨房租，房客们议论纷纷，苏棠当面质问你凭什么。'),
    record(
      19,
      'near',
      '周四深夜，林晚在楼道里拦住你，第一次说出喜欢；你们在她家沙发上接了吻，约好周末一起去海边。同一晚，苏棠为涨房租的事和你大吵一架，摔门而去，至今没再说话。'
    ),
    record(
      22,
      'near',
      '阿杰在地下室撞见你和林晚走得近，私下警告你别碰她——他和林晚似乎有段过去，具体是什么他不肯说。'
    ),
    record(
      25,
      'near',
      '你把空着的五楼租给了新来的女孩温言，她付了半年房租，却对自己的来历只字不提。'
    ),
  ],
};

const STATUS_TEXT = '【林晚】\n好感：68/100\n关系：暧昧\n【苏棠】\n好感：35/100\n关系：冷战中';

export function createMemoryPanelFixture() {
  let request: string | null = null;
  const data = (scenario: MemoryPanelScenario): ConversationStatusData => ({
    source: scenario === 'memory-panel' ? 'card' : 'none',
    template: null,
    snapshot:
      scenario === 'memory-panel'
        ? {
            id: 'preview-status-1',
            text: STATUS_TEXT,
            trigger: 'auto',
            createdAt: new Date().toISOString(),
            canUndo: true,
          }
        : null,
    initialText: null,
    updating: false,
    manualUpdate: 'allowed',
    memory: { enabled: true, state: STATE, request, updating: false },
  });
  return {
    reset(scenario: string) {
      request = scenario === 'memory-panel' ? '着重记录我和林晚的关系，阿杰那条线也别漏' : null;
    },
    handle(method: string, path: string, body: unknown, scenario: string): unknown | undefined {
      if (!isMemoryScenario(scenario)) return undefined;
      if (/^\/api\/conversations\/[^/]+\/status$/.test(path) && method === 'GET')
        return data(scenario);
      if (/^\/api\/conversations\/[^/]+\/status\/refresh$/.test(path) && method === 'POST') {
        const refreshed: ConversationStatusRefreshData = {
          ...data(scenario),
          memoryOutcome: 'no_progress',
        };
        return refreshed;
      }
      if (/^\/api\/conversations\/[^/]+\/memory-request$/.test(path) && method === 'PUT') {
        const value = (body as { request?: unknown } | null)?.request;
        request = typeof value === 'string' && value.trim() ? value.trim() : null;
        return { request };
      }
      return undefined;
    },
  };
}
