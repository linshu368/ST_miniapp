import { describe, expect, it } from 'vitest';
import {
  createDatabaseConfig,
  DEFAULT_PROD_SUPABASE_PROJECT_REF,
  DEFAULT_TEST_SUPABASE_PROJECT_REF,
} from '../config/database.js';

describe('createDatabaseConfig', () => {
  it('allows production runtime builds to target the test database explicitly', () => {
    const env: Record<string, string | undefined> = {
      NODE_ENV: 'production',
      DATABASE_ENV: 'test',
      TEST_SUPABASE_URL: `https://${DEFAULT_TEST_SUPABASE_PROJECT_REF}.supabase.co`,
    };

    const config = createDatabaseConfig({ env });

    expect(config.environment).toBe('test');
    expect(config.target).toBe('test');
    expect(config.projectRef).toBe(DEFAULT_TEST_SUPABASE_PROJECT_REF);
    expect(env.SUPABASE_URL).toBe(`https://${DEFAULT_TEST_SUPABASE_PROJECT_REF}.supabase.co`);
  });

  it('still rejects production database refs outside the production database environment', () => {
    const env: Record<string, string | undefined> = {
      NODE_ENV: 'production',
      DATABASE_ENV: 'test',
      TEST_SUPABASE_URL: `https://${DEFAULT_PROD_SUPABASE_PROJECT_REF}.supabase.co`,
    };

    expect(() => createDatabaseConfig({ env })).toThrow('多个 project ref');
  });

  it('rejects production environment when it points at the test database', () => {
    const env: Record<string, string | undefined> = {
      NODE_ENV: 'production',
      DATABASE_ENV: 'production',
      PROD_SUPABASE_URL: `https://${DEFAULT_TEST_SUPABASE_PROJECT_REF}.supabase.co`,
    };

    expect(() => createDatabaseConfig({ env })).toThrow('多个 project ref');
  });
});
