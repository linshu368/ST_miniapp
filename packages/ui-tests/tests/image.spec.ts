import { test, expect, IDS, studioPath, expectMobileLayout } from './fixtures.js';

test('@image @layout 标签横滑不带走固定筛选，底部面板按分组切换', async ({ page, preview }) => {
  await page.goto('/create');
  const scroll = page.locator('[data-image-plaza-tags-scroll]');
  const trigger = page.locator('[data-image-plaza-filter-trigger]');
  await expect(scroll).toBeVisible();
  await expect(trigger).toBeInViewport();
  const before = await trigger.boundingBox();
  await scroll.evaluate((node) => {
    node.scrollLeft = node.scrollWidth;
  });
  const after = await trigger.boundingBox();
  expect(Math.abs((after?.x ?? 0) - (before?.x ?? 0))).toBeLessThan(1);

  await trigger.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: '风格' })).toBeVisible();
  await expect(dialog.getByRole('heading', { name: '场景' })).toBeVisible();
  await expect(dialog.getByRole('heading', { name: '模型' })).toBeVisible();
  const outdoor = dialog.getByRole('button', { name: /户外/ });
  await expect(outdoor).toHaveAttribute('aria-pressed', 'true');
  await outdoor.click();
  await expect(outdoor).toHaveAttribute('aria-pressed', 'false');
  await dialog.getByRole('button', { name: '全部展示' }).click();
  await expect(outdoor).toHaveAttribute('aria-pressed', 'true');
  await expectMobileLayout(page);
  await preview.screenshot('标签分组筛选');
});

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
  await page.getByRole('button', { name: '用这张图生成视频', exact: true }).first().click();
  await expect(page.getByPlaceholder('描述你想生成的视频…')).toBeVisible();
  await expect(page.getByRole('button', { name: '视频', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await expect(page.getByText('已添加首帧图', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: '打开生成设置' }).click();
  const videoSettings = page.getByRole('dialog');
  await expect(videoSettings.getByText('时长', { exact: true })).toBeVisible();
  await expect(videoSettings.getByText('画面比例', { exact: true })).toBeVisible();
  await expect(videoSettings.getByText('清晰度', { exact: true })).toBeVisible();
  await expect(videoSettings.getByText('生成声音', { exact: true })).toBeVisible();
  await expect(videoSettings.getByRole('button', { name: '5 秒' })).toBeVisible();
  await expect(videoSettings.getByRole('button', { name: '10 秒' })).toBeVisible();
  await videoSettings.getByRole('button', { name: '关闭' }).click();

  await page.getByRole('button', { name: /选择视频模型，当前为 Wan 3.0 Pro/ }).click();
  await page.getByRole('button', { name: /纯文本视频/ }).click();
  await expect(page.getByText('参考图已保留，当前模型不使用', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '添加参考图' })).toBeDisabled();

  await page.getByRole('button', { name: /选择视频模型，当前为 纯文本视频/ }).click();
  await page.getByRole('button', { name: /Wan 3.0 Pro/ }).click();
  await expect(page.getByText('已添加首帧图', { exact: true })).toBeVisible();
  await page.getByPlaceholder('描述你想生成的视频…').fill('林间薄雾缓缓流动。');
  await page.getByRole('button', { name: '发送生成' }).click();
  await expect(page.getByRole('button', { name: '编辑', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '重新生成', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '下载', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '分享', exact: true })).toBeVisible();
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

test('@image 视频详情用同款默认进入视频创作', async ({ page }) => {
  await page.goto(`/create/work/${IDS.videoWork}`);
  await page.getByRole('button', { name: '用同款', exact: true }).click();
  await expect(page).toHaveURL(/\/create\/studio\//);
  await expect(page.getByRole('button', { name: '视频', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await expect(page.getByPlaceholder('描述你想生成的视频…')).toHaveValue(
    'A gentle breeze moves through a quiet forest'
  );
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
