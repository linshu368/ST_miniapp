export type DatabaseEnvironment = 'development' | 'test' | 'production';
export type DatabaseTarget = 'test' | 'production';

export const DEFAULT_PROD_SUPABASE_PROJECT_REF = 'wbtsfzozlmurljvglhpn';
export const DEFAULT_TEST_SUPABASE_PROJECT_REF = 'qekxjxpznjvoccvmgozk';

type Env = Record<string, string | undefined>;

type DatabaseConfigOptions = {
  env: Env;
  nodeEnv?: string;
  variableNames?: readonly string[];
};

export type DatabaseRuntimeConfig = {
  environment: DatabaseEnvironment;
  target: DatabaseTarget;
  projectRef: string | null;
  prodProjectRef: string;
  testProjectRef: string;
};

const DEFAULT_VARIABLE_NAMES = [
  'DATABASE_URL',
  'DIRECT_URL',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_PROJECT_REF',
] as const;

function isExplicitlyEnabled(value: string | undefined): boolean {
  return value === 'true' || value === '1';
}

export function normalizeDatabaseEnvironment(
  value: string | undefined,
  env: Env
): DatabaseEnvironment {
  if (value === 'production' || value === 'test' || value === 'development') {
    return value;
  }
  if (env.RAILWAY_ENVIRONMENT === 'production' || env.RAILWAY_ENVIRONMENT_NAME === 'production') {
    return 'production';
  }
  return env.NODE_ENV === 'production' ? 'production' : 'development';
}

export function extractSupabaseProjectRef(value: string | undefined): string | null {
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

export function createDatabaseConfig({
  env,
  variableNames = DEFAULT_VARIABLE_NAMES,
}: DatabaseConfigOptions): DatabaseRuntimeConfig {
  const environment = normalizeDatabaseEnvironment(env.DATABASE_ENV, env);
  const prodProjectRef = env.PROD_SUPABASE_PROJECT_REF || DEFAULT_PROD_SUPABASE_PROJECT_REF;
  const testProjectRef = env.TEST_SUPABASE_PROJECT_REF || DEFAULT_TEST_SUPABASE_PROJECT_REF;
  const target: DatabaseTarget = environment === 'production' ? 'production' : 'test';
  const prefix = target === 'production' ? 'PROD' : 'TEST';

  for (const name of variableNames) {
    const selectedValue = env[`${prefix}_${name}`];
    if (selectedValue) {
      env[name] = selectedValue;
    }
  }

  env.DATABASE_ENV = environment;
  env.SUPABASE_PROJECT_REF =
    env.SUPABASE_PROJECT_REF || (target === 'production' ? prodProjectRef : testProjectRef);

  const refs = [
    env.SUPABASE_PROJECT_REF || null,
    ...variableNames.map((name) => extractSupabaseProjectRef(env[name])),
  ].filter((value): value is string => Boolean(value));
  const uniqueRefs = Array.from(new Set(refs));
  const projectRef = uniqueRefs[0] || null;

  assertDatabaseIsolation({
    environment,
    projectRef,
    uniqueRefs,
    prodProjectRef,
    testProjectRef,
    allowProdDatabase: isExplicitlyEnabled(env.ALLOW_PROD_DATABASE),
  });

  return {
    environment,
    target,
    projectRef,
    prodProjectRef,
    testProjectRef,
  };
}

function assertDatabaseIsolation({
  environment,
  projectRef,
  uniqueRefs,
  prodProjectRef,
  testProjectRef,
  allowProdDatabase,
}: {
  environment: DatabaseEnvironment;
  projectRef: string | null;
  uniqueRefs: string[];
  prodProjectRef: string;
  testProjectRef: string;
  allowProdDatabase: boolean;
}): void {
  if (uniqueRefs.length === 0) return;

  if (uniqueRefs.length > 1) {
    throw new Error(`Supabase 配置中出现多个 project ref：${uniqueRefs.join(', ')}`);
  }

  if (environment === 'test' && projectRef !== testProjectRef) {
    throw new Error(
      `DATABASE_ENV=test 必须连接测试 Supabase 项目 ${testProjectRef}，当前为 ${projectRef ?? 'unknown'}`
    );
  }

  if (environment === 'production' && projectRef !== prodProjectRef) {
    throw new Error(
      `DATABASE_ENV=production 必须连接生产 Supabase 项目 ${prodProjectRef}，当前为 ${
        projectRef ?? 'unknown'
      }`
    );
  }

  if (environment !== 'production' && projectRef === prodProjectRef && !allowProdDatabase) {
    throw new Error(
      '非 production 环境禁止连接生产 Supabase 项目。若确需临时操作，必须显式设置 ALLOW_PROD_DATABASE=true'
    );
  }
}
