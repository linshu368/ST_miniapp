import type { Page } from '@playwright/test';
import { test, expect, expectMobileLayout } from './fixtures.js';

test('@profile @wallet-spending @layout 视频预扣与原路退款分开显示且不改变余额', async ({
  page,
  preview,
}) => {
  await preview.scenario('spending-video');
  const before = (await preview.state()).wallet;
  await page.goto('/profile/spending');
  const debit = page
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name: '视频消费', exact: true }) });
  const refund = page
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name: '视频退款', exact: true }) });
  await expect(debit.getByText('-40.5', { exact: true })).toBeVisible();
  await expect(debit.getByText('已预扣', { exact: true })).toBeVisible();
  await expect(debit.getByText('通用 -10.0 · 专项 -30.5', { exact: true })).toBeVisible();
  await expect(refund.getByText('+40.5', { exact: true })).toBeVisible();
  await expect(refund.getByText('已原路退回', { exact: true })).toBeVisible();
  await expect(refund.getByText('通用 +10.0 · 专项 +30.5', { exact: true })).toBeVisible();
  await expect(page.getByRole('article')).toHaveCount(2);
  expect((await preview.state()).wallet).toEqual(before);
  await expectMobileLayout(page);
  await preview.screenshot('视频消费与退款明细');
});

test('@profile @layout 未开通会员：签到到账、两处引导及 VIP 跳转', async ({ page, preview }) => {
  await page.goto('/profile');
  await expect(page.getByText('每天 00:00 更新', { exact: true })).toBeVisible();
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

test('@profile @checkin-midnight 停留跨零点后刷新签到资格', async ({ page }) => {
  const nextClaim = Date.now() + 60_000;
  let reads = 0;
  await page.clock.install({ time: Date.now() });
  await page.route('**/api/wallet/checkin', async (route) => {
    reads += 1;
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: {
        ...body,
        data: {
          checkin: {
            ...body.data.checkin,
            can_claim: reads > 1,
            next_claim_at: new Date(nextClaim).toISOString(),
          },
        },
      },
    });
  });
  await page.goto('/profile');
  await expect(page.getByRole('button', { name: '每日签到', exact: true })).toBeDisabled();
  await page.clock.fastForward(61_000);
  await expect(page.getByRole('button', { name: '每日签到', exact: true })).toBeEnabled();
  expect(reads).toBe(2);
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

test('@profile @theme @layout 昼夜一点即切、重开仍在、首帧不闪，剧场始终深色', async ({
  page,
  preview,
}) => {
  const root = page.locator('html');
  const theme = () => root.evaluate((node) => getComputedStyle(node.ownerDocument.body).color);
  await page.goto('/profile');
  const toDay = page.getByRole('button', { name: '切换到白天', exact: true });
  await expect(toDay).toBeVisible();
  await expect(root).toHaveClass(/dark/);
  const nightInk = await theme();
  const hit = await toDay.boundingBox();
  expect(Math.min(hit!.width, hit!.height)).toBeGreaterThanOrEqual(44);

  await toDay.tap();
  await expect(page.getByRole('button', { name: '切换到夜间', exact: true })).toBeVisible();
  await expect(root).not.toHaveClass(/dark/);
  expect(await theme()).not.toBe(nightInk);
  await expectMobileLayout(page);
  await preview.screenshot('我的-白天');

  // 冷启动：最早的几帧就必须已经是白天。
  await page.addInitScript(() => {
    const frames: boolean[] = [];
    Object.assign(window, { __themeFrames: frames });
    const record = () => {
      if (document.body) frames.push(document.documentElement.classList.contains('dark'));
      if (frames.length < 8) requestAnimationFrame(record);
    };
    requestAnimationFrame(record);
  });
  await page.goto('/characters');
  await expect(page.getByRole('link', { name: '我的', exact: true })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => (window as never as { __themeFrames: boolean[] }).__themeFrames)
    )
    .toEqual(Array(8).fill(false));
  await preview.screenshot('角色-白天', { fullPage: false });

  await page.getByRole('link', { name: '剧场', exact: true }).click();
  await expect(page).toHaveURL(/\/dramas$/);
  await expect(root).toHaveClass(/dark/);
  await page.getByRole('link', { name: '我的', exact: true }).click();
  await expect(page.getByRole('button', { name: '切换到夜间', exact: true })).toBeVisible();
  await expect(root).not.toHaveClass(/dark/);

  await page.getByRole('button', { name: '切换到夜间', exact: true }).tap();
  await expect(root).toHaveClass(/dark/);
  expect(await theme()).toBe(nightInk);
});

test('@profile @theme 存储不可用时仍能切换，只是不记住', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw new Error('blocked');
      },
    });
  });
  await page.goto('/profile');
  await page.getByRole('button', { name: '切换到白天', exact: true }).tap();
  await expect(page.locator('html')).not.toHaveClass(/dark/);
});

test('@profile @messages @layout 消息中心：分类红点、全部已读、更早整组收起、返回保留分类与展开', async ({
  page,
  preview,
}) => {
  await preview.scenario('messages');
  await page.goto('/profile/messages');
  const official = page.getByRole('tab', { name: '官方', exact: true });
  const personal = page.getByRole('tab', { name: '消息', exact: true });
  await expect(official).toHaveAttribute('data-unread', 'true');
  await expect(personal).toHaveAttribute('data-unread', 'true');
  await expect(page.getByRole('heading', { name: '本周版本更新' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '服务异常说明' })).toHaveCount(0);
  const older = page.getByRole('button', { name: '更早的 3 条' });
  await expect(older).toBeVisible();
  await expectMobileLayout(page);
  await preview.screenshot('消息中心官方分类');

  await page.getByRole('button', { name: '全部已读' }).click();
  await expect(official).toHaveAttribute('data-unread', 'false');
  await expect(page.getByRole('button', { name: '全部已读' })).toHaveCount(0);
  await expect(page.getByLabel('未读', { exact: true })).toHaveCount(0);
  await expect(personal).toHaveAttribute('data-unread', 'true');

  await older.click();
  await expect(page.getByRole('heading', { name: '服务异常说明' })).toBeVisible();
  await expect(page.getByLabel('未读', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '收起' })).toBeVisible();
  await preview.screenshot('消息中心全部已读并展开更早');

  await personal.click();
  await page.getByRole('heading', { name: '星尘充值到账' }).first().click();
  await expect(page).toHaveURL(/\/profile\/messages\/9/);
  await page.getByRole('button', { name: '返回' }).click();
  await expect(personal).toHaveAttribute('aria-selected', 'true');
  await expect(personal).toHaveAttribute('data-unread', 'false');
  await official.click();
  await expect(page.getByRole('heading', { name: '服务异常说明' })).toBeVisible();
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
  // 大数字只显示通用星尘，专项单独一行（不再显示合计）
  await expect(wallet.getByText('3,000', { exact: true })).toBeVisible();
  await expect(wallet.getByText('600', { exact: true })).toBeVisible();
  await expect(checkin).toBeEnabled();
  await expect(membership.getByRole('button')).toBeEnabled();
  await expect(nav.getByRole('link', { name: '剧场', exact: true })).toBeVisible();
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

test('@profile @recharge @layout 充值套餐与到账确认：明确选择、固定付款栏和服务入口', async ({
  page,
  preview,
}) => {
  await preview.scenario('recharge');
  await page.goto('/profile/recharge');
  const plans = page.getByRole('radiogroup', { name: '选择星尘充值套餐' });
  const cards = plans.getByRole('radio');
  const checkout = page.getByLabel('充值确认');
  await expect(cards).toHaveCount(4);
  await expect(cards.first().getByText(/^省 ¥/)).toHaveCount(0);
  for (const [index, total, bonus, saved] of [
    [1, '21,600', '3,600', '6'],
    [2, '51,000', '10,200', '20'],
    [3, '104,000', '27,200', '40'],
  ] as const) {
    const card = cards.nth(index);
    await expect(card.getByText(total, { exact: true })).toBeVisible();
    await expect(card.getByText(bonus, { exact: true })).toBeVisible();
    await expect(card.getByText(`省 ¥${saved}`, { exact: true })).toBeVisible();
    const size = await card.evaluate((element) => ({
      width: element.clientWidth,
      content: element.scrollWidth,
    }));
    expect(size.content, '到账和赠送数量不可横向裁切').toBeLessThanOrEqual(size.width);
  }
  const creditSize = await cards
    .nth(1)
    .getByText('21,600', { exact: true })
    .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const priceSize = await cards
    .nth(1)
    .getByText('¥30', { exact: true })
    .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(creditSize, '到账星尘应明显大于实付价格').toBeGreaterThanOrEqual(priceSize * 2);
  await expect(plans.getByRole('radio', { checked: true })).toHaveCount(0);
  await expect(checkout.getByRole('button', { name: '请选择套餐' })).toBeDisabled();
  await expect(page.getByRole('radiogroup', { name: '支付方式' }).getByRole('radio')).toHaveCount(
    1
  );
  await expect(page.getByRole('radio', { name: '支付宝' })).toBeChecked();
  await cards.nth(1).click();
  await expect(cards.nth(1)).toBeChecked();
  await expect(checkout.getByText('21,600', { exact: true })).toBeVisible();
  await expect(checkout.getByText('含赠送 3,600 星尘')).toBeVisible();
  const pay = checkout.getByRole('button', { name: '立即支付 ¥30', exact: true });
  await expect(pay).toBeEnabled();
  await expect(pay).toHaveCSS('background-color', 'rgb(234, 215, 188)');
  await expect(pay).toBeInViewport({ ratio: 1 });
  const first = await cards.first().boundingBox();
  const second = await cards.nth(1).boundingBox();
  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
  expect(Math.abs(first!.y - second!.y)).toBeLessThan(1);
  expect(first!.width).toBeCloseTo(second!.width, 0);
  await expectMobileLayout(page);
  await preview.screenshot('充值页-套餐与到账确认', { fullPage: false });
  await page.getByText('星尘和 VIP 有什么区别？', { exact: true }).click();
  await expect(page.getByText(/本次只购买你选择的星尘套餐/)).toBeVisible();
  const help = page.getByRole('link', { name: '充值遇到问题？联系客服' });
  await help.scrollIntoViewIfNeeded();
  const helpBox = await help.boundingBox();
  const footerBox = await checkout.boundingBox();
  expect(helpBox!.y + helpBox!.height).toBeLessThanOrEqual(footerBox!.y + 1);
  await expect(pay).toBeInViewport({ ratio: 1 });
  await preview.screenshot('充值页-会员与帮助', { fullPage: false });
  await help.click();
  await expect(page).toHaveURL(/\/profile\/support/);
});

test('@profile @recharge 下单失败保留选择和金额，VIP入口保留原回流地址', async ({
  page,
  preview,
}) => {
  await preview.scenario('recharge');
  const returnTo = '/characters?tab=conversations';
  await page.goto(`/profile/recharge?${new URLSearchParams({ returnTo })}`);
  await page
    .getByRole('radiogroup', { name: '选择星尘充值套餐' })
    .getByRole('radio')
    .nth(1)
    .click();
  const request = page.waitForRequest(
    (req) => req.method() === 'POST' && new URL(req.url()).pathname === '/api/payment/orders'
  );
  await page.getByRole('button', { name: '立即支付 ¥30', exact: true }).click();
  expect((await request).postDataJSON()).toEqual({
    plan_id: 'preview-credits-30',
    payment_type: 'alipay',
  });
  await expect(page.getByLabel('充值确认').getByRole('alert')).toHaveText(
    '订单没创建成功，再试一次吧。'
  );
  await expect(page.getByRole('button', { name: '立即支付 ¥30', exact: true })).toBeEnabled();
  await expect(page.getByLabel('充值确认').getByText('21,600', { exact: true })).toBeVisible();
  expect((await preview.state()).wallet.credits).toBe(3600);
  await page.getByRole('button', { name: '开通 VIP，查看月卡权益' }).click();
  await expect(page).toHaveURL(/\/vip\?/);
  const rechargeReturn = new URL(page.url()).searchParams.get('returnTo');
  expect(rechargeReturn).toBe(`/profile/recharge?${new URLSearchParams({ returnTo })}`);
  await expect(page.getByText('150星尘/天', { exact: true })).toBeVisible();
});

test('@profile @recharge @layout 充值空态、失败和渠道关闭不会误下单，单套餐完整排版', async ({
  page,
  preview,
}) => {
  await preview.scenario('recharge-error');
  await page.goto('/profile/recharge');
  await expect(page.getByText('充值套餐没加载出来，再试一次吧')).toBeVisible();
  await expect(page.getByRole('button', { name: '重新加载', exact: true })).toBeVisible();
  await expect(page.getByLabel('充值确认').getByRole('button')).toBeDisabled();
  await expect(page.getByRole('link', { name: '订单', exact: true })).toBeVisible();
  await expectMobileLayout(page);
  await preview.scenario('recharge-empty');
  await page.goto('/profile/recharge');
  await expect(page.getByText('充值套餐暂未开放，请稍后再来')).toBeVisible();
  await expect(page.getByLabel('充值确认').getByRole('button')).toBeDisabled();
  await preview.scenario('recharge-unavailable');
  await page.goto('/profile/recharge');
  await page
    .getByRole('radiogroup', { name: '选择星尘充值套餐' })
    .getByRole('radio')
    .first()
    .click();
  await expect(page.getByText('暂时用不了，稍后再试')).toBeVisible();
  await expect(page.getByRole('button', { name: '立即支付 ¥10', exact: true })).toBeDisabled();
  expect(
    (await preview.state()).requests.filter(
      (r) => r.method === 'POST' && r.path === '/api/payment/orders'
    )
  ).toHaveLength(0);
  await preview.scenario('vip');
  await page.goto('/profile/recharge');
  const group = page.getByRole('radiogroup', { name: '选择星尘充值套餐' });
  await expect(group.getByRole('radio')).toHaveCount(1);
  const cardBox = await group.getByRole('radio').boundingBox();
  const groupBox = await group.boundingBox();
  expect(cardBox!.width).toBeCloseTo(groupBox!.width, 0);
  await expect(page.getByRole('button', { name: '查看 VIP 权益与续费' })).toBeVisible();
  await expect(page.getByText('每次对话，已享 7折 优惠')).toBeVisible();
  await expectMobileLayout(page);
  await preview.screenshot('充值页-会员与单套餐', { fullPage: false });
});

test('@profile @vip-mixed @layout 混合签到与月卡显示两种星尘', async ({ page, preview }) => {
  await preview.scenario('vip-mixed');
  await page.goto('/profile');
  await expect(page.getByText('120 专项＋30 通用星尘').first()).toBeVisible();
  await page.getByRole('button', { name: '每日签到', exact: true }).click();
  await expect(page.getByText('通用星尘 +30', { exact: true })).toBeVisible();
  await expect(page.getByText('专项星尘 +120', { exact: true })).toBeVisible();
  const state = await preview.state();
  expect(state.wallet.main_credits).toBe(3030);
  expect(state.wallet.bonus_credits).toBe(720);
  expect(state.wallet.credits).toBe(3750);
  await expectMobileLayout(page);
  await preview.screenshot('混合签到到账');
  await page.getByRole('button', { name: '关闭签到提示' }).click();
  await page.getByRole('button', { name: '查看 VIP 权益与续费' }).click();
  await expect(page.getByText('2,000 专项＋1,000 通用星尘').first()).toBeVisible();
  await expectMobileLayout(page);
  await preview.screenshot('混合会员权益');
});
