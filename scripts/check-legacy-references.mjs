#!/usr/bin/env node
/**
 * 禁止旧链路与旧 schema 的新引用。
 *
 * 这是「一个关键行为只能有一条主路径」的守门人：历史上 ST 退场、schema 拆八域、
 * growth 下线、支付方案变更都留下过并行链路，靠人 review 记不住哪条已经死了。
 * 每条规则都对应一个已经收口完成的决定，命中即说明有人又开了第二条。
 *
 * 只扫活代码（packages/<pkg>/src、scripts、botlink）。历史迁移 SQL、docs、
 * ops 快照按定义就是留档，不在扫描范围内——改已执行过的迁移比留着它更危险。
 *
 * 本地跑：pnpm lint:legacy
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(fileURLToPath(import.meta.url), '..', '..');

/** 活代码根目录。migrations / docs / ops 快照刻意不在内。 */
const SCAN_ROOTS = ['packages', 'scripts', 'botlink'];

const SCAN_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.py', '.sql', '.toml'];

const SKIP_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'build',
  '.next',
  '.turbo',
  'coverage',
  'migrations', // packages/shared/migrations：历史迁移留档
  'generated',
]);

/**
 * allow 里的路径是该规则的唯一合法归属地——也就是「这条主路径本人」。
 * 新增 allow 等于宣布又多了一个出口，改这里必须在 PR 里说明理由。
 */
const RULES = [
  // ── 旧 schema：099 拆域后 miniapp 只剩空壳，批次 D 待删 ──────────────────
  {
    id: 'miniapp-schema-client',
    pattern: /(?:\.schema\(|getDomainDb\()\s*['"]miniapp['"]/g,
    message: "miniapp schema 已是空壳。按域取客户端：getDomainDb('app_core' | 'experience' | ...)",
  },
  {
    id: 'miniapp-schema-sql',
    pattern: /\b(?:from|join|into|update|table)\s+miniapp\.\w+/gi,
    message: 'miniapp.* 表已迁往八个归属域，用新域的全限定名（见 docs/schema归属地图.md）',
  },
  {
    id: 'dropped-schema-sql',
    pattern:
      /\b(?:from|join|into|update|table)\s+(?:st_platform|st_users|st_infra|miniapp_simulation|growth)\.\w+/gi,
    message:
      'st_platform / st_users / st_infra（088）、growth（089）、miniapp_simulation（090）已删库。渠道归因走 miniapp_traffic',
  },

  // ── 已整包删除的 package ────────────────────────────────────────────────
  {
    id: 'deleted-packages',
    pattern: /@miniapp\/(?:db-types|sync-engine|st-extension)|@repo\/bridge-protocol/g,
    message: '这些包已随 ST 清理整包删除。对外类型走 @miniapp/shared',
  },

  // ── 已退场的旧实现标识符 ────────────────────────────────────────────────
  {
    id: 'retired-identifiers',
    pattern:
      /\bapiStreamClient\b|\bplatform_presets\b|\bchat_engine_mode\b|routes\/llm-proxy|\bdeduct_wallet_credits\b/g,
    message:
      'ST 时代残留：SSE 客户端用 lib/api/conversation-stream.ts；预设（088）与 chat_engine_mode（083）已删；扣费走 charge_llm_usage',
  },

  {
    id: 'st-handle',
    pattern: /\bst_handle\b|\bst_initialized_at\b|\bderiveStHandle\b|st-bridge/g,
    message:
      'ST 身份映射已退场（迁移 111/112）。用户身份只用 app_core.users.tg_id；测试数据认领走 scripts/pending-user-ledger.ts',
  },

  // ── 一个关键行为一条主路径 ──────────────────────────────────────────────
  {
    id: 'chat-history-writer',
    pattern: /from\(\s*['"]chat_history['"]\s*\)/g,
    message:
      'experience.chat_history 只能由 ConversationHistoryRepository 读写（列归属见该文件头注释）',
    allow: [
      'packages/backend/src/infrastructure/repositories/ConversationHistoryRepository.ts',
      // 测试与回归夹具直连库造数据、断言与清理，不经业务链路
      'packages/backend/src/infrastructure/repositories/conversations.integration.test.ts',
      'packages/backend/src/scripts/mvp-regression/fixtures.ts',
      'packages/backend/src/scripts/mvp-regression/scenarios.ts',
      'packages/backend/src/scripts/invite-uat/fixtures.ts',
    ],
  },
  {
    id: 'llm-chat-upstream',
    pattern: /['"`][^'"`]*\/chat\/completions/g,
    message:
      '聊天 LLM 只有一个出口：features/generation/upstream.ts（架构铁律 6）。语音写稿是刻意的例外，见 features/voice/voice-draft.ts',
    allow: [
      'packages/backend/src/features/generation/upstream.ts',
      'packages/backend/src/features/generation/upstream.test.ts',
      'packages/backend/src/scripts/mvp-regression/mock-upstream.ts',
      // 语音写稿的 DeepSeek 端点：与聊天不同供应商、非流式、抽取任务、按次计费，
      // 业务上确实独立（理由见 features/voice/voice-draft.ts 与 features/voice/billing.ts）
      'packages/backend/src/platform/config.ts',
      'packages/backend/src/features/voice/voice-draft.test.ts',
    ],
  },
  {
    id: 'openrouter-generation-api',
    pattern: /openrouter\.ai\/api\/v1\/generation/g,
    message:
      'OpenRouter 用量统计只由 features/generation/openrouter-metadata.ts 读取，两个消费方共用同一套字段映射',
    allow: ['packages/backend/src/features/generation/openrouter-metadata.ts'],
  },
  {
    id: 'payment-settlement',
    pattern: /\bcomplete_payment_order\b/g,
    message:
      '支付到账只有一个出口：features/payment/usecases/PaymentSettlement.settlePaidOrder（四路入账都收口在它）',
    allow: [
      'packages/backend/src/features/payment/usecases/PaymentSettlement.ts',
      'packages/backend/src/infrastructure/repositories/MiniappPaymentOrderRepository.ts',
      'packages/backend/src/scripts/invite-uat/fixtures.ts',
    ],
  },
  {
    id: 'llm-usage-charge',
    pattern: /\bchargeLlmUsage\b/g,
    message:
      'LLM 定档扣费只有一个出口：features/generation/apply-charge.ts。settle / sync-job 组 command 后调 applyLlmCharge，禁止再直接 chargeLlmUsage',
    allow: [
      'packages/backend/src/features/generation/apply-charge.ts',
      'packages/backend/src/infrastructure/repositories/MiniappWalletRepository.ts',
      'packages/backend/src/features/generation/apply-charge.test.ts',
      'packages/backend/src/features/generation/sync-job.test.ts',
    ],
  },
];

function shouldScan(path) {
  return SCAN_EXTENSIONS.some((ext) => path.endsWith(ext));
}

function collectFiles(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }

  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const full = join(dir, entry);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry)) continue;
      collectFiles(full, out);
    } else if (shouldScan(full)) {
      out.push(full);
    }
  }
  return out;
}

/** packages 下只扫 src 与包根配置，避免扫进各包的构建产物与夹带资源。 */
function scanTargets() {
  const files = [];
  for (const root of SCAN_ROOTS) {
    const rootPath = join(repoRoot, root);
    let stats;
    try {
      stats = statSync(rootPath);
    } catch {
      continue;
    }
    if (!stats.isDirectory()) continue;

    if (root === 'packages') {
      for (const pkg of readdirSync(rootPath)) {
        if (pkg.startsWith('.')) continue;
        collectFiles(join(rootPath, pkg, 'src'), files);
      }
    } else {
      collectFiles(rootPath, files);
    }
  }
  return files;
}

const selfPath = relative(repoRoot, fileURLToPath(import.meta.url))
  .split(sep)
  .join('/');
const violations = [];

for (const file of scanTargets()) {
  const relPath = relative(repoRoot, file).split(sep).join('/');
  if (relPath === selfPath) continue;

  const source = readFileSync(file, 'utf8');
  const lines = source.split('\n');

  for (const rule of RULES) {
    if (rule.allow?.includes(relPath)) continue;
    if (!new RegExp(rule.pattern.source, rule.pattern.flags).test(source)) continue;

    lines.forEach((line, index) => {
      const matcher = new RegExp(rule.pattern.source, rule.pattern.flags);
      const match = matcher.exec(line);
      if (!match) return;
      violations.push({
        rule,
        file: relPath,
        line: index + 1,
        snippet: line.trim().slice(0, 160),
      });
    });
  }
}

if (violations.length === 0) {
  console.log('legacy-reference guard: 未发现旧链路 / 旧 schema 的新引用');
  process.exit(0);
}

console.error(`\nlegacy-reference guard 发现 ${violations.length} 处违规：\n`);

const byRule = new Map();
for (const violation of violations) {
  const bucket = byRule.get(violation.rule.id) ?? [];
  bucket.push(violation);
  byRule.set(violation.rule.id, bucket);
}

for (const [ruleId, hits] of byRule) {
  console.error(`[${ruleId}] ${hits[0].rule.message}`);
  for (const hit of hits) {
    console.error(`    ${hit.file}:${hit.line}  ${hit.snippet}`);
  }
  console.error('');
}

console.error(
  '如果这确实是一条业务上必须独立的新路径，请在 PR 里说明理由，并把它加进\n' +
    'scripts/check-legacy-references.mjs 对应规则的 allow 清单。\n'
);
process.exit(1);
