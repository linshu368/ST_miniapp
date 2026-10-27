import { test, expect, expectMobileLayout } from './fixtures.js';

test('@roleplay @layout 浏览角色时栏目固定，进聊天后可返回', async ({ page, preview }) => {
  await page.goto('/');
  await expect(page.getByText('林间旅人', { exact: true }).first()).toBeVisible();
  const card = page.getByRole('button', { name: '查看 林间旅人 的详情', exact: true });
  await expect
    .poll(() => card.locator('img').evaluate((node) => (node as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
  const discover = page.getByRole('link', { name: '发现', exact: true });
  await page.evaluate(() => window.scrollTo(0, 700));
  await expect(discover).toBeInViewport();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.getByRole('button', { name: '查看 林间旅人 的详情', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: /继续对话|开始对话|开始聊天|接着聊/ }).click();
  await expect(page).toHaveURL(/\/chat\//);
  await expect(page.getByRole('textbox', { name: '输入消息' })).toBeVisible();
  await page.getByRole('button', { name: /返回发现/ }).click();
  await expect(page).toHaveURL(/3130\/$/);
  await expectMobileLayout(page);
  await preview.screenshot('角色浏览与返回');
});

test('@roleplay 空对话列表有清晰入口', async ({ page, preview }) => {
  await preview.scenario('empty');
  await page.goto('/chats');
  await expect(page.getByText(/还没有|暂无/).first()).toBeVisible();
  await expectMobileLayout(page);
});
