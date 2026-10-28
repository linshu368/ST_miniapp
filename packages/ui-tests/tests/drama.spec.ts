import type { Locator, Page } from '@playwright/test';
import type { GetDramaPlaybackData } from '@miniapp/shared';
import { test, expect, expectMobileLayout } from './fixtures.js';

const firstDrama = '60000000-0000-4000-8000-000000000001';
const firstVideo = '70000000-0000-4000-8000-000000000001';
const secondDrama = '60000000-0000-4000-8000-000000000002';
const longDrama = '60000000-0000-4000-8000-000000000012';
const tabs = (page: Page) => page.getByRole('navigation', { name: '短剧栏目' });
const mainNav = (page: Page) => page.getByRole('navigation', { name: '主导航' });

test('@drama 移除独立 CDN 实验入口', async ({ page, preview }) => {
  await preview.scenario('dramas');
  const response = await page.goto('/drama-cdn-experiment');
  expect(response?.status()).toBe(404);
});

async function pauseReadyVideo(page: Page) {
  const video = page.locator('video');
  await expect(video).toHaveCount(1);
  await expect
    .poll(() => video.evaluate((node) => (node as HTMLVideoElement).readyState))
    .toBeGreaterThanOrEqual(2);
  await video.evaluate((node) => (node as HTMLVideoElement).pause());
  return video;
}

async function swipe(target: Locator, from: [number, number], to: [number, number]) {
  return target.evaluate(
    (node, { from, to }) => {
      const touch = (point: [number, number]) =>
        new Touch({ identifier: 1, target: node, clientX: point[0], clientY: point[1] });
      node.dispatchEvent(
        new TouchEvent('touchstart', {
          bubbles: true,
          cancelable: true,
          touches: [touch(from)],
          targetTouches: [touch(from)],
          changedTouches: [touch(from)],
        })
      );
      const defaultAllowed = node.dispatchEvent(
        new TouchEvent('touchmove', {
          bubbles: true,
          cancelable: true,
          touches: [touch(to)],
          targetTouches: [touch(to)],
          changedTouches: [touch(to)],
        })
      );
      node.dispatchEvent(
        new TouchEvent('touchend', {
          bubbles: true,
          cancelable: true,
          touches: [],
          targetTouches: [],
          changedTouches: [touch(to)],
        })
      );
      return { prevented: !defaultAllowed };
    },
    { from, to }
  );
}

async function touchPhase(
  target: Locator,
  type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel',
  point: [number, number],
  second?: [number, number]
) {
  return target.evaluate(
    (node, { type, point, second }) => {
      const touch = (position: [number, number], identifier: number) =>
        new Touch({ identifier, target: node, clientX: position[0], clientY: position[1] });
      const changed = touch(point, 1);
      const touches =
        type === 'touchend' || type === 'touchcancel'
          ? []
          : [changed, ...(second ? [touch(second, 2)] : [])];
      return node.dispatchEvent(
        new TouchEvent(type, {
          bubbles: true,
          cancelable: true,
          touches,
          targetTouches: touches,
          changedTouches: [changed],
        })
      );
    },
    { type, point, second }
  );
}

async function stageOffset(page: Page) {
  return page.locator('[data-drama-stage]').evaluate((node) => {
    const transform = getComputedStyle(node).transform;
    return transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m42;
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function expectReachable(page: Page, name: string) {
  const button = page.getByRole('button', { name, exact: true });
  await expect(button).toBeInViewport();
  expect(
    await button.evaluate((node) => {
      const box = node.getBoundingClientRect();
      const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return box.width >= 44 && box.height >= 44 && Boolean(top && node.contains(top));
    }),
    `${name}的触控区域应可点击，且不被底栏遮住`
  ).toBeTruthy();
}

test('@drama @layout 剧场固定筛选，进入选集后返回原筛选', async ({ page, preview }) => {
  await preview.scenario('dramas');
  await page.goto('/dramas');
  await tabs(page).getByRole('button', { name: '剧场', exact: true }).click();
  const search = page.getByRole('searchbox', { name: '搜索短剧名称或题材' });
  await expect(page.getByRole('heading', { name: '发现好剧' })).toBeVisible();
  await expect(page.getByRole('list', { name: '短剧标签', exact: true })).toHaveCount(0);
  const categories = page.getByLabel('短剧分类', { exact: true });
  await expect(categories.getByRole('button', { name: '全部', exact: true })).toBeVisible();
  await expect(categories.getByRole('button', { name: '悬疑', exact: true })).toBeVisible();
  await expectMobileLayout(page);
  await preview.screenshot('短剧双列剧场');
  await page.getByRole('link', { name: '观看 时光旅人', exact: true }).scrollIntoViewIfNeeded();
  await expect(search).toBeInViewport();
  await expect(tabs(page)).toBeInViewport();
  await page.getByRole('button', { name: '悬疑', exact: true }).click();
  await search.fill('雾城');
  await expect(page.getByRole('link', { name: '观看 雾城来信', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '观看 无人到站', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: '观看 雾城来信', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/dramas/${firstDrama}$`));
  await pauseReadyVideo(page);
  const playerTags = page.getByRole('list', { name: '短剧标签', exact: true });
  await expect(playerTags.getByRole('listitem')).toHaveCount(6);
  await expect(playerTags.getByText(/^\+/)).toHaveCount(0);
  await expect(playerTags.getByText('层层揭开真相', { exact: true })).toBeInViewport();
  await page.getByRole('button', { name: '查看完整简介', exact: true }).click();
  const allTags = page.getByRole('list', { name: '全部标签', exact: true });
  await expect(allTags.getByRole('listitem')).toHaveCount(6);
  await expect(allTags.getByText('层层揭开真相', { exact: true })).toBeInViewport();
  await expectReachable(page, '关闭选集');
  await expectMobileLayout(page);
  await preview.screenshot('短剧完整标签');
  await page.getByRole('button', { name: '关闭选集', exact: true }).click();
  await expectReachable(page, '查看全部选集');
  await page.getByRole('button', { name: /^选集，第/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: '第 3 集', exact: true })).toBeInViewport();
  await preview.screenshot('短剧选集');
  await dialog.getByRole('button', { name: '第 3 集', exact: true }).click();
  await expect(page.locator('video')).toHaveAttribute('aria-label', '雾城来信，第 3 集');
  await pauseReadyVideo(page);
  await page.getByRole('link', { name: '返回短剧', exact: true }).click();
  await expect(search).toHaveValue('雾城');
  await expect(page.getByText('全部短剧中搜索', { exact: true })).toBeVisible();
  await search.fill('');
  await expect(page.getByRole('button', { name: '悬疑', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await expect(page.locator('video')).toHaveCount(0);
  await expectMobileLayout(page);
  await preview.screenshot('剧场筛选与返回');
});

test('@drama 搜索不被原分类锁住，退出后恢复原分类', async ({ page }) => {
  await page.goto('/dramas');
  const search = page.getByRole('searchbox', { name: '搜索短剧名称或题材' });
  const category = page.getByLabel('短剧分类', { exact: true });
  await category.getByRole('button', { name: '悬疑', exact: true }).click();
  await search.fill('长安');
  await expect(page.getByRole('link', { name: '观看 长安月未央', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '观看 雾城来信', exact: true })).toHaveCount(0);
  await expect(page.getByText('全部短剧中搜索', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '退出搜索', exact: true }).click();
  await expect(search).toHaveValue('');
  await expect(category.getByRole('button', { name: '悬疑', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await expect(page.getByRole('link', { name: '观看 雾城来信', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '观看 长安月未央', exact: true })).toHaveCount(0);
  await search.fill('没有这部短剧');
  await page.getByRole('button', { name: '返回剧场', exact: true }).click();
  await expect(category.getByRole('button', { name: '悬疑', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
});

test('@drama 追剧整行都能继续看，收藏按钮只改变收藏', async ({ page }) => {
  await page.goto('/');
  await pauseReadyVideo(page);
  await page.getByRole('button', { name: '收藏这部剧', exact: true }).click();
  await mainNav(page).getByRole('link', { name: 'AI短剧', exact: true }).click();
  await tabs(page).getByRole('button', { name: '追剧', exact: true }).click();
  const row = page.getByRole('link', { name: '继续观看 雾城来信', exact: true });
  // 从标题边的空白起手，而不是精准点击封面或“继续看”字样。
  const box = (await row.boundingBox())!;
  await row.click({ position: { x: box.width * 0.55, y: box.height * 0.55 } });
  await expect(page).toHaveURL(new RegExp(`/dramas/${firstDrama}$`));
  await pauseReadyVideo(page);
  await page.getByRole('link', { name: '返回短剧', exact: true }).click();
  await page.getByRole('button', { name: '取消收藏 雾城来信', exact: true }).click();
  await expect(page).toHaveURL(/\/dramas$/);
  await expect(page.locator('video')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '喜欢的故事，留在这里' })).toBeVisible();
});

test('@drama 短暂试看保留历史，但不抢走已在追的继续看', async ({ page }) => {
  await page.goto(`/dramas/${firstDrama}`);
  await pauseReadyVideo(page);
  await page.getByRole('button', { name: /^选集，第/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: '第 3 集', exact: true }).click();
  const following = await pauseReadyVideo(page);
  await following.evaluate((node: HTMLVideoElement) => {
    node.currentTime = 1;
  });
  await page.getByRole('link', { name: '返回短剧', exact: true }).click();
  await expect(page.getByRole('link', { name: '继续观看 雾城来信', exact: true })).toBeVisible();
  await page.getByRole('link', { name: '观看 长安月未央', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/dramas/${secondDrama}$`));
  const preview = await pauseReadyVideo(page);
  // 快进产生的秒数只能形成历史，不能冒充真实累计观看。
  await preview.evaluate((node: HTMLVideoElement) => {
    node.currentTime = 2;
  });
  await expect.poll(() => preview.evaluate((node: HTMLVideoElement) => node.currentTime)).toBe(2);
  await page.getByRole('link', { name: '返回短剧', exact: true }).click();
  await expect(page.getByRole('link', { name: '继续观看 雾城来信', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '继续观看 长安月未央', exact: true })).toHaveCount(0);
  await tabs(page).getByRole('button', { name: '追剧', exact: true }).click();
  await page.getByRole('button', { name: '最近看过', exact: true }).click();
  await expect(page.getByRole('link', { name: '继续观看 长安月未央', exact: true })).toBeVisible();
});

test('@drama @layout 首页中间入口可刷剧和追剧，换栏目释放旧视频', async ({ page, preview }) => {
  await page.goto('/');
  const first = await pauseReadyVideo(page);
  const oldVideo = await first.elementHandle();
  const navigation = mainNav(page);
  await expect(navigation.getByRole('link')).toHaveCount(5);
  await expect(navigation.getByRole('link').nth(2)).toHaveAttribute('aria-label', '首页');
  await expect(navigation.getByRole('link', { name: '首页', exact: true })).toHaveAttribute(
    'aria-current',
    'page'
  );
  await expectReachable(page, '收藏这部剧');
  await page.getByRole('button', { name: '收藏这部剧', exact: true }).click();
  await expect(page.getByRole('button', { name: '取消收藏', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await preview.screenshot('短剧沉浸推荐');
  await swipe(page.locator('[data-player-toggle-controls]'), [160, 350], [160, 200]);
  await expect(page.getByRole('heading', { name: '长安月未央', exact: true })).toBeVisible();
  await expect(page.locator('video')).toHaveCount(1);
  expect(
    await oldVideo!.evaluate(
      (node) => (node as HTMLVideoElement).paused && !node.getAttribute('src')
    )
  ).toBeTruthy();
  await pauseReadyVideo(page);
  await mainNav(page).getByRole('link', { name: 'AI短剧', exact: true }).click();
  await tabs(page).getByRole('button', { name: '追剧', exact: true }).click();
  await expect(page.locator('video')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '雾城来信', exact: true })).toBeVisible();
  await expect(page.getByText('收藏与观看进度保存在当前设备')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: '雾城来信', exact: true })).toBeVisible();
  await preview.screenshot('短剧追剧列表');
  await page.getByRole('button', { name: '取消收藏 雾城来信', exact: true }).click();
  await expect(page.getByRole('heading', { name: '喜欢的故事，留在这里' })).toBeVisible();
  await navigation.getByRole('link', { name: '首页', exact: true }).click();
  await expect(page).toHaveURL('http://127.0.0.1:3130/');
  await expect(page.locator('video')).toHaveCount(1);
  await expectMobileLayout(page);
});

test('@drama 观看位置在本设备刷新后恢复，集数和秒数保持', async ({ page, preview }) => {
  await page.goto(`/dramas/${firstDrama}`);
  await pauseReadyVideo(page);
  await page.getByRole('button', { name: /^选集，第/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: '第 3 集', exact: true }).click();
  await expect(page.locator('video')).toHaveAttribute('aria-label', '雾城来信，第 3 集');
  const video = await pauseReadyVideo(page);
  await video.evaluate((node) => {
    const media = node as HTMLVideoElement;
    media.currentTime = 2;
  });
  await expect
    .poll(() => video.evaluate((node) => (node as HTMLVideoElement).currentTime))
    .toBeGreaterThanOrEqual(1.9);
  await page.getByRole('link', { name: '返回短剧', exact: true }).click();
  await tabs(page).getByRole('button', { name: '追剧', exact: true }).click();
  await page.getByRole('button', { name: '最近看过', exact: true }).click();
  await expect(page.getByText('看到第 3 集', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('link', { name: '继续观看 雾城来信', exact: true }).click();
  await expect(page.locator('video')).toHaveAttribute('aria-label', '雾城来信，第 3 集');
  const resumed = await pauseReadyVideo(page);
  expect(
    await resumed.evaluate((node) => (node as HTMLVideoElement).currentTime)
  ).toBeGreaterThanOrEqual(1.9);
  const state = await preview.state();
  expect(
    state.requests.some((item) => item.path.includes(`/api/dramas/${firstDrama}/play`))
  ).toBeTruthy();
});

test('@drama @layout 首页观看完整短剧进入专注详情，返回仍接着这部', async ({ page }) => {
  await page.goto('/');
  await pauseReadyVideo(page);
  await swipe(page.locator('[data-player-toggle-controls]'), [160, 450], [160, 220]);
  await expect(page.locator('video')).toHaveAttribute('aria-label', '长安月未央，第 1 集');
  const feedVideo = await pauseReadyVideo(page);
  await feedVideo.evaluate((node: HTMLVideoElement) => {
    node.currentTime = 2;
  });
  const fullDrama = page.getByRole('link', { name: '观看完整短剧 长安月未央', exact: true });
  await expect(fullDrama).toHaveAttribute('href', `/dramas/${secondDrama}?from=feed`);
  await expect(page.getByRole('button', { name: /^选集，第/ })).toHaveCount(0);
  await fullDrama.click();
  await expect(page).toHaveURL(new RegExp(`/dramas/${secondDrama}\\?from=feed$`));
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('video')).toHaveAttribute('aria-label', '长安月未央，第 1 集');
  const focusedVideo = await pauseReadyVideo(page);
  await expect
    .poll(() => focusedVideo.evaluate((node: HTMLVideoElement) => node.currentTime))
    .toBeGreaterThanOrEqual(1.9);
  await page.getByRole('button', { name: /^选集，第/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: '第 3 集', exact: true }).click();
  await expect(focusedVideo).toHaveAttribute('aria-label', '长安月未央，第 3 集');
  const episode = await pauseReadyVideo(page);
  await episode.evaluate((node: HTMLVideoElement) => {
    node.currentTime = 1;
  });
  await page.getByRole('link', { name: '返回首页', exact: true }).click();
  await expect(page).toHaveURL('http://127.0.0.1:3130/');
  await expect(page.locator('video')).toHaveAttribute('aria-label', '长安月未央，第 3 集');
  const resumed = await pauseReadyVideo(page);
  await expect
    .poll(() => resumed.evaluate((node: HTMLVideoElement) => node.currentTime))
    .toBeGreaterThanOrEqual(0.9);
  await expect(mainNav(page)).toBeVisible();
  // 从推荐页简介主动选集，同样进入专注观看，并直接定位所选集数。
  await page.getByRole('button', { name: '查看完整简介', exact: true }).click();
  await page.getByRole('tab', { name: '选集', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '第 5 集', exact: true }).click();
  await expect(page.locator('video')).toHaveAttribute('aria-label', '长安月未央，第 5 集');
  await pauseReadyVideo(page);
  await expect(page).toHaveURL(`http://127.0.0.1:3130/dramas/${secondDrama}?from=feed`);
  await swipe(page.locator('[data-player-toggle-controls]'), [160, 450], [160, 220]);
  await expect(page.locator('video')).toHaveAttribute('aria-label', '长安月未央，第 6 集');
  const nextEpisode = await pauseReadyVideo(page);
  await nextEpisode.evaluate((node: HTMLVideoElement) => {
    node.currentTime = 2;
    node.dispatchEvent(new Event('pause'));
  });
  await page.reload();
  await expect(page.locator('video')).toHaveAttribute('aria-label', '长安月未央，第 6 集');
  const refreshed = await pauseReadyVideo(page);
  await expect
    .poll(() => refreshed.evaluate((node: HTMLVideoElement) => node.currentTime))
    .toBeGreaterThanOrEqual(1.9);
  await expect(page.getByRole('link', { name: '返回首页', exact: true })).toHaveAttribute(
    'href',
    '/'
  );
  await expectMobileLayout(page);
});

test('@drama 自动续播下一集，选集面板不会误触换剧', async ({ page }) => {
  await page.goto(`/dramas/${firstDrama}`);
  const video = await pauseReadyVideo(page);
  await page
    .locator('[data-player-toggle-controls]')
    .dispatchEvent('pointerdown', { pointerId: 1, pointerType: 'touch' });
  await video.evaluate(async (node) => {
    const media = node as HTMLVideoElement;
    media.currentTime = media.duration - 0.1;
    await media.play();
  });
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.ended)).toBe(true);
  // 超过自动切换的160ms，按住期间仍应等用户松手。
  await page.waitForTimeout(350);
  await expect(video).toHaveAttribute('aria-label', '雾城来信，第 1 集');
  await page
    .locator('[data-player-toggle-controls]')
    .dispatchEvent('pointerup', { pointerId: 1, pointerType: 'touch' });
  await expect(video).toHaveAttribute('aria-label', '雾城来信，第 2 集');
  await pauseReadyVideo(page);
  await page.getByRole('button', { name: /^选集，第/ }).click();
  await swipe(page.getByRole('dialog'), [180, 500], [180, 250]);
  await expect(page).toHaveURL(new RegExp(`/dramas/${firstDrama}$`));
  await page.getByRole('button', { name: '关闭选集', exact: true }).click();
  await page.getByRole('button', { name: '播放速度 1 倍，点击选择' }).click();
  await page.getByRole('button', { name: '1.25 倍', exact: true }).click();
  expect(await video.evaluate((node) => (node as HTMLVideoElement).playbackRate)).toBe(1.25);
});

test('@drama 推荐支持上下滑换剧，横滑不换剧', async ({ page }) => {
  await page.goto('/');
  await pauseReadyVideo(page);
  const surface = page.getByLabel(
    '短剧播放画面，单击切换纯净模式，双击播放或暂停，上下滑切换短剧',
    {
      exact: true,
    }
  );
  expect((await swipe(surface, [180, 500], [320, 480])).prevented).toBe(false);
  await expect(page.getByRole('heading', { name: '雾城来信', exact: true })).toBeVisible();
  expect((await swipe(surface, [180, 500], [185, 270])).prevented).toBe(true);
  await expect(page.getByRole('heading', { name: '长安月未央', exact: true })).toBeVisible();
  await pauseReadyVideo(page);
  expect((await swipe(surface, [180, 300], [180, 500])).prevented).toBe(true);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await expect(page.getByRole('heading', { name: '雾城来信', exact: true })).toBeVisible();
});

test('@drama 详情上下滑只换同剧集数，首尾不跨剧，末集播完停留', async ({ page }) => {
  await page.goto(`/dramas/${firstDrama}`);
  let video = await pauseReadyVideo(page);
  const picture = page.locator('[data-player-toggle-controls]');
  await swipe(picture, [160, 250], [160, 450]);
  await expect.poll(() => stageOffset(page)).toBeCloseTo(0, 0);
  await expect(video).toHaveAttribute('aria-label', '雾城来信，第 1 集');
  await swipe(picture, [160, 450], [160, 220]);
  await expect(video).toHaveAttribute('aria-label', '雾城来信，第 2 集');
  await expect(page).toHaveURL(new RegExp(`/dramas/${firstDrama}$`));
  video = await pauseReadyVideo(page);
  await expect.poll(() => stageOffset(page)).toBeCloseTo(0, 0);
  await swipe(picture, [160, 250], [160, 450]);
  await expect(video).toHaveAttribute('aria-label', '雾城来信，第 1 集');
  await pauseReadyVideo(page);
  await page.getByRole('button', { name: /^选集，第/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: '第 8 集', exact: true }).click();
  await expect(video).toHaveAttribute('aria-label', '雾城来信，第 8 集');
  video = await pauseReadyVideo(page);
  await swipe(picture, [160, 450], [160, 220]);
  await expect.poll(() => stageOffset(page)).toBeCloseTo(0, 0);
  await expect(video).toHaveAttribute('aria-label', '雾城来信，第 8 集');
  await video.evaluate(async (node: HTMLVideoElement) => {
    node.currentTime = node.duration - 0.1;
    await node.play();
  });
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.ended)).toBe(true);
  // 超过换场动画窗口，详情仍停留本剧；不能悄悄开始另一部。
  await page.waitForTimeout(350);
  await expect(page).toHaveURL(new RegExp(`/dramas/${firstDrama}$`));
  await expect(video).toHaveAttribute('aria-label', '雾城来信，第 8 集');
  await expect(page.getByRole('button', { name: '继续播放', exact: true })).toBeVisible();
});

test('@drama @layout 手指拖动画面跟随，短拖取消回弹，横滑多指不换剧', async ({ page, preview }) => {
  await page.goto('/');
  const video = await pauseReadyVideo(page);
  const picture = page.locator('[data-player-toggle-controls]');
  await touchPhase(picture, 'touchstart', [160, 350]);
  await touchPhase(picture, 'touchmove', [160, 250]);
  await expect.poll(() => stageOffset(page)).toBeLessThan(-10);
  await expect(video).toHaveAttribute('aria-label', '雾城来信，第 1 集');
  await preview.screenshot('画面跟手拖动');
  await touchPhase(picture, 'touchcancel', [160, 250]);
  await expect.poll(() => stageOffset(page)).toBeCloseTo(0, 0);

  await touchPhase(picture, 'touchstart', [160, 350]);
  await touchPhase(picture, 'touchmove', [160, 330]);
  await expect.poll(() => stageOffset(page)).toBeLessThan(0);
  await touchPhase(picture, 'touchend', [160, 330]);
  await expect.poll(() => stageOffset(page)).toBeCloseTo(0, 0);

  await touchPhase(picture, 'touchstart', [160, 350]);
  await touchPhase(picture, 'touchmove', [280, 340]);
  await touchPhase(picture, 'touchend', [280, 340]);
  await expect.poll(() => stageOffset(page)).toBeCloseTo(0, 0);
  await touchPhase(picture, 'touchstart', [160, 350]);
  await touchPhase(picture, 'touchmove', [160, 240], [220, 240]);
  await touchPhase(picture, 'touchend', [160, 240]);
  await expect.poll(() => stageOffset(page)).toBeCloseTo(0, 0);
  await expect(video).toHaveAttribute('aria-label', '雾城来信，第 1 集');
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.paused)).toBe(true);
  await swipe(picture, [160, 450], [160, 220]);
  await expect(video).toHaveAttribute('aria-label', '长安月未央，第 1 集');
});

test('@drama 短距离快甩也能换下一集', async ({ page }) => {
  await page.goto(`/dramas/${firstDrama}`);
  await pauseReadyVideo(page);
  await page.locator('[data-player-toggle-controls]').evaluate(async (node) => {
    const dispatch = (type: string, y: number) => {
      const touch = new Touch({ identifier: 1, target: node, clientX: 160, clientY: y });
      node.dispatchEvent(
        new TouchEvent(type, {
          bubbles: true,
          cancelable: true,
          touches: type === 'touchend' ? [] : [touch],
          targetTouches: type === 'touchend' ? [] : [touch],
          changedTouches: [touch],
        })
      );
    };
    dispatch('touchstart', 350);
    await new Promise((resolve) => setTimeout(resolve, 24));
    dispatch('touchmove', 305);
    dispatch('touchend', 305);
  });
  await expect(page.locator('video')).toHaveAttribute('aria-label', '雾城来信，第 2 集');
  await expect(page).toHaveURL(new RegExp(`/dramas/${firstDrama}$`));
});

test('@drama @layout 全宽进度先预览后定位，保留原播放状态，取消不跳秒', async ({
  page,
  preview,
}) => {
  await page.goto(`/dramas/${firstDrama}`);
  const video = await pauseReadyVideo(page);
  const slider = page.getByRole('slider', { name: '播放进度' });
  const progress = page.locator('[data-drama-progress]');
  const box = (await slider.boundingBox())!;
  expect(box.width).toBeGreaterThan(page.viewportSize()!.width - 48);
  expect(box.height).toBeGreaterThanOrEqual(44);
  const duration = await video.evaluate((node: HTMLVideoElement) => node.duration);
  await video.evaluate((node: HTMLVideoElement) => {
    node.currentTime = 1;
  });
  await page.mouse.move(box.x + box.width * 0.2, box.y + 10);
  await page.mouse.down();
  await expect(progress).toHaveAttribute('data-progress-scrubbing', 'true');
  await page.mouse.move(box.x + box.width * 0.7, box.y + 10, { steps: 5 });
  await expect(page.getByLabel('拖动目标时间', { exact: true })).toBeVisible();
  expect(await video.evaluate((node: HTMLVideoElement) => node.currentTime)).toBeCloseTo(1, 1);
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.paused)).toBe(true);
  await preview.screenshot('全宽进度拖动预览');
  await page.mouse.up();
  await expect(progress).toHaveAttribute('data-progress-scrubbing', 'false');
  await expect
    .poll(() => video.evaluate((node: HTMLVideoElement) => node.currentTime))
    .toBeCloseTo(duration * 0.7, 1);
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.paused)).toBe(true);

  await video.evaluate(async (node: HTMLVideoElement) => {
    node.currentTime = 0.25;
    await node.play();
  });
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height - 10);
  await page.mouse.down();
  await expect(progress).toHaveAttribute('data-progress-scrubbing', 'true');
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.paused)).toBe(true);
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height - 10, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.paused)).toBe(false);
  await video.evaluate((node: HTMLVideoElement) => node.pause());
  const beforeCancel = await video.evaluate((node: HTMLVideoElement) => node.currentTime);
  await page.mouse.move(box.x + box.width * 0.2, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, box.y + 10);
  await slider.dispatchEvent('pointercancel', {
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
  });
  await page.mouse.up();
  await expect(progress).toHaveAttribute('data-progress-scrubbing', 'false');
  expect(await video.evaluate((node: HTMLVideoElement) => node.currentTime)).toBeCloseTo(
    beforeCancel,
    1
  );
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.paused)).toBe(true);
  await expect(video).toHaveAttribute('aria-label', '雾城来信，第 1 集');
  // 拖动时切到后台，取消预览；回到页面不能擅自恢复播放。
  await video.evaluate(async (node: HTMLVideoElement) => {
    await node.play();
  });
  await page.mouse.move(box.x + box.width * 0.2, box.y + 10);
  await page.mouse.down();
  const beforeHide = await video.evaluate((node: HTMLVideoElement) => node.currentTime);
  await page.mouse.move(box.x + box.width * 0.8, box.y + 10);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.mouse.up();
  await expect(progress).toHaveAttribute('data-progress-scrubbing', 'false');
  await page.evaluate(() => {
    Reflect.deleteProperty(document, 'visibilityState');
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(await video.evaluate((node: HTMLVideoElement) => node.currentTime)).toBeCloseTo(
    beforeHide,
    1
  );
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.paused)).toBe(true);
  await slider.focus();
  await slider.press('Home');
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.currentTime)).toBe(0);
  await page.mouse.move(box.x + box.width * 0.2, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width + 10, box.y + 10);
  await page.mouse.up();
  await expect
    .poll(() => video.evaluate((node: HTMLVideoElement) => node.currentTime))
    .toBeCloseTo(duration, 1);
  await page.waitForTimeout(350);
  await expect(video).toHaveAttribute('aria-label', '雾城来信，第 1 集');
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.paused)).toBe(true);
  // 真正的移动触摸链：手指离开轨道高度后仍被捕获，只有松手才定位。
  await video.evaluate((node: HTMLVideoElement) => {
    node.currentTime = 1;
  });
  const touchBox = (await slider.boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: touchBox.x + touchBox.width * 0.25, y: touchBox.y + 8, id: 1 }],
    });
    await expect(progress).toHaveAttribute('data-progress-scrubbing', 'true');
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: touchBox.x + touchBox.width * 0.65, y: touchBox.y - 60, id: 1 }],
    });
    await expect(page.getByLabel('拖动目标时间', { exact: true })).toBeVisible();
    expect(await video.evaluate((node: HTMLVideoElement) => node.currentTime)).toBeCloseTo(1, 1);
    await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.paused)).toBe(true);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(progress).toHaveAttribute('data-progress-scrubbing', 'false');
    await expect
      .poll(() => video.evaluate((node: HTMLVideoElement) => node.currentTime))
      .toBeCloseTo(duration * 0.65, 1);
    await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.paused)).toBe(true);
    await expect(video).toHaveAttribute('aria-label', '雾城来信，第 1 集');
  } finally {
    await cdp
      .send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] })
      .catch(() => {});
    await cdp.detach();
  }
  await expectMobileLayout(page);
});

test('@drama 失效的本地续看位置回退首集', async ({ page }) => {
  await page.addInitScript(
    ({ id }) => {
      localStorage.setItem(
        'st-drama-library-v1:local',
        JSON.stringify({
          saved: [id],
          history: {
            [id]: {
              videoId: 'removed-episode',
              episode: 3,
              seconds: 2,
              duration: 5,
              updatedAt: Date.now(),
              completed: false,
            },
          },
        })
      );
    },
    { id: firstDrama }
  );
  await page.goto(`/dramas/${firstDrama}`);
  const video = await pauseReadyVideo(page);
  await expect(video).toHaveAttribute('aria-label', '雾城来信，第 1 集');
  await expect(video).toHaveAttribute('src', new RegExp(firstVideo));
});

test('@drama 播放失败可重试，列表失败和空状态有出口', async ({ page, preview, request }) => {
  await preview.scenario('drama-play-error');
  await page.goto('/');
  await expect(page.getByText('播放暂时中断了')).toBeVisible({ timeout: 25000 });
  await expect(page.getByRole('button', { name: '下一部短剧' })).toBeEnabled();
  await request.post('http://127.0.0.1:3131/__preview/reset', { data: { scenario: 'dramas' } });
  await page.getByRole('button', { name: '重新播放', exact: true }).click();
  await pauseReadyVideo(page);
  await preview.scenario('drama-list-error');
  await page.goto('/dramas');
  await expect(page.getByText('短剧暂时没加载出来')).toBeVisible({ timeout: 25000 });
  await expect(page.getByRole('button', { name: '重新加载', exact: true })).toBeVisible();
  await preview.scenario('empty');
  await page.goto('/dramas');
  await expect(page.getByRole('heading', { name: '好戏，即将开场' })).toBeVisible();
  await expect(page.locator('video')).toHaveCount(0);
});

test('@drama 重试失败仍能再试，新地址只装载一次并接回原秒数', async ({ page }) => {
  await page.goto(`/dramas/${firstDrama}`);
  const video = await pauseReadyVideo(page);
  await video.evaluate((node: HTMLVideoElement) => {
    node.currentTime = 2;
    const loads: string[] = [];
    Reflect.set(window, '__dramaRetryLoads', loads);
    node.addEventListener('loadstart', () => {
      const source = node.getAttribute('src');
      if (source) loads.push(source);
    });
    node.dispatchEvent(new Event('error'));
  });
  const failGate = deferred();
  const successGate = deferred();
  let failing = true;
  let failures = 0;
  let successes = 0;
  await page.route(
    (url) =>
      url.pathname === `/api/dramas/${firstDrama}/play` &&
      (!url.searchParams.has('video_id') || url.searchParams.get('video_id') === firstVideo),
    async (route) => {
      if (failing) {
        failures += 1;
        await failGate.promise;
        await route.fulfill({
          status: 503,
          json: {
            success: false,
            error: { code: 'preview_unavailable', message: '重试暂不可用' },
          },
        });
        return;
      }
      successes += 1;
      const response = await route.fetch();
      const body = (await response.json()) as { data: GetDramaPlaybackData };
      body.data.playback.play_url += '&renewed=1';
      await successGate.promise;
      await route.fulfill({ response, json: body });
    }
  );
  try {
    await page.getByRole('button', { name: '重新播放', exact: true }).click();
    await expect.poll(() => failures).toBeGreaterThan(0);
    await expect(page.getByRole('button', { name: '正在恢复', exact: true })).toBeDisabled();
    await expect(video).not.toHaveAttribute('src');
    failGate.resolve();
    await expect(page.getByRole('button', { name: '重新播放', exact: true })).toBeEnabled();
    await expect(video).not.toHaveAttribute('src');
    failing = false;
    await page.getByRole('button', { name: '重新播放', exact: true }).click();
    await expect.poll(() => successes).toBe(1);
    await expect(video).not.toHaveAttribute('src');
    successGate.resolve();
    await expect(video).toHaveAttribute('src', /renewed=1/);
    await pauseReadyVideo(page);
    await expect
      .poll(() => video.evaluate((node: HTMLVideoElement) => node.currentTime))
      .toBeGreaterThanOrEqual(1.9);
    const loads = await page.evaluate(() => Reflect.get(window, '__dramaRetryLoads') as string[]);
    expect(loads).toHaveLength(1);
    expect(loads[0]).toContain('renewed=1');
    const nearEnd = await video.evaluate((node: HTMLVideoElement) => {
      const seconds = node.duration - 0.3;
      node.currentTime = seconds;
      node.addEventListener('loadedmetadata', () => node.pause(), { once: true });
      node.dispatchEvent(new Event('error'));
      return seconds;
    });
    await page.getByRole('button', { name: '重新播放', exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(() => (Reflect.get(window, '__dramaRetryLoads') as string[]).length)
      )
      .toBe(2);
    await pauseReadyVideo(page);
    await expect
      .poll(() => video.evaluate((node: HTMLVideoElement) => node.currentTime))
      .toBeCloseTo(nearEnd, 1);
  } finally {
    failGate.resolve();
    successGate.resolve();
  }
});

test('@drama 迟到的重试不能覆盖新集数，也不能在退出后恢复发声', async ({ page }) => {
  for (const action of ['episode', 'exit'] as const) {
    await page.goto(`/dramas/${firstDrama}`);
    const video = await pauseReadyVideo(page);
    const oldMedia = (await video.elementHandle())!;
    const source = await video.getAttribute('src');
    const currentVideo = new URL(source!).searchParams.get('episode')!;
    const gate = deferred();
    const delivered = deferred();
    let requested = false;
    const match = (url: URL) =>
      url.pathname === `/api/dramas/${firstDrama}/play` &&
      (!url.searchParams.has('video_id') || url.searchParams.get('video_id') === currentVideo);
    await page.route(match, async (route) => {
      requested = true;
      const response = await route.fetch();
      const body = (await response.json()) as { data: GetDramaPlaybackData };
      body.data.playback.play_url += `&late=${action}`;
      await gate.promise;
      try {
        await route.fulfill({ response, json: body });
      } finally {
        delivered.resolve();
      }
    });
    try {
      await video.evaluate((node: HTMLVideoElement) => {
        node.currentTime = 1;
        node.dispatchEvent(new Event('error'));
      });
      await page.getByRole('button', { name: '重新播放', exact: true }).click();
      await expect.poll(() => requested).toBe(true);
      if (action === 'episode') {
        await page.getByRole('button', { name: /^选集，第/ }).click();
        await page
          .getByRole('dialog')
          .getByRole('button', { name: '第 2 集', exact: true })
          .click();
        await expect(video).toHaveAttribute('aria-label', '雾城来信，第 2 集');
        await pauseReadyVideo(page);
      } else {
        await page.getByRole('link', { name: '返回短剧', exact: true }).click();
        await expect(page).toHaveURL(/\/dramas$/);
      }
      gate.resolve();
      await delivered.promise;
      // 给已完成的迟到响应一个渲染周期，确认没有旧源重新挂回。
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          )
      );
      if (action === 'episode') {
        await expect(video).toHaveAttribute('aria-label', '雾城来信，第 2 集');
        await expect(video).not.toHaveAttribute('src', /late=/);
        await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.paused)).toBe(true);
      } else {
        await expect(page.locator('video')).toHaveCount(0);
        expect(
          await oldMedia.evaluate(
            (node: HTMLVideoElement) => node.paused && !node.getAttribute('src')
          )
        ).toBe(true);
      }
    } finally {
      gate.resolve();
      await page.unroute(match);
    }
  }
});

test('@drama 推荐目录后台失败不打断当前画面，刷新后也保留进度', async ({ page, context }) => {
  await page.goto('/');
  const video = await pauseReadyVideo(page);
  const original = (await video.elementHandle())!;
  await video.evaluate((node: HTMLVideoElement) => {
    node.currentTime = 1;
  });
  let failing = true;
  await page.route(
    (url) => url.pathname === '/api/dramas',
    async (route) => {
      if (failing)
        await route.fulfill({
          status: 503,
          json: {
            success: false,
            error: { code: 'preview_unavailable', message: '目录暂不可用' },
          },
        });
      else await route.continue();
    }
  );
  await page.route(
    (url) => url.pathname === `/api/dramas/${firstDrama}/play`,
    async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { data: GetDramaPlaybackData };
      body.data.playback.play_url += '&backgroundrenewal=1';
      await route.fulfill({ response, json: body });
    }
  );
  // 只推进查询新鲜度，保留真实计时器与媒体；网络恢复触发后台刷新。
  await page.clock.setFixedTime(new Date(Date.now() + 31_000));
  await context.setOffline(true);
  await context.setOffline(false);
  const retry = page.getByRole('button', { name: '刷新短剧推荐', exact: true });
  await expect(retry).toBeVisible();
  await expect(video).toHaveAttribute('src', /backgroundrenewal=1/);
  await expect(page.getByRole('heading', { name: '短剧暂时没加载出来', exact: true })).toHaveCount(
    0
  );
  expect(await original.evaluate((node) => node.isConnected)).toBe(true);
  await expect
    .poll(() => video.evaluate((node: HTMLVideoElement) => node.currentTime))
    .toBeCloseTo(1, 1);
  failing = false;
  await retry.click();
  await expect(retry).toHaveCount(0);
  expect(await original.evaluate((node) => node.isConnected)).toBe(true);
  expect(await video.evaluate((node: HTMLVideoElement) => node.currentTime)).toBeCloseTo(1, 1);
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.paused)).toBe(true);
});

test('@drama @layout 已收藏与最近看过分别记位置，详情返回仍能找到原行', async ({ page }) => {
  await page.addInitScript(() => {
    const ids = Array.from(
      { length: 12 },
      (_, index) => `60000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
    );
    localStorage.setItem(
      'st-drama-library-v1:local',
      JSON.stringify({
        saved: ids,
        history: Object.fromEntries(
          ids.map((id, index) => [
            id,
            {
              videoId: `70000000-0000-4000-8000-${String(index * 100 + 1).padStart(12, '0')}`,
              episode: 1,
              seconds: 1,
              duration: 5,
              completed: false,
              updatedAt: Date.now() - index * 1000,
              engagedAt: Date.now() - index * 1000,
            },
          ])
        ),
      })
    );
  });
  await page.goto('/dramas');
  await tabs(page).getByRole('button', { name: '追剧', exact: true }).click();
  const saved = page.getByLabel('已收藏短剧列表', { exact: true });
  await saved.evaluate((node) => {
    node.scrollTop = 450;
  });
  await expect.poll(() => saved.evaluate((node) => node.scrollTop)).toBeCloseTo(450, 0);
  await page.getByRole('button', { name: '最近看过', exact: true }).click();
  const recent = page.getByLabel('最近看过短剧列表', { exact: true });
  await recent.evaluate((node) => {
    node.scrollTop = 750;
  });
  await expect.poll(() => recent.evaluate((node) => node.scrollTop)).toBeCloseTo(750, 0);
  await page.getByRole('button', { name: '已收藏', exact: true }).click();
  await expect.poll(() => saved.evaluate((node) => node.scrollTop)).toBeCloseTo(450, 0);
  const savedRow = page.getByRole('link', { name: '继续观看 山间有晴', exact: true });
  await savedRow.scrollIntoViewIfNeeded();
  const beforeDetail = await saved.evaluate((node) => node.scrollTop);
  await savedRow.click();
  await pauseReadyVideo(page);
  await page.getByRole('link', { name: '返回短剧', exact: true }).click();
  await expect(savedRow).toBeInViewport();
  await expect.poll(() => saved.evaluate((node) => node.scrollTop)).toBeCloseTo(beforeDetail, 0);
  await page.getByRole('button', { name: '最近看过', exact: true }).click();
  // 最近看过可能因刚看的一部重排，点击行返回时以该行仍可见为准。
  const recentRow = page.getByRole('link', { name: '继续观看 时光旅人', exact: true });
  await recentRow.scrollIntoViewIfNeeded();
  await recentRow.click();
  await pauseReadyVideo(page);
  await page.getByRole('link', { name: '返回短剧', exact: true }).click();
  await expect(recentRow).toBeInViewport();
  await expectMobileLayout(page);
});

test('@drama @layout 长选集打开和切回时看得到当前集，手动浏览不会被抢走', async ({
  page,
  preview,
}) => {
  await page.addInitScript(
    ({ id }) => {
      localStorage.setItem(
        'st-drama-library-v1:local',
        JSON.stringify({
          saved: [],
          history: {
            [id]: {
              videoId: '70000000-0000-4000-8000-000000001128',
              episode: 28,
              seconds: 1,
              duration: 5,
              updatedAt: Date.now(),
              completed: false,
            },
          },
        })
      );
    },
    { id: longDrama }
  );
  await page.goto(`/dramas/${longDrama}`);
  const video = await pauseReadyVideo(page);
  await expect(video).toHaveAttribute('aria-label', '时光旅人，第 28 集');
  await page.getByRole('button', { name: '查看全部选集', exact: true }).click();
  const current = page.getByRole('button', { name: '第 28 集，当前播放', exact: true });
  const episodes = page.getByLabel('剧集列表', { exact: true });
  await expect(current).toBeInViewport({ ratio: 0.95 });
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: '收藏这部剧', exact: true })).toBeInViewport({
    ratio: 1,
  });
  // 当前集可能先进入视口；等整个面板贴到底部再截图，避免把进场动画当成截断。
  await expect
    .poll(() =>
      dialog.evaluate((node) => Math.abs(node.getBoundingClientRect().bottom - window.innerHeight))
    )
    .toBeLessThanOrEqual(1);
  await preview.screenshot('长选集当前集定位');
  await episodes.evaluate((node) => {
    node.scrollTop = 0;
  });
  await expect.poll(() => episodes.evaluate((node) => node.scrollTop)).toBe(0);
  await video.evaluate((node: HTMLVideoElement) => {
    node.currentTime = 1.5;
    node.dispatchEvent(new Event('timeupdate'));
  });
  await expect.poll(() => episodes.evaluate((node) => node.scrollTop)).toBe(0);
  await page.getByRole('tab', { name: '简介', exact: true }).click();
  await page.getByRole('tab', { name: '选集', exact: true }).click();
  await expect(current).toBeInViewport({ ratio: 0.95 });
  await page.getByRole('button', { name: '31–60', exact: true }).click();
  await expect(page.getByRole('button', { name: '第 31 集', exact: true })).toBeInViewport();
  await video.evaluate((node: HTMLVideoElement) => {
    node.currentTime = 2;
    node.dispatchEvent(new Event('timeupdate'));
  });
  await expect(page.getByRole('button', { name: '31–60', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await expect(page.getByRole('button', { name: '第 31 集', exact: true })).toBeInViewport();
  await page.getByRole('button', { name: '关闭选集', exact: true }).click();
  await page.getByRole('button', { name: '查看全部选集', exact: true }).click();
  await expect(current).toBeInViewport({ ratio: 0.95 });
  await expectMobileLayout(page);
});

test('@drama @layout 点赞、评论和选集简介顺手可用，没有博主关注', async ({ page, preview }) => {
  await page.goto('/');
  const video = await pauseReadyVideo(page);
  await expect(page.getByRole('button', { name: /关注|转发|红包/ })).toHaveCount(0);
  await expectReachable(page, '点赞这部剧');
  await page.getByRole('button', { name: '点赞这部剧', exact: true }).click();
  await expect(page.getByRole('button', { name: '取消点赞', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await page.getByRole('button', { name: '取消点赞', exact: true }).click();
  await expect(page.getByRole('button', { name: '点赞这部剧', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false'
  );
  await page.getByRole('button', { name: '查看完整简介' }).click();
  await expect(page.getByRole('tab', { name: '简介', exact: true })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await page.getByRole('tab', { name: '选集', exact: true }).click();
  await expect(page.getByRole('button', { name: '第 1 集，当前播放', exact: true })).toBeVisible();
  await preview.screenshot('短剧选集新版');
  await page.getByRole('button', { name: '关闭选集' }).click();
  await page.getByRole('button', { name: '打开评论' }).click();
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.paused)).toBe(true);
  await expect(page.getByText('这个开头留了悬念，想看后面怎么解释。')).toBeVisible();
  await page.getByRole('button', { name: '查看更多评论' }).click();
  await expect(page.getByText('这是第 23 位演示观众的追剧感受。')).toBeAttached();
  await page.getByRole('textbox', { name: '评论内容' }).fill('这段反转很有意思，期待下一集。');
  await page.getByRole('button', { name: '发表评论' }).click();
  await expect(page.getByRole('textbox', { name: '评论内容' })).toHaveValue('');
  await expect(page.getByText('这段反转很有意思，期待下一集。', { exact: true })).toHaveCount(1);
  await preview.screenshot('短剧评论新版');
  await page.getByRole('button', { name: '删除我的评论：这段反转很有意思，期待下一集。' }).click();
  await page.getByRole('button', { name: '确认删除' }).click();
  await expect(page.getByText('这段反转很有意思，期待下一集。', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '关闭评论' }).click();
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.paused)).toBe(true);
  await page.getByRole('button', { name: '播放视频', exact: true }).click();
  await page.getByRole('button', { name: '打开评论' }).click();
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.paused)).toBe(false);
  await page.getByRole('button', { name: '关闭评论' }).click();
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.paused)).toBe(false);
  await expectMobileLayout(page);
});

test('@drama @layout 互动失败保留草稿，重试不重复，收缩视口仍能发送', async ({ page, preview }) => {
  await preview.scenario('drama-interaction-error');
  await page.goto('/');
  await pauseReadyVideo(page);
  await page.getByRole('button', { name: '点赞这部剧' }).click();
  await expect(page.getByText('点赞没能保存，请再试一次')).toBeVisible();
  await expect(page.getByRole('button', { name: '点赞这部剧' })).toHaveAttribute(
    'aria-pressed',
    'false'
  );
  await page.getByRole('button', { name: '打开评论' }).click();
  const text = '留一点悬念挺好，\n但下一集可得解释清楚。';
  await page.getByRole('textbox', { name: '评论内容' }).fill(text);
  await page.getByRole('button', { name: '发表评论' }).click();
  await expect(page.getByText('没发出去，内容已保留，再试一次吧')).toBeVisible();
  await expect(page.getByRole('textbox', { name: '评论内容' })).toHaveValue(text);
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: size.width, height: 340 });
  await expectReachable(page, '发表评论');
  await page.getByRole('button', { name: '发表评论' }).click();
  await expect(page.getByRole('textbox', { name: '评论内容' })).toHaveValue('');
  await expect(page.getByText(text, { exact: true })).toHaveCount(1);
  await page.setViewportSize(size);
  await page.getByRole('button', { name: '关闭评论' }).click();
  await expectMobileLayout(page);
});

test('@drama 首页评论期间一条播完换下一部，草稿归属不变且不会多路发声', async ({
  page,
  preview,
}) => {
  await page.goto('/');
  let video = await pauseReadyVideo(page);
  await page.getByRole('button', { name: '播放速度 1 倍，点击选择' }).click();
  await page.getByRole('button', { name: '1.25 倍', exact: true }).click();
  const mute = page.getByRole('button', { name: '关闭声音', exact: true });
  if (await mute.isVisible()) await mute.click();
  await page.getByRole('button', { name: '打开评论' }).click();
  const draft = page.getByRole('textbox', { name: '评论内容' });
  await draft.fill('评论写到一半，自动续播也不能丢。');
  await video.evaluate(async (node: HTMLVideoElement) => {
    node.currentTime = node.duration - 0.2;
    await node.play();
  });
  await expect(video).toHaveAttribute('aria-label', '长安月未央，第 1 集');
  await expect(draft).toHaveValue('评论写到一半，自动续播也不能丢。');
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => !node.paused)).toBe(true);
  video = await pauseReadyVideo(page);
  const oldVideo = await video.elementHandle();
  await video.evaluate(async (node: HTMLVideoElement) => {
    node.currentTime = node.duration - 0.2;
    await node.play();
  });
  await expect(page).toHaveURL('http://127.0.0.1:3130/');
  await expect(page.locator('video')).toHaveAttribute('aria-label', '星期五的告白，第 1 集');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByText('《雾城来信》的评论')).toBeVisible();
  await expect(draft).toHaveValue('评论写到一半，自动续播也不能丢。');
  await expect
    .poll(() =>
      page
        .locator('video')
        .evaluate(
          (node: HTMLVideoElement) => !node.paused && node.muted && node.playbackRate === 1.25
        )
    )
    .toBe(true);
  expect(
    await oldVideo!.evaluate((node: HTMLVideoElement) => node.paused && !node.getAttribute('src'))
  ).toBe(true);
  await page.getByRole('button', { name: '发表评论' }).click();
  await expect(draft).toHaveValue('');
  const state = await preview.state();
  expect(
    state.requests
      .filter((r) => r.method === 'POST' && r.path.endsWith('/comments'))
      .map((r) => r.path)
  ).toEqual([`/api/dramas/${firstDrama}/comments`]);
  await expect
    .poll(async () => {
      const media = await page.locator('video').boundingBox();
      const panel = await page.getByRole('dialog').boundingBox();
      return media && panel ? media.y + media.height <= panel.y + 1 : false;
    })
    .toBe(true);
  await preview.screenshot('评论不中断续播');
  await page.getByRole('button', { name: '关闭评论' }).click();
  await expect(page.getByText(/已经看到最后一部|上滑，发现|这一部，看到这里/)).toHaveCount(0);
});

test('@drama 片尾预取但不抢播，选集时等待，最后一部安静结束', async ({ page, preview }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`/dramas/${firstDrama}`);
  const video = await pauseReadyVideo(page);
  const prefetched = page.waitForRequest((request) =>
    request.url().includes('video_id=70000000-0000-4000-8000-000000000002')
  );
  await video.evaluate((node: HTMLVideoElement) => {
    node.currentTime = node.duration - 2;
  });
  await prefetched;
  await expect(video).toHaveAttribute('aria-label', '雾城来信，第 1 集');
  await page.getByRole('button', { name: '查看全部选集' }).click();
  await video.evaluate(async (node: HTMLVideoElement) => {
    node.currentTime = node.duration - 0.1;
    await node.play();
  });
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.ended)).toBe(true);
  await expect(video).toHaveAttribute('aria-label', '雾城来信，第 1 集');
  await page.getByRole('button', { name: '关闭选集' }).click();
  await expect(video).toHaveAttribute('aria-label', '雾城来信，第 2 集');
  await page.goto('/dramas');
  await page.getByRole('searchbox', { name: '搜索短剧名称或题材' }).fill('今天也要笑');
  await page.getByRole('link', { name: '观看 今天也要笑', exact: true }).click();
  const last = await pauseReadyVideo(page);
  await last.evaluate(async (node: HTMLVideoElement) => {
    node.currentTime = node.duration - 0.1;
    await node.play();
  });
  await expect.poll(() => last.evaluate((node: HTMLVideoElement) => node.ended)).toBe(true);
  await expect(page.getByRole('button', { name: '继续播放', exact: true })).toBeVisible();
  await expect(page.getByText(/已经看到最后一部|这一部，看到这里|上滑，发现/)).toHaveCount(0);
});

test('@drama 播放页持续禁用 Telegram 收起手势，换剧和评论不释放，退出恢复', async ({ page }) => {
  await page.addInitScript(() => {
    const messages: boolean[] = [];
    Object.defineProperty(window, '__swipeMessages', { value: messages });
    Object.defineProperty(window, 'TelegramWebviewProxy', {
      value: {
        postEvent: (name: string, data: string) => {
          if (name === 'web_app_setup_swipe_behavior')
            messages.push(JSON.parse(data).allow_vertical_swipe);
        },
      },
    });
  });
  await page.goto('/#tgWebAppVersion=8.0&tgWebAppPlatform=android&tgWebAppThemeParams=%7B%7D');
  const messages = () => page.evaluate(() => Reflect.get(window, '__swipeMessages') as boolean[]);
  await pauseReadyVideo(page);
  await expect.poll(async () => (await messages()).at(-1)).toBe(false);
  const initial = await messages();
  await swipe(page.locator('[data-player-toggle-controls]'), [180, 500], [180, 250]);
  await expect(page.locator('video')).toHaveAttribute('aria-label', '长安月未央，第 1 集');
  await pauseReadyVideo(page);
  await page.getByRole('button', { name: '打开评论' }).click();
  await expect(page.getByText('这个开头留了悬念，想看后面怎么解释。')).toBeVisible();
  const commentList = page.getByRole('dialog').locator('[data-player-no-swipe]');
  expect((await swipe(commentList, [180, 600], [180, 400])).prevented).toBe(false);
  await page.getByRole('button', { name: '关闭评论' }).click();
  expect(await messages()).toEqual(initial);
  await mainNav(page).getByRole('link', { name: 'AI短剧', exact: true }).click();
  await expect.poll(async () => (await messages()).at(-1)).toBe(true);
  await page.getByRole('link', { name: '观看 雾城来信', exact: true }).click();
  await pauseReadyVideo(page);
  await expect.poll(async () => (await messages()).at(-1)).toBe(false);
  const detailStart = await messages();
  await swipe(page.locator('[data-player-toggle-controls]'), [180, 500], [180, 250]);
  await expect(page).toHaveURL(new RegExp(`/dramas/${firstDrama}$`));
  await expect(page.locator('video')).toHaveAttribute('aria-label', '雾城来信，第 2 集');
  await pauseReadyVideo(page);
  expect(await messages()).toEqual(detailStart);
  await page.getByRole('link', { name: '返回短剧', exact: true }).click();
  await expect.poll(async () => (await messages()).at(-1)).toBe(true);
});

test('@drama @layout 单击只切纯净模式，双击画面播放暂停，倍速直接选', async ({ page, preview }) => {
  await page.goto('/');
  const video = await pauseReadyVideo(page);
  const picture = page.locator('[data-player-toggle-controls]');
  const bounds = (await picture.boundingBox())!;
  const tap = () => page.touchscreen.tap(bounds.x + 65, bounds.y + 220);
  // 单击只切界面：暂停状态不受影响，首页导航也收起。
  await tap();
  await expect(mainNav(page)).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: '短剧互动' })).toHaveCount(0);
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.paused)).toBe(true);
  // 两次真实触屏点按：纯净模式下直接继续播放，不闪出控件。
  await tap();
  await tap();
  await expect(page.getByRole('status', { name: '继续播放中', exact: true })).toBeVisible();
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.paused)).toBe(false);
  await expect(mainNav(page)).toHaveCount(0);
  await page.waitForTimeout(350); // 下一次独立双击，超过识别窗口。
  await tap();
  await tap();
  await expect(page.getByRole('status', { name: '已暂停', exact: true })).toBeVisible();
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.paused)).toBe(true);
  await expect(mainNav(page)).toHaveCount(0);
  await preview.screenshot('纯净模式双击暂停');
  await expect(page.getByRole('status', { name: '已暂停', exact: true })).toHaveCount(0);
  await expect(mainNav(page)).toHaveCount(0);
  // 单击唤回界面，仍然暂停。
  await picture.click({ position: { x: 75, y: 330 } });
  await expect(mainNav(page)).toBeVisible();
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.paused)).toBe(true);
  // 中央图标保留直接播放，第二击落到下方画面也不能改变界面。
  await page.getByRole('button', { name: '继续播放', exact: true }).dblclick({ delay: 60 });
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.paused)).toBe(false);
  await page.getByRole('button', { name: '播放速度 1 倍，点击选择' }).click();
  await expectReachable(page, '1 倍');
  await expectReachable(page, '2 倍');
  await preview.screenshot('倍速直接选择');
  await page.getByRole('button', { name: '1.5 倍', exact: true }).click();
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.playbackRate)).toBe(1.5);
  await page.getByRole('button', { name: '播放速度 1.5 倍，点击选择' }).click();
  await picture.click({ position: { x: 75, y: 220 } });
  await expect(page.getByRole('group', { name: '选择播放速度' })).toHaveCount(0);
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.paused)).toBe(false);
  await page.getByRole('button', { name: '播放速度 1.5 倍，点击选择' }).click();
  await page.getByRole('button', { name: '1 倍', exact: true }).click();
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.playbackRate)).toBe(1);
  await expectMobileLayout(page);
});

test('@drama 从剧名和中央图标起手也能换剧，横滑后不会误开简介', async ({ page }) => {
  await page.goto('/');
  await pauseReadyVideo(page);
  await swipe(page.getByRole('button', { name: '查看完整简介' }), [150, 600], [150, 350]);
  await expect(page.locator('video')).toHaveAttribute('aria-label', '长安月未央，第 1 集');
  await pauseReadyVideo(page);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await swipe(page.getByRole('button', { name: '继续播放', exact: true }), [190, 400], [190, 200]);
  await expect(page.locator('video')).toHaveAttribute('aria-label', '星期五的告白，第 1 集');
  const video = await pauseReadyVideo(page);
  const title = page.getByRole('button', { name: '查看完整简介' });
  await swipe(title, [80, 580], [230, 590]);
  await title.dispatchEvent('click');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.paused)).toBe(true);
  await expect(video).toHaveAttribute('aria-label', '星期五的告白，第 1 集');
});

test('@drama @layout 面板横杠可以下拉收起，短拖回弹，内容滚动不误关', async ({ page }) => {
  await page.goto('/');
  const video = await pauseReadyVideo(page);
  await page.getByRole('button', { name: '打开评论' }).click();
  const dialog = page.getByRole('dialog');
  const commentHandle = page.locator('[data-sheet-drag-handle][aria-label="下拉关闭评论"]');
  await expect(commentHandle).toBeVisible();
  await swipe(commentHandle, [170, 270], [170, 302]);
  await expect(dialog).toBeVisible();
  await expect
    .poll(() => dialog.evaluate((node) => (node as HTMLElement).style.translate))
    .toBe('0px');
  await swipe(commentHandle, [170, 270], [275, 300]);
  await expect(dialog).toBeVisible();
  await page.getByRole('textbox', { name: '评论内容' }).fill('收起后回来，草稿仍在。');
  await swipe(dialog.locator('[data-player-no-swipe]'), [170, 550], [170, 350]);
  await expect(dialog).toBeVisible();
  await swipe(commentHandle, [170, 270], [170, 400]);
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.paused)).toBe(true);
  await page.getByRole('button', { name: '打开评论' }).click();
  await expect(page.getByRole('textbox', { name: '评论内容' })).toHaveValue(
    '收起后回来，草稿仍在。'
  );
  await page.getByRole('button', { name: '关闭评论' }).click();
  await page.getByRole('button', { name: '查看完整简介', exact: true }).click();
  await page.getByRole('tab', { name: '选集', exact: true }).click();
  const episodeHandle = page.locator('[data-sheet-drag-handle][aria-label="下拉关闭选集"]');
  await swipe(episodeHandle, [170, 270], [170, 410]);
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.paused)).toBe(true);
});

test('@drama 顶部与底部空白同样支持单击纯净和双击播放', async ({ page }) => {
  await page.goto(`/dramas/${firstDrama}`);
  const video = await pauseReadyVideo(page);
  const size = page.viewportSize()!;
  // 集数周围的空白应穿透到画面，不要求瞄准中心。
  await page.touchscreen.tap(size.width / 2, 25);
  await expect(page.getByRole('link', { name: '返回短剧', exact: true })).toHaveCount(0);
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.paused)).toBe(true);
  await page.touchscreen.tap(size.width / 2, 25);
  await page.touchscreen.tap(size.width / 2, 25);
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.paused)).toBe(false);
  await page.touchscreen.tap(2, size.height - 110);
  await expect(page.getByRole('link', { name: '返回短剧', exact: true })).toBeVisible();
  await page.touchscreen.tap(2, size.height - 110);
  await page.touchscreen.tap(2, size.height - 110);
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.paused)).toBe(true);
});

test('@drama 详情控件由用户收放，不在准备选集时自动消失', async ({ page }) => {
  await page.goto(`/dramas/${firstDrama}`);
  const video = await pauseReadyVideo(page);
  await video.evaluate(async (node: HTMLVideoElement) => {
    // 本地素材仅 5 秒，放慢它以单独验证原来的 3 秒自动隐藏窗口。
    node.playbackRate = 0.1;
    await node.play();
  });
  await page.waitForTimeout(3400);
  await expect(page.getByRole('link', { name: '返回短剧', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^选集，第/ })).toBeVisible();
  await page.locator('[data-player-toggle-controls]').click({ position: { x: 80, y: 220 } });
  await expect(page.getByRole('link', { name: '返回短剧', exact: true })).toHaveCount(0);
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.paused)).toBe(false);
});
