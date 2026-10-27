import { test, expect, chatPath, sendChat, expectMobileLayout } from './fixtures.js';

test('@chat @layout 深度思考默认开启，正文出现后自动折叠', async ({ page, preview }) => {
  await preview.scenario('chat-slow');
  await page.goto(chatPath);
  await expect(page.getByRole('button', { name: '关闭深度思考', exact: true })).toBeVisible();
  await sendChat(page);
  await expect(page.getByLabel('思考内容', { exact: true })).toBeVisible();
  await expect(
    page.getByText('「那就出发吧。」旅人轻轻合上地图，把下一步的选择留给你。', { exact: true })
  ).toBeVisible();
  await expect(page.getByLabel('思考内容', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'thinking' }).click();
  await expect(page.getByLabel('思考内容', { exact: true })).toBeVisible();
  await expectMobileLayout(page);
  await preview.screenshot('思考折叠与正文');
  expect(
    (await preview.state()).requests.find((item) => item.path.endsWith('/messages'))
      ?.thinking_enabled
  ).toBe(true);
});

test('@chat 关闭思考后发送 false，正常展示正文', async ({ page, preview }) => {
  await page.goto(chatPath);
  await page.getByRole('button', { name: '关闭深度思考', exact: true }).click();
  await sendChat(page);
  await expect(
    page.getByText('「那就出发吧。」旅人轻轻合上地图，把下一步的选择留给你。', { exact: true })
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'thinking' })).toHaveCount(0);
  expect(
    (await preview.state()).requests.find((item) => item.path.endsWith('/messages'))
      ?.thinking_enabled
  ).toBe(false);
});

test('@chat @layout 多行输入与回复偏好可操作，多个风格独立开关', async ({ page, preview }) => {
  await page.goto(chatPath);
  await page
    .getByRole('textbox', { name: '输入消息' })
    .fill(Array(8).fill('这是一行较长的移动端输入内容。').join('\n'));
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeInViewport();
  await page.getByRole('button', { name: /回复偏好/ }).click();
  await expect(page.getByText('回复长度', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '详细', exact: true }).click();
  const dialogue = page.getByRole('switch', { name: '角色多说话', exact: true });
  const concise = page.getByRole('switch', { name: '节奏紧凑', exact: true });
  await dialogue.click();
  await concise.click();
  await expect(dialogue).toBeChecked();
  await expect(concise).toBeChecked();
  await dialogue.click();
  await expect(dialogue).not.toBeChecked();
  await expect(concise).toBeChecked();
  await expectMobileLayout(page);
  await preview.screenshot('多行输入与回复偏好');
});

test('@chat 余额不足显示补充入口，不产生回复', async ({ page, preview }) => {
  await preview.scenario('no-balance');
  await page.goto(chatPath);
  await sendChat(page);
  await expect(page.getByText(/星尘.*不足/).first()).toBeVisible();
  expect((await preview.state()).wallet.credits).toBe(0);
});
