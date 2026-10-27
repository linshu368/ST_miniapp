import type { Page } from '@playwright/test';
import { test, expect, expectMobileLayout } from './fixtures.js';

test('@profile @layout 未开通会员：签到到账、两处引导及 VIP 跳转', async ({ page, preview }) => {
  await page.goto('/profile');
  const upgrade = page.getByRole('button', { name: '开通 VIP，立即恢复每天签到 150 星尘' });
  await expect(upgrade).toHaveCount(1);
  await expectProfileLayout(page);
  await preview.screenshot('个人中心未开通会员', { fullPage: false });
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
  await expect(
    page.getByRole('button', { name: '查看 VIP 权益与续费', exact: true })
  ).toBeVisible();
  await expectProfileLayout(page);
  await preview.screenshot('个人中心会员状态', { fullPage: false });
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

async function expectProfileLayout(page: Page) {
  const wallet = page.getByRole('region', { name: '我的星尘', exact: true });
  const daily = page.getByRole('region', { name: '每日签到', exact: true });
  const membership = page.getByRole('region', { name: 'VIP 会员权益', exact: true });
  const nav = page.getByRole('navigation', { name: '主导航', exact: true });
  const recharge = page.getByRole('link', { name: '前往星尘充值', exact: true });
  const checkin = page.getByRole('button', { name: '每日签到', exact: true });
  await expect(wallet.getByText('3,600', { exact: true })).toBeVisible();
  await expect(checkin).toBeEnabled();
  await expect(membership.getByRole('button')).toBeEnabled();
  await expect(nav.getByRole('link', { name: 'AI短剧', exact: true })).toBeVisible();
  await expectMobileLayout(page);

  const walletBox = await wallet.boundingBox();
  const dailyBox = await daily.boundingBox();
  const membershipBox = await membership.boundingBox();
  expect(walletBox).not.toBeNull();
  expect(dailyBox).not.toBeNull();
  expect(membershipBox).not.toBeNull();
  expect(walletBox!.y, '余额先于签到呈现').toBeLessThan(dailyBox!.y);
  expect(dailyBox!.y + dailyBox!.height, '会员区不应压住日常签到区').toBeLessThanOrEqual(
    membershipBox!.y + 1
  );

  // 保留真实触区检查：不依赖具体配色/圆角，窄屏也应无需瞄准且能滚到按钮。
  for (const action of [recharge, checkin, membership.getByRole('button')]) {
    await action.scrollIntoViewIfNeeded();
    await expect(action).toBeInViewport({ ratio: 0.95 });
    const hitArea = await action.evaluate((node) => {
      const box = node.getBoundingClientRect();
      const target = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return {
        width: box.width,
        height: box.height,
        reachable: Boolean(target && node.contains(target)),
      };
    });
    expect(hitArea.width).toBeGreaterThanOrEqual(44);
    expect(hitArea.height).toBeGreaterThanOrEqual(44);
    expect(hitArea.reachable, '主要操作不能被浮层或底栏挡住').toBe(true);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(recharge).toBeInViewport({ ratio: 0.95 });
  await expect(checkin).toBeInViewport({ ratio: 0.95 });
}
