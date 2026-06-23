import 'dotenv/config';

type DatabaseEnvironment = 'development' | 'test' | 'production';
type DatabaseTarget = 'test' | 'production';

const DEFAULT_PROD_SUPABASE_PROJECT_REF = 'wbtsfzozlmurljvglhpn';
const DEFAULT_TEST_SUPABASE_PROJECT_REF = 'qekxjxpznjvoccvmgozk';

function normalizeDatabaseEnvironment(value: string | undefined): DatabaseEnvironment {
  if (value === 'production' || value === 'test' || value === 'development') {
    return value;
  }
  if (
    process.env.RAILWAY_ENVIRONMENT === 'production' ||
    process.env.RAILWAY_ENVIRONMENT_NAME === 'production'
  ) {
    return 'production';
  }
  return process.env.NODE_ENV === 'production' ? 'production' : 'development';
}

function extractSupabaseProjectRef(value: string | undefined): string | null {
  if (!value) return null;

  const patterns = [
    /https?:\/\/([a-z0-9]{20})\.supabase\.co/i,
    /db\.([a-z0-9]{20})\.supabase\.co/i,
    /postgres(?:ql)?:\/\/[^@/]*postgres\.([a-z0-9]{20})[:@]/i,
  ];

  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match?.[1]) return match[1];
  }

  return null;
}

const nodeEnv = process.env.NODE_ENV || 'development';
const databaseEnv = normalizeDatabaseEnvironment(process.env.DATABASE_ENV);
const prodSupabaseProjectRef =
  process.env.PROD_SUPABASE_PROJECT_REF || DEFAULT_PROD_SUPABASE_PROJECT_REF;
const testSupabaseProjectRef =
  process.env.TEST_SUPABASE_PROJECT_REF || DEFAULT_TEST_SUPABASE_PROJECT_REF;
const databaseTarget: DatabaseTarget = databaseEnv === 'production' ? 'production' : 'test';

function applyDatabaseTargetEnvironment(): void {
  const prefix = databaseTarget === 'production' ? 'PROD' : 'TEST';
  const selectedProjectRef =
    databaseTarget === 'production' ? prodSupabaseProjectRef : testSupabaseProjectRef;

  const variableNames = [
    'DATABASE_URL',
    'DIRECT_URL',
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_PROJECT_REF',
  ] as const;

  for (const name of variableNames) {
    const selectedValue = process.env[`${prefix}_${name}`];
    if (selectedValue) {
      process.env[name] = selectedValue;
    }
  }

  process.env.DATABASE_ENV = databaseEnv;
  process.env.SUPABASE_PROJECT_REF = process.env.SUPABASE_PROJECT_REF || selectedProjectRef;
}

applyDatabaseTargetEnvironment();

const detectedSupabaseProjectRefs = [
  process.env.SUPABASE_PROJECT_REF || null,
  extractSupabaseProjectRef(process.env.SUPABASE_URL),
  extractSupabaseProjectRef(process.env.DATABASE_URL),
  extractSupabaseProjectRef(process.env.DIRECT_URL),
].filter((value): value is string => Boolean(value));
const uniqueSupabaseProjectRefs = Array.from(new Set(detectedSupabaseProjectRefs));
const configuredSupabaseProjectRef = uniqueSupabaseProjectRefs[0] || null;

function assertDatabaseIsolation(): void {
  if (uniqueSupabaseProjectRefs.length === 0) return;

  if (uniqueSupabaseProjectRefs.length > 1) {
    throw new Error(`Supabase 配置中出现多个 project ref：${uniqueSupabaseProjectRefs.join(', ')}`);
  }

  if (databaseEnv === 'test' && configuredSupabaseProjectRef !== testSupabaseProjectRef) {
    throw new Error(
      `DATABASE_ENV=test 必须连接测试 Supabase 项目 ${testSupabaseProjectRef}，当前为 ${configuredSupabaseProjectRef}`
    );
  }

  if (databaseEnv === 'production' && configuredSupabaseProjectRef !== prodSupabaseProjectRef) {
    throw new Error(
      `DATABASE_ENV=production 必须连接生产 Supabase 项目 ${prodSupabaseProjectRef}，当前为 ${configuredSupabaseProjectRef}`
    );
  }

  if (
    databaseEnv !== 'production' &&
    configuredSupabaseProjectRef === prodSupabaseProjectRef &&
    process.env.ALLOW_PROD_DATABASE !== '1'
  ) {
    throw new Error(
      '非 production 环境禁止连接生产 Supabase 项目。若确需临时操作，必须显式设置 ALLOW_PROD_DATABASE=1'
    );
  }

  if (nodeEnv === 'production' && databaseEnv !== 'production') {
    throw new Error('NODE_ENV=production 时 DATABASE_ENV 必须为 production');
  }
}

assertDatabaseIsolation();

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
  nodeEnv,
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',

  // ── 数据库环境隔离 ────────────────────────────────────────────────────────
  database: {
    environment: databaseEnv,
    projectRef: configuredSupabaseProjectRef,
    prodProjectRef: prodSupabaseProjectRef,
    testProjectRef: testSupabaseProjectRef,
    target: databaseTarget,
  },

  // ── Supabase ───────────────────────────────────────────────────────────────
  supabase: {
    url: process.env.SUPABASE_URL || '',
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  },

  // ── ST 相关 ──────────────────────────────────────────────────────────────
  /** ST 服务地址，Bridge 用于登录和反向代理 */
  stBaseUrl: process.env.ST_BASE_URL || 'http://localhost:8000',
  /** 用户密码派生密钥，与 sync-engine 保持一致 */
  stUserPasswordSecret: process.env.ST_USER_PASSWORD_SECRET || '',

  // ── Provision 服务 ────────────────────────────────────────────────────────
  /** sync-engine Bridge API 地址，Bridge 调用 provision */
  stProvisionUrl: process.env.ST_PROVISION_URL || 'http://127.0.0.1:9091',

  // ── MiniApp 支付 ───────────────────────────────────────────────────────────
  payment: {
    enabled: process.env.PAYMENT_ENABLED === 'true',
    merchantId: process.env.PAYMENT_MERCHANT_ID || '',
    merchantKey: process.env.PAYMENT_MERCHANT_KEY || '',
    baseUrl: process.env.PAYMENT_BASE_URL || 'http://jlusdt.com',
    notifyUrl: process.env.PAYMENT_NOTIFY_URL || '',
    returnUrl: process.env.PAYMENT_RETURN_URL || '',
  },
} as const;
