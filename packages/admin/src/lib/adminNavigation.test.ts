import { describe, expect, it } from 'vitest';
import { configMenuKey, resolveAdminMenuSelection } from './adminNavigation';

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

  it('opens the invite program page, which sits under 运营配置 but is not a managed config', () => {
    expect(resolveAdminMenuSelection('invite_program')).toEqual({
      view: 'invite_program',
    });
  });

  it('opens invite managed configs from the operations submenu', () => {
    expect(resolveAdminMenuSelection(configMenuKey('miniapp_invite_reward_rules'))).toEqual({
      view: 'configs',
      configKey: 'miniapp_invite_reward_rules',
    });
    expect(resolveAdminMenuSelection(configMenuKey('miniapp_invite_entry_enabled'))).toEqual({
      view: 'configs',
      configKey: 'miniapp_invite_entry_enabled',
    });
  });

  it('keeps independent top-level pages separate', () => {
    expect(resolveAdminMenuSelection('characters')).toEqual({ view: 'characters' });
    expect(resolveAdminMenuSelection('announcements')).toEqual({ view: 'announcements' });
    expect(resolveAdminMenuSelection('releases')).toEqual({ view: 'releases' });
  });
});
