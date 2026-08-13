import { describe, expect, it } from 'vitest';
import { analyticsMenuKey, configMenuKey, resolveAdminMenuSelection } from './adminNavigation';

describe('admin navigation', () => {
  it('opens a managed config from the operations submenu', () => {
    const key = configMenuKey('llm_model_catalog');
    expect(resolveAdminMenuSelection(key)).toEqual({
      view: 'configs',
      configKey: 'llm_model_catalog',
    });
  });

  it('opens the outreach grant page, which sits under 运营配置 but is not a managed config', () => {
    expect(resolveAdminMenuSelection('outreach_credit_grant')).toEqual({
      view: 'outreach_credit_grant',
    });
  });

  it('keeps independent top-level pages separate', () => {
    expect(resolveAdminMenuSelection('characters')).toEqual({ view: 'characters' });
    expect(resolveAdminMenuSelection('announcements')).toEqual({ view: 'announcements' });
    expect(resolveAdminMenuSelection('audit')).toEqual({ view: 'audit' });
  });

  it('drops removed platform presets menu into configs fallback', () => {
    expect(resolveAdminMenuSelection('platform_presets')).toEqual({ view: 'configs' });
  });

  it('opens analytics reports from the analytics submenu', () => {
    const key = analyticsMenuKey('models');
    expect(resolveAdminMenuSelection(key)).toEqual({
      view: 'analytics',
      analyticsKey: 'models',
    });
    expect(resolveAdminMenuSelection(analyticsMenuKey('spending'))).toEqual({
      view: 'analytics',
      analyticsKey: 'spending',
    });
  });
});
