import { z } from 'zod';

/**
 * 首页「推荐」v3 打分参数。
 *
 * v3 的分是 D30（30 轮深度）与 R48（48 小时回访率）的加权和，两者都做贝叶斯收缩与
 * 百分位归一化。这些参数原来是 backend 的 export const，改一次要发一次版；搬到
 * miniapp.runtime_config 之后运营可以自己调，下一次刷新（每 24 小时）生效。
 *
 * 上下界不是随手写的：它们的作用是「让运营改不出会把推荐列表搞崩的值」，
 * 而不是表达业务偏好。每一条的理由见字段注释。
 */

/** 权重和必须为 1。浮点相加会有尾差，用容差判定而不是 === 1 */
const WEIGHT_SUM_TOLERANCE = 1e-6;

export const LobbyRankingParamsSchema = z
  .object({
    /**
     * 统计窗口天数。太长会让老卡吃三个月前的老本，太短则方差大、排名天天抖。
     * 上界 365：再长就等于没有窗口，且 chat_history 全表扫描的成本会失控。
     */
    window_days: z.number().int().min(1).max(365),

    /**
     * 单用户单卡的轮次封顶（cap）。30 是沉浸阈值，也与付费行为挂钩。
     * 有了它，少数重度用户拉不爆整卡均值。
     */
    turn_cap: z.number().int().min(1).max(1000),

    /**
     * 会话切分间隔（分钟）。相邻两条消息超过它就算新 session，
     * 「两个 session 之间必然间隔 ≥ 这个值」是切分规则的自然结果，
     * 回访判定里不需要再加一次同样的条件。
     */
    session_gap_minutes: z.number().int().min(1).max(1440),

    /** 回访窗口（小时）。R48 的定义就是它，同时也是分母的观察期长度 */
    return_window_hours: z.number().int().min(1).max(720),

    /**
     * 判定 newcomer 时向窗口前回看多少天。
     *
     * null = 不限，回看全部历史——这是当前线上行为，也是精确解：chat_history 从不清理，
     * 所以「全历史首次交互落在窗口内」这个判定不会误判。
     *
     * 填数字则启用设计文档里的成本上界（文档默认 90）：只检查 [窗口起点 - N 天, 窗口起点)
     * 这段有没有历史记录。代价是真实首触早于该范围的老用户会被当成新客混进 R48 分母——
     * 换来的是不用全表扫 first_touch。样本量大到刷新超时才需要动它。
     */
    first_touch_lookback_days: z.number().int().min(1).max(3650).nullable(),

    /** w1：D30 权重，主因素 */
    d30_weight: z.number().min(0).max(1),

    /** w2：R48 权重，次因素 */
    r48_weight: z.number().min(0).max(1),

    /**
     * m_D：D30 贝叶斯收缩的先验权重。一张卡的样本量等于它时，先验与实测各占一半。
     * 0 = 关闭收缩，此时 12 个用户的小样本卡可以靠运气冲榜，慎用。
     */
    d30_prior_weight: z.number().min(0).max(100000),

    /**
     * X_D：硬门槛，作用于 n_c，决定这张卡是否进主池。
     * 同时也是「成熟卡」的定义——全局先验 μ_D 与 D30 标尺都只从这批卡取样。
     */
    min_users: z.number().int().min(1).max(1000000),

    /**
     * X_R：软门槛，作用于 k_c。只影响 R 项的可信度（线性过渡带），不决定准入。
     * 分母达到它才完全采信实测回访率，之下按比例向中性值回退。
     */
    r48_full_trust_sample: z.number().int().min(1).max(1000000),

    /**
     * 归一化空间的中性值。样本不足、标尺不成立、冷启动无达标卡时都取它，
     * 语义是「排在标尺正中间」，既不奖励也不惩罚。
     */
    neutral_norm: z.number().min(0).max(1),

    /** 归一化标尺低位分位点（P10）。每次刷新按当天分布重算，自适应大盘漂移 */
    norm_percentile_low: z.number().min(0).max(1),

    /** 归一化标尺高位分位点（P90） */
    norm_percentile_high: z.number().min(0).max(1),
  })
  .superRefine((value, ctx) => {
    const weightSum = value.d30_weight + value.r48_weight;
    if (Math.abs(weightSum - 1) > WEIGHT_SUM_TOLERANCE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        // 和不为 1 时分数不再落在 0–100，与「score 是百分制」的既有口径冲突，
        // 而排序阈值、运营对分数的直觉都建立在这个口径上。
        message: `d30_weight + r48_weight must equal 1 (got ${weightSum})`,
        path: ['d30_weight'],
      });
    }

    if (value.norm_percentile_low >= value.norm_percentile_high) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        // 低位 >= 高位时区间宽度为 0 或负，归一化会把所有卡推到极端或直接除零。
        message: 'norm_percentile_low must be strictly less than norm_percentile_high',
        path: ['norm_percentile_low'],
      });
    }
  });

export type LobbyRankingParams = z.infer<typeof LobbyRankingParamsSchema>;

/**
 * 内置兜底。与搬迁前 backend 的 export const 逐个等值，所以平台化本身不改打分结果。
 *
 * 唯一需要解释的是 first_touch_lookback_days：设计文档写的默认值是 90，但线上实现
 * 一直是全历史回看（更准），这里保持线上行为。见该字段的注释。
 */
export const DEFAULT_LOBBY_RANKING_PARAMS: LobbyRankingParams = {
  window_days: 80,
  turn_cap: 30,
  session_gap_minutes: 30,
  return_window_hours: 48,
  first_touch_lookback_days: null,
  d30_weight: 0.75,
  r48_weight: 0.25,
  d30_prior_weight: 20,
  min_users: 20,
  r48_full_trust_sample: 40,
  neutral_norm: 0.5,
  norm_percentile_low: 0.1,
  norm_percentile_high: 0.9,
};

/**
 * Admin 草稿期的宽松校验：运营改到中间态时（比如权重只填了一半）不该被拦住，
 * 真正的契约校验留到发布时由 LobbyRankingParamsSchema 与库侧函数各做一次。
 */
export const EditableLobbyRankingParamsSchema = z.object({
  window_days: z.number(),
  turn_cap: z.number(),
  session_gap_minutes: z.number(),
  return_window_hours: z.number(),
  first_touch_lookback_days: z.number().nullable(),
  d30_weight: z.number(),
  r48_weight: z.number(),
  d30_prior_weight: z.number(),
  min_users: z.number(),
  r48_full_trust_sample: z.number(),
  neutral_norm: z.number(),
  norm_percentile_low: z.number(),
  norm_percentile_high: z.number(),
});
