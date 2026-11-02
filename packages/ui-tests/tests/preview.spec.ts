import { previewAppUrl, previewApiUrl } from './fixtures';
import { test, expect, expectMobileLayout } from './fixtures.js';

test('@preview @layout 场景入口可切换会员并打开真实页面', async ({ page, preview }) => {
  await page.goto(`${previewApiUrl}/`);
  await expect(page.getByRole('heading', { name: '移动端验收', exact: true })).toBeVisible();
  await expectMobileLayout(page);
  await preview.screenshot('固定场景入口');
  await page.getByRole('button', { name: /^已开通 VIP/ }).click();
  await expect(page).toHaveURL(`${previewAppUrl}/profile`);
  await expect(page.getByRole('button', { name: '查看 VIP 权益与续费' })).toBeVisible();
  const avatar = page.getByRole('img', { name: '预览体验官', exact: true });
  await expect(avatar).toBeVisible();
  await expect
    .poll(() => avatar.evaluate((node) => (node as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
  expect((await preview.state()).scenario).toBe('vip');
});
