/**
 * @Author: whc 952987912@qq.com
 * @Date: 2026-09-23 14:57:53
 * @LastEditors: whc 952987912@qq.com
 * @LastEditTime: 2026-09-28 16:52:45
 * @Description:
 * @Copyright (c) 2026 by git config user.name, All Rights Reserved.
 */
import { describe, expect, it } from 'vitest';
import { CREATOR_REVIEW_PROMPT_KEY } from '@miniapp/shared';
import {
  configMenuKey,
  IMAGE_GENERATION_CONFIG_KEYS,
  INVITE_PROGRAM_CONFIG_KEYS,
  PLATFORM_INSTRUCTION_CONFIG_KEYS,
  VIP_STRATEGY_CONFIG_KEYS,
  resolveAdminMenuSelection,
  ADMIN_MENU,
  adminMenuLeafKeys,
  menuGroupKeyFor,
} from './adminNavigation';
import { managedConfigKeys } from '@miniapp/admin-client';

describe('admin navigation', () => {
  it('opens a managed config from the operations submenu', () => {
    const key = configMenuKey('llm_model_catalog');
    expect(resolveAdminMenuSelection(key)).toEqual({
      view: 'configs',
      configKey: 'llm_model_catalog',
    });
  });

  it('opens the fallback screen against the existing model catalog draft', () => {
    expect(resolveAdminMenuSelection('fallback_config')).toEqual({
      view: 'fallback_config',
      configKey: 'llm_model_catalog',
    });
  });
  it('no longer routes the retired outreach grant page', () => {
    expect(resolveAdminMenuSelection('outreach_credit_grant')).toEqual({ view: 'configs' });
    expect(adminMenuLeafKeys()).not.toContain('outreach_credit_grant');
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

  it('shows invite configs only through the invite program page', () => {
    for (const key of INVITE_PROGRAM_CONFIG_KEYS) {
      expect(adminMenuLeafKeys()).not.toContain(configMenuKey(key));
    }
    expect(adminMenuLeafKeys()).toContain('invite_program');
    expect(adminMenuLeafKeys()).toContain(configMenuKey('llm_model_catalog'));
    expect(adminMenuLeafKeys()).toContain(configMenuKey('miniapp_payment_plans'));
  });

  it('routes image generation configs to one grouped menu and hides duplicate entries', () => {
    for (const key of IMAGE_GENERATION_CONFIG_KEYS) {
      expect(resolveAdminMenuSelection(configMenuKey(key))).toEqual({
        view: 'image_generation_config',
        configKey: key,
      });
      expect(adminMenuLeafKeys()).not.toContain(configMenuKey(key));
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
      expect(adminMenuLeafKeys()).not.toContain(configMenuKey(key));
    }
    expect(resolveAdminMenuSelection('vip_strategy')).toEqual({ view: 'vip_strategy' });
  });

  it('routes the four platform-rule areas to one workspace and hides duplicate entries', () => {
    for (const key of PLATFORM_INSTRUCTION_CONFIG_KEYS) {
      expect(resolveAdminMenuSelection(configMenuKey(key))).toEqual({
        view: 'platform_instructions',
        configKey: key,
      });
      expect(adminMenuLeafKeys()).not.toContain(configMenuKey(key));
    }
    expect(resolveAdminMenuSelection('platform_instructions')).toEqual({
      view: 'platform_instructions',
    });
  });

  it('groups the sidebar into the agreed sections with release history last', () => {
    expect(ADMIN_MENU.map((node) => node.label)).toEqual([
      '模型与计费',
      '对话与回复',
      '角色与大厅',
      '充值与会员',
      '用户增长',
      '图片',
      '发布历史',
    ]);
    expect(menuGroupKeyFor('vip_strategy')).toBe('group:monetization');
    expect(menuGroupKeyFor(configMenuKey(CREATOR_REVIEW_PROMPT_KEY))).toBe('group:characters');
  });

  it('gives every managed config exactly one reachable entry', () => {
    const leaves = adminMenuLeafKeys();
    expect(new Set(leaves).size).toBe(leaves.length);
    for (const key of managedConfigKeys) {
      const selection = resolveAdminMenuSelection(configMenuKey(key));
      const entry = selection.view === 'configs' ? configMenuKey(key) : selection.view;
      expect(leaves, key).toContain(entry);
    }
  });

  it('keeps independent top-level pages separate', () => {
    expect(resolveAdminMenuSelection('characters')).toEqual({ view: 'characters' });
    expect(resolveAdminMenuSelection('announcements')).toEqual({ view: 'announcements' });
    expect(resolveAdminMenuSelection('releases')).toEqual({ view: 'releases' });
    expect(resolveAdminMenuSelection('text_postprocess')).toEqual({ view: 'text_postprocess' });
  });
});

describe('reply style options navigation', () => {
  it('uses an independent page under platform rules without duplicate generic entries', () => {
    const expected = { view: 'reply_style_options', configKey: 'reply_style_options' };
    expect(resolveAdminMenuSelection('reply_style_options')).toEqual(expected);
    expect(resolveAdminMenuSelection(configMenuKey('reply_style_options'))).toEqual(expected);
    expect(adminMenuLeafKeys()).not.toContain(configMenuKey('reply_style_options'));
    expect(adminMenuLeafKeys()).toContain('reply_style_options');
    expect(PLATFORM_INSTRUCTION_CONFIG_KEYS).toEqual([
      'choice_rules',
      'status_rules',
      'memory_rules',
      'system_instructions',
    ]);
  });
});

describe('creator review prompt navigation', () => {
  it('does not resolve the retired human review view', () => {
    expect(resolveAdminMenuSelection('creator_characters')).toEqual({ view: 'configs' });
  });
  it('keeps the AI prompt editor routed under 角色与大厅 without a roleplay tab', () => {
    expect(resolveAdminMenuSelection(configMenuKey(CREATOR_REVIEW_PROMPT_KEY))).toEqual({
      view: 'configs',
      configKey: CREATOR_REVIEW_PROMPT_KEY,
    });
    expect(
      adminMenuLeafKeys().filter((key) => key === configMenuKey(CREATOR_REVIEW_PROMPT_KEY))
    ).toHaveLength(1);
    expect(PLATFORM_INSTRUCTION_CONFIG_KEYS).not.toContain(CREATOR_REVIEW_PROMPT_KEY);
  });
});
