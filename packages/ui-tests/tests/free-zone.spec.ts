import { test, expect, chatPath, expectMobileLayout } from './fixtures.js';

/** 畅聊（免费模型）栏目：真实页面消费虚构的栏目状态；不连接 Surplus，也不证明真实计费。 */

test('@chat @free-zone @layout 开放时可选免费模型，顶栏换成畅聊引擎', async ({ page, preview }) => {
  await preview.scenario('free-zone');
  await page.goto(chatPath);
  await expect(page.getByText('畅聊中', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /展开引擎选择/ }).click();

  const zone = page.locator('[data-free-zone="open"]');
  await expect(zone.getByText('免费畅聊', { exact: true })).toBeVisible();
  await expect(zone.getByText(/结束$/)).toBeVisible();
  await expect(zone.getByText('55 星尘', { exact: true })).toBeVisible();

  const selected = page.waitForResponse(
    (response) => response.url().endsWith('/api/v1/models/select') && response.status() === 200
  );
  await zone.getByRole('button', { name: /DeepSeek V4 Pro/ }).click();
  await selected;
  await expect(page.getByRole('button', { name: /当前畅聊引擎/ })).toBeVisible();
  await expect(page.getByText('畅聊中', { exact: true })).toHaveCount(0);
  await expectMobileLayout(page);
});

test('@chat @free-zone @layout 未开始时默认折叠，点模型只提示不发请求', async ({
  page,
  preview,
}) => {
  await preview.scenario('free-zone-not-started');
  await page.goto(chatPath);
  await expect(page.getByText('畅聊中', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: /展开引擎选择/ }).click();

  const zone = page.locator('[data-free-zone="not_started"]');
  await expect(zone.getByText(/开始$/)).toBeVisible();
  await expect(zone.getByRole('button', { name: /GLM 5.2 fast/ })).toHaveCount(0);
  await zone.getByRole('button', { name: /免费畅聊/ }).click();

  let selectCalls = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/api/v1/models/select')) selectCalls += 1;
  });
  await zone.getByRole('button', { name: /GLM 5.2 fast/ }).click();
  await expect(page.getByText(/畅聊模型还没开放/)).toBeVisible();
  expect(selectCalls).toBe(0);
  await expectMobileLayout(page);
});

test('@chat @free-zone 仅限自创卡时在别人的卡上显示原因', async ({ page, preview }) => {
  await preview.scenario('free-zone-own-card');
  await page.goto(chatPath);
  await page.getByRole('button', { name: /展开引擎选择/ }).click();
  await expect(
    page.locator('[data-free-zone="own_card_only"]').getByText('仅限自创角色卡')
  ).toBeVisible();
});

test('@chat @free-zone 下架后已换成同系列模型，不弹任何提示', async ({ page, preview }) => {
  await preview.scenario('free-zone-replaced');
  await page.goto(chatPath);
  await expect(page.getByRole('button', { name: /当前畅聊引擎/ })).toBeVisible();
  await page.getByRole('button', { name: /展开引擎选择/ }).click();
  await expect(page.getByText('GLM 5.2 fast', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/已为你换成|暂时下架/)).toHaveCount(0);
});

test('@chat @free-zone 后端不下发栏目时面板和顶栏保持原样', async ({ page, preview }) => {
  await preview.scenario('standard');
  await page.goto(chatPath);
  await expect(page.getByText('畅聊中', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: /展开引擎选择/ }).click();
  await expect(page.getByText('免费畅聊', { exact: true })).toHaveCount(0);
});
