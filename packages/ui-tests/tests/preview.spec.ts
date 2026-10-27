import { test, expect, expectMobileLayout } from './fixtures.js';

test('@preview @layout 场景入口可切换会员并打开真实页面', async ({ page, preview }) => {
  await page.goto('http://127.0.0.1:3131/');
  await expect(page.getByRole('heading', { name: '移动端验收', exact: true })).toBeVisible();
  await expectMobileLayout(page);
  await preview.screenshot('固定场景入口');
  await page.getByRole('button', { name: /^已开通 VIP/ }).click();
  await expect(page).toHaveURL('http://127.0.0.1:3130/profile');
  await expect(page.getByRole('button', { name: '查看 VIP 权益与续费' })).toBeVisible();
  const avatar = page.getByRole('img', { name: '预览体验官', exact: true });
  await expect(avatar).toBeVisible();
  await expect
    .poll(() => avatar.evaluate((node) => (node as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
  expect((await preview.state()).scenario).toBe('vip');
});
