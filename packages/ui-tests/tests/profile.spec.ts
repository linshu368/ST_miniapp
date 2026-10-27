import { test, expect, expectMobileLayout } from './fixtures.js';

test('@profile @layout 未开通会员：签到到账、两处引导及 VIP 跳转', async ({ page, preview }) => {
  await page.goto('/profile');
  const upgrade = page.getByRole('button', { name: '开通 VIP，立即恢复每天签到 150 星尘' });
  await expect(upgrade).toHaveCount(1);
  await page.getByRole('button', { name: '每日签到', exact: true }).click();
  await expect(page.getByText('签到成功', { exact: true })).toBeVisible();
  await expect(upgrade).toHaveCount(2);
  expect((await preview.state()).wallet.credits).toBe(3630);
  await expectMobileLayout(page);
  await preview.screenshot('签到成功与会员引导');
  await upgrade.last().click();
  await expect(page).toHaveURL(/\/vip/);
  await expect(page.getByText('150星尘/天', { exact: true })).toBeVisible();
});

test('@profile @layout 已开通会员：每日150、会员身份与充值入口', async ({ page, preview }) => {
  await preview.scenario('vip');
  await page.goto('/profile');
  await expect(page.getByRole('button', { name: /开通 VIP，立即恢复/ })).toHaveCount(0);
  await page.getByRole('button', { name: '每日签到', exact: true }).click();
  await expect(page.getByText('签到成功', { exact: true })).toBeVisible();
  expect((await preview.state()).wallet.credits).toBe(3750);
  await page.getByRole('button', { name: '关闭签到提示' }).click();
  await expectMobileLayout(page);
  await page.getByRole('link', { name: '前往星尘充值' }).click();
  await expect(page).toHaveURL(/\/profile\/recharge/);
  await expect(page.getByRole('heading', { name: '充值星尘', exact: true })).toBeVisible();
  await preview.screenshot('会员充值页');
});

test('@profile 签到失败保留重试，余额不变', async ({ page, preview }) => {
  await preview.scenario('checkin-error');
  await page.goto('/profile');
  await page.getByRole('button', { name: '每日签到', exact: true }).click();
  await expect(page.getByText('签到未成功，请再试一次。')).toBeVisible();
  await expect(page.getByText('签到成功', { exact: true })).toHaveCount(0);
  expect((await preview.state()).wallet.credits).toBe(3600);
  await expect(page.getByRole('button', { name: '每日签到', exact: true })).toBeEnabled();
});

test('@profile 已签到不可重复领取；已领奖社群入口隐藏', async ({ page, preview }) => {
  await preview.scenario('checked');
  await page.goto('/profile');
  await expect(page.getByRole('button', { name: '每日签到', exact: true })).toBeDisabled();
  await preview.scenario('community-joined');
  await page.goto('/profile');
  await expect(page.getByText('每日签到', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /官方社群/ })).toHaveCount(0);
});
