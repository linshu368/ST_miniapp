import { test, expect, studioPath, expectMobileLayout } from './fixtures.js';

test('@image @layout 广场用同款进入工作室，设置与模拟生成结果', async ({ page, preview }) => {
  await page.goto('/create');
  await page.getByRole('button', { name: '用同款：薄雾中的山谷', exact: true }).click();
  await expect(page).toHaveURL(/\/create\/studio\//);
  const prompt = page.getByPlaceholder('描述你想生成的画面…');
  await expect(prompt).not.toBeEmpty();
  await page.getByRole('button', { name: '打开生成设置' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await prompt.fill('清晨薄雾中的山谷，一束阳光穿过树叶。');
  await page.getByRole('button', { name: '发送生成' }).click();
  await expect(page.getByText('正在生成…', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /保存/ }).first()).toBeVisible({ timeout: 15_000 });
  expect((await preview.state()).wallet.credits).toBe(3580);
  await expect
    .poll(() =>
      page
        .getByRole('img', { name: '生成结果', exact: true })
        .evaluate((node) => (node as HTMLImageElement).naturalWidth)
    )
    .toBeGreaterThan(0);
  await page.getByRole('button', { name: '保存图片', exact: true }).first().click();
  await expect(page.getByRole('link', { name: '打开原图保存' })).toBeVisible();
  await expectMobileLayout(page);
  await preview.screenshot('模拟生成完成');
});

test('@image 图片失败保留重试，模拟余额不减少', async ({ page, preview }) => {
  await preview.scenario('image-error');
  await page.goto(studioPath);
  await page.getByPlaceholder('描述你想生成的画面…').fill('安静的湖边森林');
  await page.getByRole('button', { name: '发送生成' }).click();
  await expect(page.getByText('生成失败，未消耗星尘')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: '按当前设置再生成' })).toBeVisible();
  expect((await preview.state()).wallet.credits).toBe(3600);
});

test('@image @layout 多行描述时设置、生成按钮可见', async ({ page }) => {
  await page.goto(studioPath);
  await page
    .getByPlaceholder('描述你想生成的画面…')
    .fill(Array(8).fill('描述树林、晨光和远方的山谷。').join('\n'));
  await expect(page.getByRole('button', { name: '打开生成设置' })).toBeInViewport();
  await expect(page.getByRole('button', { name: '发送生成' })).toBeInViewport();
  await expectMobileLayout(page);
});
