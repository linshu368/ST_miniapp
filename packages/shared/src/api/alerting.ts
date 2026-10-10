import { z } from 'zod';

/**
 * 所有领域共用的告警信封。领域规则负责计算证据与健康条件，公共发布层只处理
 * 状态转换和投递；因此这里刻意不包含渠道、重试或任意 provider payload。
 */
export const ALERT_SCHEMA_VERSION = 1 as const;

const AlertTextSchema = z.string().trim().min(1).max(500);
const AlertIdentifierSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9:_-]{2,191}$/);
const IsoDateTimeSchema = z.string().datetime({ offset: true });

export const AlertSeveritySchema = z.enum(['P0', 'P1', 'P2']);
export type AlertSeverity = z.infer<typeof AlertSeveritySchema>;

export const AlertStateSchema = z.enum(['firing', 'healthy']);
export type AlertState = z.infer<typeof AlertStateSchema>;

export const AlertConfidenceSchema = z.enum(['confirmed', 'suspected', 'unknown']);
export type AlertConfidence = z.infer<typeof AlertConfidenceSchema>;

/** 主异常位置只表达归因层级，不把厂商响应或内部错误对象带入公共契约。 */
export const AlertLocationSchema = z
  .object({
    kind: z.enum(['application', 'dependency', 'delivery_path', 'unknown']),
    component: z.string().trim().min(1).max(80).optional(),
  })
  .strict();
export type AlertLocation = z.infer<typeof AlertLocationSchema>;

export const AlertMetricSchema = z
  .object({
    name: AlertIdentifierSchema,
    value: z.number().finite(),
    unit: z.enum(['count', 'ratio', 'milliseconds', 'percent']).optional(),
  })
  .strict();
export type AlertMetric = z.infer<typeof AlertMetricSchema>;

/**
 * 样本只允许安全、已脱敏的定位引用和简短摘要。完整订单号、用户 ID、URL、签名、
 * 原始错误/响应均不能作为此结构的一部分。
 */
export const AlertSampleSchema = z
  .object({
    kind: AlertIdentifierSchema,
    reference: z.string().trim().min(1).max(120),
    summary: z.string().trim().min(1).max(240).optional(),
  })
  .strict();
export type AlertSample = z.infer<typeof AlertSampleSchema>;

export const AlertEvaluationSchema = z
  .object({
    schema_version: z.literal(ALERT_SCHEMA_VERSION),
    /** 同一次规则计算及其安全重试稳定不变，供 Publisher 去重。 */
    evaluation_id: z.string().uuid(),
    /** 每个 producer 执行轮次唯一，用于诊断与同窗顺序比较。 */
    producer_run_id: z.string().uuid(),
    domain: AlertIdentifierSchema,
    service: AlertIdentifierSchema,
    environment: z.enum(['development', 'test', 'preview', 'production']),
    rule_id: AlertIdentifierSchema,
    rule_version: z.string().trim().min(1).max(40),
    rule_group: AlertIdentifierSchema,
    /**
     * 稳定事故身份：由 producer 规范化为 environment:domain:rule_group:channel。
     * 不得包含窗口、订单、用户、严重级别、定位或 rule_version。
     */
    fingerprint: AlertIdentifierSchema,
    state: AlertStateSchema,
    severity: AlertSeveritySchema,
    location: AlertLocationSchema,
    confidence: AlertConfidenceSchema,
    observed_at: IsoDateTimeSchema,
    window_started_at: IsoDateTimeSchema,
    window_ended_at: IsoDateTimeSchema,
    title: AlertTextSchema.max(140),
    summary: AlertTextSchema,
    metrics: z.array(AlertMetricSchema).max(20),
    samples: z.array(AlertSampleSchema).max(10),
    recommended_action: AlertTextSchema.max(500).optional(),
  })
  .strict()
  .superRefine((evaluation, ctx) => {
    if (evaluation.window_started_at > evaluation.window_ended_at) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['window_ended_at'],
        message: 'alert window must not end before it starts',
      });
    }

    const metricNames = evaluation.metrics.map((metric) => metric.name);
    if (new Set(metricNames).size !== metricNames.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['metrics'],
        message: 'alert metric names must be unique',
      });
    }
  });

export type AlertEvaluation = z.infer<typeof AlertEvaluationSchema>;
