/**
 * @Author: whc 952987912@qq.com
 * @Date: 2026-09-23 14:57:53
 * @LastEditors: whc 952987912@qq.com
 * @LastEditTime: 2026-09-23 14:59:14
 * @Description:
 * @Copyright (c) 2026 by git config user.name, All Rights Reserved.
 */
import { describe, expect, it } from 'vitest';
import {
  configMenuKey,
  IMAGE_GENERATION_CONFIG_KEYS,
  INVITE_PROGRAM_CONFIG_KEYS,
  VIP_MEDIA_CONFIG_KEYS,
  VIP_STRATEGY_CONFIG_KEYS,
  resolveAdminMenuSelection,
  sidebarManagedConfigKeys,
} from './adminNavigation';

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

  it('routes invite managed configs to the invite program view tabs', () => {
    expect(resolveAdminMenuSelection(configMenuKey('miniapp_invite_reward_rules'))).toEqual({
      view: 'invite_program',
      configKey: 'miniapp_invite_reward_rules',
    });
    expect(resolveAdminMenuSelection(configMenuKey('miniapp_invite_center_config'))).toEqual({
      view: 'invite_program',
      configKey: 'miniapp_invite_center_config',
    });
    expect(resolveAdminMenuSelection(configMenuKey('miniapp_invite_entry_enabled'))).toEqual({
      view: 'invite_program',
      configKey: 'miniapp_invite_entry_enabled',
    });
  });

  it('hides invite managed configs from the sidebar config submenu', () => {
    for (const key of INVITE_PROGRAM_CONFIG_KEYS) {
      expect(sidebarManagedConfigKeys).not.toContain(key);
    }
    // 其余 config 目录不受影响
    expect(sidebarManagedConfigKeys).toContain('llm_model_catalog');
    expect(sidebarManagedConfigKeys).toContain('miniapp_payment_plans');
  });

  it('routes image generation configs to one grouped menu and hides duplicate entries', () => {
    for (const key of IMAGE_GENERATION_CONFIG_KEYS) {
      expect(resolveAdminMenuSelection(configMenuKey(key))).toEqual({
        view: 'image_generation_config',
        configKey: key,
      });
      expect(sidebarManagedConfigKeys).not.toContain(key);
    }
    expect(resolveAdminMenuSelection('image_generation_config')).toEqual({
      view: 'image_generation_config',
    });
  });

  it('routes VIP strategy configs to one tab and hides them from the generic list', () => {
    for (const key of VIP_STRATEGY_CONFIG_KEYS) {
      expect(resolveAdminMenuSelection(configMenuKey(key))).toEqual({
        view: 'vip_strategy',
        configKey: key,
      });
      expect(sidebarManagedConfigKeys).not.toContain(key);
    }
    expect(resolveAdminMenuSelection('vip_strategy')).toEqual({ view: 'vip_strategy' });
  });

  it('routes VIP media configs to one grouped menu and hides duplicate entries', () => {
    for (const key of VIP_MEDIA_CONFIG_KEYS) {
      expect(resolveAdminMenuSelection(configMenuKey(key))).toEqual({
        view: 'vip_media_config',
        configKey: key,
      });
      expect(sidebarManagedConfigKeys).not.toContain(key);
    }
    expect(resolveAdminMenuSelection('vip_media_config')).toEqual({
      view: 'vip_media_config',
    });
  });

  it('keeps independent top-level pages separate', () => {
    expect(resolveAdminMenuSelection('characters')).toEqual({ view: 'characters' });
    expect(resolveAdminMenuSelection('announcements')).toEqual({ view: 'announcements' });
    expect(resolveAdminMenuSelection('releases')).toEqual({ view: 'releases' });
  });
});
