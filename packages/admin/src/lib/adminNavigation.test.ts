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

  it('keeps independent top-level pages separate', () => {
    expect(resolveAdminMenuSelection('characters')).toEqual({ view: 'characters' });
    expect(resolveAdminMenuSelection('platform_presets')).toEqual({ view: 'platform_presets' });
    expect(resolveAdminMenuSelection('audit')).toEqual({ view: 'audit' });
  });

  it('opens analytics reports from the analytics submenu', () => {
    const key = analyticsMenuKey('models');
    expect(resolveAdminMenuSelection(key)).toEqual({
      view: 'analytics',
      analyticsKey: 'models',
    });
  });
});
