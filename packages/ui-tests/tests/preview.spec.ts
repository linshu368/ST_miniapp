import { previewAppUrl, previewApiUrl } from './fixtures';
import { test, expect, expectMobileLayout } from './fixtures.js';
import { IMAGE_PLAZA_INVALID_CURSOR } from '@miniapp/shared';

test('@image @layout 影像列表分页与媒体筛选保持独立游标，不请求视频清单', async ({
  page,
  preview,
}) => {
  await preview.scenario('image-masonry');
  const feeds: URL[] = [];
  const manifests: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/image-plaza/feed') feeds.push(url);
    if (url.pathname.endsWith('.m3u8')) manifests.push(url.pathname);
  });
  await page.goto('/create');
  await expect(page.getByRole('heading', { name: '影像广场', exact: true })).toBeVisible();
  const cards = page.locator('[data-image-work-id]');
  await expect(cards.first()).toBeVisible();
  await expect
    .poll(
      async () => {
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        return cards.count();
      },
      { timeout: 25_000 }
    )
    .toBe(60);
  const ids = await cards.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-image-work-id'))
  );
  expect(new Set(ids).size).toBe(60);
  expect(feeds.filter((url) => url.searchParams.has('cursor')).length).toBeGreaterThanOrEqual(2);
  await page
    .getByRole('group', { name: '媒体类型' })
    .getByRole('button', { name: '图片', exact: true })
    .click();
  await expect
    .poll(() =>
      cards.evaluateAll(
        (nodes) =>
          nodes.length > 0 &&
          nodes.every((node) => node.getAttribute('data-media-type') === 'image')
      )
    )
    .toBe(true);
  const sorted = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === '/api/image-plaza/feed' &&
      url.searchParams.get('sort') === 'latest' &&
      !url.searchParams.has('cursor')
    );
  });
  await page
    .getByRole('group', { name: '作品排序' })
    .getByRole('button', { name: '最新', exact: true })
    .click();
  expect((await sorted).ok()).toBe(true);
  await page
    .getByRole('group', { name: '媒体类型' })
    .getByRole('button', { name: '视频', exact: true })
    .click();
  await expect
    .poll(() =>
      cards.evaluateAll(
        (nodes) =>
          nodes.length > 0 &&
          nodes.every((node) => node.getAttribute('data-media-type') === 'video')
      )
    )
    .toBe(true);
  await expectMobileLayout(page);
  expect(manifests).toEqual([]);
});

test('@image 旧影像游标只恢复一次，重取首页后继续分页', async ({ page, preview }) => {
  await preview.scenario('image-masonry');
  let rejected = 0;
  let heads = 0;
  await page.route('**/api/image-plaza/feed?**', async (route) => {
    const url = new URL(route.request().url());
    if (!url.searchParams.has('cursor')) heads += 1;
    else if (rejected === 0) {
      rejected += 1;
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          success: false,
          error: { code: IMAGE_PLAZA_INVALID_CURSOR, message: 'fixture stale cursor' },
        }),
      });
      return;
    }
    await route.continue();
  });
  await page.goto('/create');
  const cards = page.locator('[data-image-work-id]');
  await expect(cards.first()).toBeVisible();
  await expect
    .poll(
      async () => {
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        return cards.count();
      },
      { timeout: 25_000 }
    )
    .toBe(60);
  expect(rejected).toBe(1);
  expect(heads).toBe(2);
});

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
