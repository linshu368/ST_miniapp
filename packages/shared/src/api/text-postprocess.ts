import { z } from 'zod';

/**
 * 展示后处理协议。schema_version 是快照形状，policy_version 是安全策略。
 * 两者不能混成一个版本号：策略收紧时可以拒绝旧 policy，同时仍能识别快照形状。
 */
export const TEXT_POSTPROCESS_SCHEMA_VERSION = 1;
export const TEXT_POSTPROCESS_POLICY_VERSION = 1;

export const TEXT_POSTPROCESS_HTML_TAGS = [
  'p',
  'div',
  'span',
  'mark',
  'strong',
  'em',
  'b',
  'i',
  'del',
  'br',
  'hr',
  'section',
  'details',
  'summary',
  'ul',
  'ol',
  'li',
  'table',
  'thead',
  'tbody',
  'tr',
  'td',
  'th',
  'button',
  'pre',
  'code',
  'blockquote',
  'h3',
  'h4',
] as const;

export const TEXT_POSTPROCESS_CSS_PROPERTIES = [
  'color',
  'font-family',
  'font-size',
  'font-style',
  'font-weight',
  'line-height',
  'letter-spacing',
  'text-align',
  'text-decoration',
  'text-transform',
  'white-space',
  'overflow-wrap',
  'word-break',
  'background',
  'background-color',
  'border',
  'border-color',
  'border-style',
  'border-width',
  'border-radius',
  'box-shadow',
  'box-sizing',
  'width',
  'min-width',
  'max-width',
  'height',
  'min-height',
  'max-height',
  'margin',
  'padding',
  'overflow',
  'overflow-x',
  'overflow-y',
  'display',
  'flex',
  'flex-basis',
  'flex-direction',
  'flex-grow',
  'flex-shrink',
  'flex-wrap',
  'align-items',
  'align-content',
  'align-self',
  'justify-content',
  'justify-items',
  'justify-self',
  'gap',
  'row-gap',
  'column-gap',
  'grid-template-columns',
  'grid-auto-flow',
  'place-items',
  'list-style',
  'list-style-position',
  'border-collapse',
  'border-spacing',
  'table-layout',
  'vertical-align',
  'transition-property',
  'transition-duration',
  'transition-delay',
  'transition-timing-function',
] as const;

/** 只允许消费这些已有主题变量，模板不能定义新的 custom property。 */
export const TEXT_POSTPROCESS_THEME_COLOR_VARS = [
  '--background',
  '--foreground',
  '--card',
  '--card-foreground',
  '--popover',
  '--popover-foreground',
  '--primary',
  '--primary-foreground',
  '--secondary',
  '--secondary-foreground',
  '--muted',
  '--muted-foreground',
  '--accent',
  '--accent-foreground',
  '--destructive',
  '--destructive-foreground',
  '--border',
  '--input',
  '--ring',
  '--bubble-user',
  '--rose',
  '--rose-fill',
  '--success',
  '--warn',
  '--glow',
] as const;

export const TEXT_POSTPROCESS_THEME_RADIUS_VAR = '--radius';

export const TEXT_POSTPROCESS_LIMITS = {
  maxRules: 100,
  maxPatternUnits: 2_000,
  maxTemplateUnits: 16_000,
  maxCssUnits: 16_000,
  maxSourceUtf8Bytes: 256 * 1024,
  maxNameUnits: 80,
  maxDescriptionUnits: 400,
  maxNotesUnits: 2_000,
  maxMessageUnits: 50_000,
  maxOptionUnits: 8_000,
  maxMatchesPerRule: 1_500,
  maxMatchesPerMessage: 5_000,
  maxTemplateNodes: 1_000,
  maxTemplateDepth: 32,
  maxCaptureRefs: 128,
  maxTemplateTextUnits: 64 * 1024,
  maxCssSelectors: 64,
  maxCssDeclarations: 256,
  maxCssNodes: 3_000,
  maxGeneratedNodes: 10_000,
  maxTrustedSlots: 2_000,
  outputExpansionBase: 65_536,
  outputExpansionFactor: 4,
  outputExpansionCap: 262_144,
  ruleBudgetMs: 100,
  messageBudgetMs: 1_000,
  maxClassTokens: 8,
  maxVersionsPerBatch: 20,
  maxDiagnostics: 100,
} as const;

export const TEXT_POSTPROCESS_RULE_ID = /^[a-z][a-z0-9_-]{0,63}$/;
export const TEXT_POSTPROCESS_CLASS_TOKEN = /^[a-z][a-z0-9_-]{0,63}$/;
export const TEXT_POSTPROCESS_CAPTURE_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;

const RULE_FIELDS = [
  'id',
  'name',
  'description',
  'enabled',
  'pattern',
  'flags',
  'replacement',
  'css',
  'notes',
] as const;

export const TEXT_POSTPROCESS_FIELDS = [...RULE_FIELDS, 'source', 'version', 'request'] as const;

export type TextPostprocessField = (typeof TEXT_POSTPROCESS_FIELDS)[number];
export type TextPostprocessHtmlTag = (typeof TEXT_POSTPROCESS_HTML_TAGS)[number];
export type TextPostprocessCssProperty = (typeof TEXT_POSTPROCESS_CSS_PROPERTIES)[number];

export interface TextPostprocessLocation {
  line: number;
  column: number;
  offset: number;
  length: number;
}

export interface TextPostprocessDiagnostic {
  code: string;
  rule_id: string | null;
  field: TextPostprocessField;
  message: string;
  location: TextPostprocessLocation | null;
}

export const TextPostprocessLocationSchema = z
  .object({
    line: z.number().int().min(1),
    column: z.number().int().min(1),
    offset: z.number().int().nonnegative(),
    length: z.number().int().nonnegative(),
  })
  .strict();

export const TextPostprocessDiagnosticSchema = z
  .object({
    code: z.string().min(1).max(64),
    rule_id: z.string().regex(TEXT_POSTPROCESS_RULE_ID).nullable(),
    field: z.enum(TEXT_POSTPROCESS_FIELDS),
    message: z.string().max(240),
    location: TextPostprocessLocationSchema.nullable(),
  })
  .strict();

const HtmlTagSchema = z.enum(TEXT_POSTPROCESS_HTML_TAGS);
const CssPropertySchema = z.enum(TEXT_POSTPROCESS_CSS_PROPERTIES);

export const CaptureRefSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('number'),
      index: z.number().int().min(1).max(99),
    })
    .strict(),
  z
    .object({
      kind: z.literal('name'),
      name: z.string().regex(TEXT_POSTPROCESS_CAPTURE_NAME),
    })
    .strict(),
  z
    .object({
      kind: z.literal('match'),
    })
    .strict(),
]);

export const TrustedAttributeSchema = z.discriminatedUnion('name', [
  z
    .object({
      name: z.literal('class'),
      tokens: z
        .array(z.string().regex(TEXT_POSTPROCESS_CLASS_TOKEN))
        .min(1)
        .max(TEXT_POSTPROCESS_LIMITS.maxClassTokens),
    })
    .strict(),
  z.object({ name: z.literal('open') }).strict(),
  z.object({ name: z.literal('title'), text: z.string().max(200) }).strict(),
  z.object({ name: z.literal('aria-label'), text: z.string().max(200) }).strict(),
  z.object({ name: z.literal('aria-hidden'), value: z.literal('true') }).strict(),
  z.object({ name: z.literal('colspan'), value: z.number().int().min(1).max(20) }).strict(),
  z.object({ name: z.literal('rowspan'), value: z.number().int().min(1).max(20) }).strict(),
]);

export const SendMessageActionSchema = z
  .object({
    type: z.literal('send-message'),
  })
  .strict();

export type CaptureRef = z.infer<typeof CaptureRefSchema>;
export type TrustedAttribute = z.infer<typeof TrustedAttributeSchema>;
export type SendMessageAction = z.infer<typeof SendMessageActionSchema>;

export type TrustedNode =
  | { type: 'text'; text: string }
  | { type: 'capture'; ref: CaptureRef }
  | {
      type: 'element';
      tag: TextPostprocessHtmlTag;
      attributes: TrustedAttribute[];
      children: TrustedNode[];
      action: SendMessageAction | null;
    };

export const TrustedNodeSchema: z.ZodType<TrustedNode> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z
      .object({
        type: z.literal('text'),
        text: z.string().max(TEXT_POSTPROCESS_LIMITS.maxTemplateTextUnits),
      })
      .strict(),
    z
      .object({
        type: z.literal('capture'),
        ref: CaptureRefSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal('element'),
        tag: HtmlTagSchema,
        attributes: z.array(TrustedAttributeSchema).max(8),
        children: z.array(TrustedNodeSchema).max(TEXT_POSTPROCESS_LIMITS.maxTemplateNodes),
        action: SendMessageActionSchema.nullable(),
      })
      .strict(),
  ])
);

export type CssToken =
  | { t: 'ident'; v: string }
  | { t: 'hash'; v: string }
  | { t: 'string'; v: string }
  | { t: 'number'; v: string }
  | { t: 'dimension'; v: string; u: 'px' | 'rem' | 'em' | 'ms' | 's' | 'deg' | 'fr' }
  | { t: 'percentage'; v: string }
  | {
      t: 'function';
      name: 'rgb' | 'rgba' | 'hsl' | 'hsla' | 'linear-gradient' | 'var' | 'repeat' | 'minmax';
      args: CssToken[];
    }
  | { t: 'operator'; v: ',' | '/' };

export const CssTokenSchema: z.ZodType<CssToken> = z.lazy(() =>
  z.discriminatedUnion('t', [
    z.object({ t: z.literal('ident'), v: z.string().min(1).max(64) }).strict(),
    z.object({ t: z.literal('hash'), v: z.string().regex(/^[0-9a-fA-F]{3,8}$/) }).strict(),
    z.object({ t: z.literal('string'), v: z.string().max(64) }).strict(),
    z
      .object({ t: z.literal('number'), v: z.string().regex(/^[+-]?(?:\d+\.?\d*|\.\d+)$/) })
      .strict(),
    z
      .object({
        t: z.literal('dimension'),
        v: z.string().regex(/^[+-]?(?:\d+\.?\d*|\.\d+)$/),
        u: z.enum(['px', 'rem', 'em', 'ms', 's', 'deg', 'fr']),
      })
      .strict(),
    z
      .object({
        t: z.literal('percentage'),
        v: z.string().regex(/^[+-]?(?:\d+\.?\d*|\.\d+)$/),
      })
      .strict(),
    z
      .object({
        t: z.literal('function'),
        name: z.enum(['rgb', 'rgba', 'hsl', 'hsla', 'linear-gradient', 'var', 'repeat', 'minmax']),
        args: z.array(CssTokenSchema).max(32),
      })
      .strict(),
    z.object({ t: z.literal('operator'), v: z.enum([',', '/']) }).strict(),
  ])
);

const NthPseudoSchema = z
  .object({
    kind: z.literal('nth-child'),
    a: z.number().int().min(-10).max(10).nullable(),
    b: z.number().int().min(0).max(20),
  })
  .strict();

const NamedPseudoSchema = z
  .object({
    kind: z.enum(['first-child', 'last-child', 'hover', 'focus-visible']),
  })
  .strict();

export const CssSelectorSchema = z
  .object({
    compounds: z
      .array(
        z
          .object({
            combinator: z.enum(['descendant', 'child']).nullable(),
            tag: HtmlTagSchema.nullable(),
            classes: z.array(z.string().regex(TEXT_POSTPROCESS_CLASS_TOKEN)).max(8),
            pseudos: z.array(z.union([NamedPseudoSchema, NthPseudoSchema])).max(4),
          })
          .strict()
      )
      .min(1)
      .max(16),
  })
  .strict();

export const CssDeclarationSchema = z
  .object({
    property: CssPropertySchema,
    tokens: z.array(CssTokenSchema).min(1).max(64),
  })
  .strict();

export type CssSelector = z.infer<typeof CssSelectorSchema>;
export type CssDeclaration = z.infer<typeof CssDeclarationSchema>;

export type CssStyleRule = {
  type: 'style';
  selectors: CssSelector[];
  declarations: CssDeclaration[];
};

export type CssMediaCondition =
  | { type: 'width'; feature: 'min-width' | 'max-width'; px: number }
  | { type: 'theme'; scheme: 'light' | 'dark' };

export type CssMediaRule = {
  type: 'media';
  conditions: CssMediaCondition[];
  rules: CssStyleRule[];
};

export type CssRule = CssStyleRule | CssMediaRule;

const CssStyleRuleSchema = z
  .object({
    type: z.literal('style'),
    selectors: z.array(CssSelectorSchema).min(1).max(TEXT_POSTPROCESS_LIMITS.maxCssSelectors),
    declarations: z
      .array(CssDeclarationSchema)
      .min(1)
      .max(TEXT_POSTPROCESS_LIMITS.maxCssDeclarations),
  })
  .strict();

const CssMediaConditionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('width'),
      feature: z.enum(['min-width', 'max-width']),
      px: z.number().int().min(240).max(1200),
    })
    .strict(),
  z
    .object({
      type: z.literal('theme'),
      scheme: z.enum(['light', 'dark']),
    })
    .strict(),
]);

export const CssRuleSchema = z.discriminatedUnion('type', [
  CssStyleRuleSchema,
  z
    .object({
      type: z.literal('media'),
      conditions: z.array(CssMediaConditionSchema).min(1).max(2),
      rules: z.array(CssStyleRuleSchema).min(1).max(32),
    })
    .strict(),
]);

export const CompiledTextPostprocessRuleSchema = z
  .object({
    id: z.string().regex(TEXT_POSTPROCESS_RULE_ID),
    enabled: z.boolean(),
    pattern: z.string().min(1).max(TEXT_POSTPROCESS_LIMITS.maxPatternUnits),
    flags: z.string().max(8),
    groups: z
      .object({
        count: z.number().int().min(0).max(99),
        names: z.array(z.string().regex(TEXT_POSTPROCESS_CAPTURE_NAME)).max(99),
        /** 下标 0 对应第 1 个捕获组；非命名组为 null。 */
        name_by_index: z.array(z.string().regex(TEXT_POSTPROCESS_CAPTURE_NAME).nullable()).max(99),
      })
      .strict(),
    placement: z.enum(['inline', 'block']),
    tree: z.array(TrustedNodeSchema).min(1).max(TEXT_POSTPROCESS_LIMITS.maxTemplateNodes),
    css: z.array(CssRuleSchema).max(64),
  })
  .strict();

export const CompiledTextPostprocessArtifactSchema = z
  .object({
    schema_version: z.literal(TEXT_POSTPROCESS_SCHEMA_VERSION),
    policy_version: z.literal(TEXT_POSTPROCESS_POLICY_VERSION),
    rules: z.array(CompiledTextPostprocessRuleSchema).max(TEXT_POSTPROCESS_LIMITS.maxRules),
  })
  .strict();

export type CompiledTextPostprocessRule = z.infer<typeof CompiledTextPostprocessRuleSchema>;
export type CompiledTextPostprocessArtifact = z.infer<typeof CompiledTextPostprocessArtifactSchema>;

const RuleIdSchema = z.string().regex(TEXT_POSTPROCESS_RULE_ID);

function ruleShape(flags: z.ZodString) {
  return z
    .object({
      id: RuleIdSchema,
      name: z.string().trim().min(1).max(TEXT_POSTPROCESS_LIMITS.maxNameUnits),
      description: z.string().max(TEXT_POSTPROCESS_LIMITS.maxDescriptionUnits),
      enabled: z.boolean(),
      pattern: z.string().min(1).max(TEXT_POSTPROCESS_LIMITS.maxPatternUnits),
      flags,
      replacement: z.string().max(TEXT_POSTPROCESS_LIMITS.maxTemplateUnits),
      css: z.string().max(TEXT_POSTPROCESS_LIMITS.maxCssUnits),
      notes: z.string().max(TEXT_POSTPROCESS_LIMITS.maxNotesUnits),
    })
    .strict();
}

export const TextPostprocessRuleSchema = ruleShape(z.string().max(8));
export type TextPostprocessRule = z.infer<typeof TextPostprocessRuleSchema>;

function sourceUtf8Bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function flagsAreSafe(flags: string): boolean {
  if (!/^[gimsu]*$/.test(flags)) return false;
  const seen = new Set<string>();
  for (const flag of flags) {
    if (seen.has(flag)) return false;
    seen.add(flag);
  }
  return true;
}

function refineSource(
  value: { rules: Array<{ id: string; flags: string }> },
  ctx: z.RefinementCtx,
  checkFlags: boolean
): void {
  const seen = new Set<string>();
  value.rules.forEach((rule, index) => {
    if (seen.has(rule.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rules', index, 'id'],
        message: 'DUPLICATE_RULE_ID',
      });
    }
    seen.add(rule.id);
    if (checkFlags && !flagsAreSafe(rule.flags)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rules', index, 'flags'],
        message: 'INVALID_FLAGS',
      });
    }
  });
  if (sourceUtf8Bytes(value) > TEXT_POSTPROCESS_LIMITS.maxSourceUtf8Bytes) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['rules'],
      message: 'CAPACITY_EXCEEDED',
    });
  }
}

function sourceSchema(checkFlags: boolean) {
  return z
    .object({
      schema_version: z.literal(TEXT_POSTPROCESS_SCHEMA_VERSION),
      policy_version: z.literal(TEXT_POSTPROCESS_POLICY_VERSION),
      rules: z.array(ruleShape(z.string().max(8))).max(TEXT_POSTPROCESS_LIMITS.maxRules),
    })
    .strict()
    .superRefine((value, ctx) => refineSource(value, ctx, checkFlags));
}

/** 可发布 source。flags 必须是无重复的 g/i/m/s/u。 */
export const TextPostprocessSourceSchema = sourceSchema(true);
/** 草稿只做结构和容量校验，允许尚未能编译的正则或模板。 */
export const TextPostprocessDraftSourceSchema = sourceSchema(false);

export type TextPostprocessSource = z.infer<typeof TextPostprocessSourceSchema>;
export type TextPostprocessDraftSource = z.infer<typeof TextPostprocessDraftSourceSchema>;

export const TextPostprocessSourceSnapshotSchema = z
  .object({
    version: z.number().int().positive(),
    schema_version: z.literal(TEXT_POSTPROCESS_SCHEMA_VERSION),
    policy_version: z.literal(TEXT_POSTPROCESS_POLICY_VERSION),
    source: TextPostprocessSourceSchema,
    published_at: z.string().datetime(),
  })
  .strict();

/** 兼容既有 Admin 消费者名称；MiniApp 必须使用 ArtifactSnapshot。 */
export const TextPostprocessVersionSnapshotSchema = TextPostprocessSourceSnapshotSchema;
export type TextPostprocessSourceSnapshot = z.infer<typeof TextPostprocessSourceSnapshotSchema>;

/** MiniApp 只消费已编译快照；Admin 编辑态继续使用 source 快照。 */
export const TextPostprocessArtifactSnapshotSchema = z
  .object({
    version: z.number().int().positive(),
    artifact: CompiledTextPostprocessArtifactSchema,
    published_at: z.string().datetime(),
  })
  .strict();
export type TextPostprocessArtifactSnapshot = z.infer<typeof TextPostprocessArtifactSnapshotSchema>;

export const ReadTextPostprocessVersionsRequestSchema = z
  .object({
    versions: z
      .array(z.number().int().positive())
      .min(1)
      .max(TEXT_POSTPROCESS_LIMITS.maxVersionsPerBatch),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.versions).size !== value.versions.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['versions'],
        message: 'DUPLICATE_VERSION',
      });
    }
  });

export const ReadTextPostprocessVersionsDataSchema = z
  .object({
    found: z
      .array(TextPostprocessArtifactSnapshotSchema)
      .max(TEXT_POSTPROCESS_LIMITS.maxVersionsPerBatch),
    unavailable_versions: z
      .array(z.number().int().positive())
      .max(TEXT_POSTPROCESS_LIMITS.maxVersionsPerBatch),
  })
  .strict();

const RequestIdSchema = z.string().uuid();
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const TimestampSchema = z.string().datetime();

export const SaveTextPostprocessDraftRequestSchema = z
  .object({
    request_id: RequestIdSchema,
    expected_runtime_version: z.number().int().positive().nullable(),
    expected_draft_updated_at: TimestampSchema.nullable(),
    expected_draft_digest: DigestSchema.nullable(),
    source: TextPostprocessDraftSourceSchema,
  })
  .strict();

export const PublishTextPostprocessRequestSchema = z
  .object({
    request_id: RequestIdSchema,
    expected_runtime_version: z.number().int().positive().nullable(),
    expected_draft_updated_at: TimestampSchema,
    expected_draft_digest: DigestSchema,
    draft_revision: z.string().min(1).max(128),
  })
  .strict();

export const RollbackTextPostprocessRequestSchema = z
  .object({
    request_id: RequestIdSchema,
    expected_runtime_version: z.number().int().positive(),
    target_version: z.number().int().positive(),
  })
  .strict();

export const DiscardTextPostprocessDraftRequestSchema = z
  .object({
    request_id: RequestIdSchema,
    expected_draft_updated_at: TimestampSchema,
    expected_draft_digest: DigestSchema,
  })
  .strict();

export const TEXT_POSTPROCESS_MUTATION_ERROR_CODES = [
  'invalid_source',
  'invalid_draft',
  'compile_rejected',
  'cas_conflict',
  'request_id_conflict',
  'draft_revision_mismatch',
  'target_version_unavailable',
  'policy_unsupported',
  'forbidden',
] as const;

export const TextPostprocessMutationErrorSchema = z
  .object({
    code: z.enum(TEXT_POSTPROCESS_MUTATION_ERROR_CODES),
    message: z.string().min(1).max(240),
    diagnostics: z
      .array(TextPostprocessDiagnosticSchema)
      .max(TEXT_POSTPROCESS_LIMITS.maxDiagnostics),
  })
  .strict();

export type TextPostprocessVersionSnapshot = z.infer<typeof TextPostprocessVersionSnapshotSchema>;
export type ReadTextPostprocessVersionsRequest = z.infer<
  typeof ReadTextPostprocessVersionsRequestSchema
>;
export type ReadTextPostprocessVersionsData = z.infer<typeof ReadTextPostprocessVersionsDataSchema>;
export type SaveTextPostprocessDraftRequest = z.infer<typeof SaveTextPostprocessDraftRequestSchema>;
export type PublishTextPostprocessRequest = z.infer<typeof PublishTextPostprocessRequestSchema>;
export type RollbackTextPostprocessRequest = z.infer<typeof RollbackTextPostprocessRequestSchema>;
export type DiscardTextPostprocessDraftRequest = z.infer<
  typeof DiscardTextPostprocessDraftRequestSchema
>;
export type TextPostprocessMutationErrorCode =
  (typeof TEXT_POSTPROCESS_MUTATION_ERROR_CODES)[number];
export type TextPostprocessMutationError = z.infer<typeof TextPostprocessMutationErrorSchema>;

/**
 * 写 RPC 的对外结果。字段与 admin.*_text_postprocess* 返回的 outcome 对齐。
 * 不包含 source、模板、CSS、操作人或测试文本。
 */
export const TextPostprocessMutationOutcomeSchema = z
  .object({
    action: z.enum(['save', 'publish', 'rollback', 'discard']),
    replayed: z.boolean(),
    draft_id: z.string().uuid().optional(),
    draft_revision: z.string().min(1).max(128).optional(),
    updated_at: z.string().datetime().optional(),
    content_digest: DigestSchema.optional(),
    base_version: z.number().int().nonnegative().optional(),
    runtime_version: z.number().int().positive().nullable().optional(),
    version: z.number().int().positive().optional(),
    schema_version: z.literal(TEXT_POSTPROCESS_SCHEMA_VERSION).optional(),
    policy_version: z.literal(TEXT_POSTPROCESS_POLICY_VERSION).optional(),
    published_at: z.string().datetime().optional(),
    release_id: z.string().uuid().optional(),
    target_version: z.number().int().positive().optional(),
    rollback_of_release_id: z.string().uuid().optional(),
  })
  .strict();

export const TextPostprocessDraftStateSchema = z
  .object({
    draft_revision: z.string().min(1).max(128),
    updated_at: z.string().datetime(),
    content_digest: DigestSchema,
    base_version: z.number().int().nonnegative(),
    source: TextPostprocessDraftSourceSchema.nullable(),
  })
  .strict();

export const TextPostprocessAdminStateSchema = z
  .object({
    runtime_version: z.number().int().positive().nullable(),
    published: TextPostprocessSourceSnapshotSchema.nullable(),
    draft: TextPostprocessDraftStateSchema.nullable(),
    history: z
      .array(TextPostprocessSourceSnapshotSchema)
      .max(TEXT_POSTPROCESS_LIMITS.maxVersionsPerBatch),
    has_more: z.boolean(),
  })
  .strict();

export const TextPostprocessRequestLookupSchema = z
  .object({
    outcome: TextPostprocessMutationOutcomeSchema.nullable(),
  })
  .strict();

export type TextPostprocessMutationOutcome = z.infer<typeof TextPostprocessMutationOutcomeSchema>;
export type TextPostprocessDraftState = z.infer<typeof TextPostprocessDraftStateSchema>;
export type TextPostprocessAdminState = z.infer<typeof TextPostprocessAdminStateSchema>;
export type TextPostprocessRequestLookup = z.infer<typeof TextPostprocessRequestLookupSchema>;

export interface TextPostprocessTextSegment {
  type: 'text';
  text: string;
  start: number;
  end: number;
}

export interface TextPostprocessCaptureValue {
  index: number;
  name: string | null;
  text: string;
}

export interface TextPostprocessChoice {
  text: string;
  sendable: boolean;
}

export interface TextPostprocessSlotSegment {
  type: 'slot';
  rule_id: string;
  start: number;
  end: number;
  placement: 'inline' | 'block';
  match_text: string;
  captures: TextPostprocessCaptureValue[];
  tree: TrustedNode[];
  choices: TextPostprocessChoice[];
}

export type TextPostprocessSegment = TextPostprocessTextSegment | TextPostprocessSlotSegment;

export type TextPostprocessApplyResult =
  | {
      status: 'applied';
      segments: TextPostprocessSegment[];
      skipped_rules: Array<{ rule_id: string; code: string }>;
      stats: { matches: number; slots: number; nodes: number; text_units: number };
    }
  | {
      status: 'original';
      reason: string;
      segments: [TextPostprocessTextSegment];
    };

const DIAGNOSTIC_MESSAGES: Record<string, string> = {
  DUPLICATE_RULE_ID: 'Rule ids must be unique.',
  INVALID_FLAGS: 'Flags are not in the supported set.',
  UNKNOWN_FIELD: 'Unknown field.',
  CAPACITY_EXCEEDED: 'Source exceeds a capacity limit.',
  INVALID_SCHEMA: 'Source field failed validation.',
  DUPLICATE_VERSION: 'Version ids must be unique.',
};

function issueCode(issue: z.ZodIssue): string {
  if (issue.code === 'unrecognized_keys') return 'UNKNOWN_FIELD';
  if (issue.code === 'too_big' || issue.code === 'too_small') return 'CAPACITY_EXCEEDED';
  if (issue.code === 'custom' && issue.message in DIAGNOSTIC_MESSAGES) return issue.message;
  return 'INVALID_SCHEMA';
}

function issueField(path: PropertyKey[]): TextPostprocessField {
  const last = path[path.length - 1];
  if (last === 'schema_version' || last === 'policy_version' || last === 'versions') {
    return 'version';
  }
  if (
    last === 'id' ||
    last === 'name' ||
    last === 'description' ||
    last === 'enabled' ||
    last === 'pattern' ||
    last === 'flags' ||
    last === 'replacement' ||
    last === 'css' ||
    last === 'notes'
  ) {
    return last;
  }
  if (last === 'request_id' || last === 'draft_revision') return 'request';
  return 'source';
}

function safeRuleId(input: unknown, path: PropertyKey[]): string | null {
  const rulesIndex = path.findIndex((part) => part === 'rules');
  const index = path[rulesIndex + 1];
  if (rulesIndex < 0 || typeof index !== 'number') return null;
  if (!input || typeof input !== 'object' || !('rules' in input)) return null;
  const rules = input.rules;
  if (!Array.isArray(rules)) return null;
  const rule = rules[index];
  if (!rule || typeof rule !== 'object' || !('id' in rule)) return null;
  const id = rule.id;
  return typeof id === 'string' && TEXT_POSTPROCESS_RULE_ID.test(id) ? id : null;
}

export function diagnosticsFromZod(error: z.ZodError, input: unknown): TextPostprocessDiagnostic[] {
  return error.issues.slice(0, TEXT_POSTPROCESS_LIMITS.maxDiagnostics).map((issue) => {
    const code = issueCode(issue);
    return {
      code,
      rule_id: safeRuleId(input, issue.path),
      field: issueField(issue.path),
      message: DIAGNOSTIC_MESSAGES[code] ?? DIAGNOSTIC_MESSAGES.INVALID_SCHEMA ?? 'Invalid source.',
      location: null,
    };
  });
}

export function parseTextPostprocessSource(
  input: unknown
):
  | { ok: true; source: TextPostprocessSource }
  | { ok: false; diagnostics: TextPostprocessDiagnostic[] } {
  const parsed = TextPostprocessSourceSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, diagnostics: diagnosticsFromZod(parsed.error, input) };
  }
  return { ok: true, source: parsed.data };
}

export function parseTextPostprocessDraft(
  input: unknown
):
  | { ok: true; source: TextPostprocessDraftSource }
  | { ok: false; diagnostics: TextPostprocessDiagnostic[] } {
  const parsed = TextPostprocessDraftSourceSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, diagnostics: diagnosticsFromZod(parsed.error, input) };
  }
  return { ok: true, source: parsed.data };
}

export function outputTextLimit(inputUnits: number): number {
  return Math.min(
    inputUnits * TEXT_POSTPROCESS_LIMITS.outputExpansionFactor +
      TEXT_POSTPROCESS_LIMITS.outputExpansionBase,
    TEXT_POSTPROCESS_LIMITS.outputExpansionCap
  );
}

/**
 * 旧消息和旧 producer 可能根本没有这个字段。缺失、null 和非正整数都按“无规则版本”处理。
 */
export function readPostprocessVersion(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return null;
  return value;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonical(item));
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    sorted[key] = canonical(record[key]);
  }
  return sorted;
}

/** 发布摘要使用的稳定 JSON。调用方自行做 SHA-256，shared 不读取环境或密钥。 */
export function canonicalTextPostprocessJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

export function assessRequestReplay(input: {
  existingDigest: string;
  nextDigest: string;
}): 'same' | 'conflict' {
  return input.existingDigest === input.nextDigest ? 'same' : 'conflict';
}
