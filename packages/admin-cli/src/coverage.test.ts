import { describe, expect, it } from 'vitest';
import { ADMIN_MENU_GROUPS, managedConfigKeys } from '@miniapp/admin-client';
import { COMMANDS } from './commands';
import { VIEW_CLI_COMMANDS } from './coverage';

describe('CLI 覆盖运营平台菜单', () => {
  it('每个专用页面登记的命令都真实存在', () => {
    const names = COMMANDS.map((command) => command.name);
    for (const group of ADMIN_MENU_GROUPS) {
      for (const item of group.items) {
        if (item.kind !== 'view') continue;
        for (const prefix of VIEW_CLI_COMMANDS[item.view]) {
          expect(
            names.some((name) => name === prefix || name.startsWith(`${prefix} `)),
            `${item.label} → ${prefix}`
          ).toBe(true);
        }
      }
    }
  });

  it('配置命令按注册表覆盖全部 managed config', () => {
    expect(managedConfigKeys.length).toBeGreaterThan(0);
    for (const name of ['config list', 'config get', 'config draft set', 'config publish']) {
      expect(COMMANDS.some((command) => command.name === name)).toBe(true);
    }
  });
});
