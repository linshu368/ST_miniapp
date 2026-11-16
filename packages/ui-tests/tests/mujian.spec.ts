import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { makeData } from '../fixtures/data';

async function setup(
  page: Page,
  source = 'mujian_dzmm',
  failedPlay = 0,
  failedEntry = 0,
  hls = false,
  expiresFirst = false
) {
  const data = makeData('http://127.0.0.1:3188');
  const drama = data.dramas[0]!;
  let entries = 0,
    plays = 0;
  await page.route('https://telegram.org/**', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: '' })
  );
  await page.addInitScript(
    ({ source }) => {
      localStorage.setItem('mujian-language', 'zh');
      Math.random = () => 0.9;
      Object.defineProperty(window, 'Telegram', {
        value: {
          WebApp: {
            initData: new URLSearchParams({ auth_date: '1', start_param: source }).toString(),
            ready() {},
            openTelegramLink(url: string) {
              (window as unknown as { opened: string }).opened = url;
            },
          },
        },
      });
    },
    { source }
  );
  await page.route('http://localhost:3001/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/mujian-entry')) {
      entries++;
      return route.fulfill({
        status: entries <= failedEntry ? 503 : 200,
        json: { success: entries > failedEntry, data: { recorded: entries > failedEntry } },
      });
    }
    if (path === '/api/dramas')
      return route.fulfill({ json: { success: true, data: { dramas: [drama] } } });
    if (path === '/api/dramas/' + drama.id)
      return route.fulfill({ json: { success: true, data: { drama } } });
    if (path === '/api/dramas/play') {
      plays++;
      if (plays <= failedPlay) return route.fulfill({ status: 503, json: { success: false } });
      return route.fulfill({
        json: {
          success: true,
          data: {
            playback: {
              playable: true,
              video_id: route.request().postDataJSON().video_id,
              format: hls ? 'hls' : 'mp4',
              play_url: hls
                ? 'http://localhost:3001/hls/index.m3u8'
                : 'http://localhost:3001/video',
              expires_at: new Date(
                Date.now() + (expiresFirst && plays === 1 ? 1000 : 3600000)
              ).toISOString(),
            },
          },
        },
      });
    }
    if (path.startsWith('/hls/'))
      return route.fulfill({
        contentType: path.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
        body: await readFile(
          new URL('../fixtures/assets/mujian-hls/' + path.split('/').pop(), import.meta.url)
        ),
      });
    if (path === '/video')
      return route.fulfill({
        contentType: 'video/mp4',
        body: await readFile(new URL('../fixtures/assets/drama-preview.mp4', import.meta.url)),
      });
    return route.abort();
  });
  return { drama, counts: () => ({ entries, plays }) };
}

test('real API-shaped catalog, selection, favorites, retry and media disposal @mujian', async ({
  page,
}) => {
  const fixture = await setup(page, 'mujian_dzmm', 1, 1);
  await page.goto('/catalog.html');
  await page.getByRole('button', { name: '查看' + fixture.drama.title, exact: true }).click();
  await expect(page.locator('.episodes button')).toHaveCount(fixture.drama.videos.length);
  await expect(page.locator('video')).toHaveJSProperty('readyState', 4);
  await expect.poll(() => fixture.counts().plays).toBe(2);
  await page.locator('.episodes button').nth(1).click();
  await expect.poll(() => fixture.counts().plays).toBe(3);
  await page.getByRole('button', { name: '♡ 收藏', exact: true }).click();
  await expect.poll(() => fixture.counts().entries).toBe(2);
  await page.locator('#modal .close').click();
  await expect(page.locator('video')).not.toHaveAttribute('src');
  await page.goto('/library.html');
  await expect(page.locator('.saved-card')).toHaveCount(1);
  await page.locator('.saved-card a').click();
  await expect(page.locator('.episodes button').nth(1)).toHaveAttribute('aria-pressed', 'true');
  expect(fixture.counts().entries).toBe(2);
});

test('entry clock, both invitations, pause/resume, session dedup and correct signed-source link @mujian', async ({
  page,
}) => {
  await setup(page);
  await page.clock.install();
  await page.goto('/catalog.html');
  await page.locator('.card').first().click();
  const video = page.locator('video');
  await expect(video).toHaveJSProperty('readyState', 4);
  await video.evaluate((v: HTMLVideoElement) => {
    v.loop = true;
    v.muted = true;
    return v.play();
  });
  await page.clock.fastForward(120001);
  await expect(page.locator('[data-invitation="mijing"]')).toBeVisible();
  await expect(page.locator('dialog.mujian-prompt')).toHaveCount(1);
  await expect(video).toHaveJSProperty('paused', true);
  await expect(page.locator('[data-invitation="mijing"] a')).toHaveAttribute(
    'href',
    'https://t.me/MIJINGAI_bot/app?startapp=mujian_dzmm'
  );
  await page.locator('.mujian-prompt .mujian-prompt-close').click();
  // Dialog close dispatch is asynchronous; wait for removal before looking for the next one.
  await expect(page.locator('.mujian-prompt')).toHaveCount(0);
  await expect(video).toHaveJSProperty('paused', false);
  await video.evaluate((v: HTMLVideoElement) => v.pause());
  await page.clock.fastForward(150000);
  {
    await expect(page.locator('[data-invitation="community"]')).toBeVisible();
    await expect(page.locator('.mujian-prompt a')).toHaveAttribute(
      'href',
      'https://t.me/MijingAI_Official'
    );
    await page.locator('.mujian-prompt-close').click();
  }
  await expect(video).toHaveJSProperty('paused', true);
  await page.reload();
  await page.clock.fastForward(300000);
  await expect(page.locator('.mujian-prompt')).toHaveCount(0);
});

test('organic has no dzmm fallback and no-play browsing still triggers invite @mujian', async ({
  page,
}) => {
  await setup(page, '');
  await page.clock.install();
  await page.goto('/index.html');
  await page.clock.fastForward(120001);
  await expect(page.locator('[data-invitation="mijing"] a')).toHaveAttribute(
    'href',
    'https://t.me/MIJINGAI_bot/app'
  );
});

test('ordinary browser offers Telegram opening without auth bypass @mujian', async ({ page }) => {
  await page.route('https://telegram.org/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/catalog.html');
  await expect(page.locator('#cards a')).toHaveAttribute(
    'href',
    'https://t.me/MIJINGAI_bot/mujian'
  );
  await expect(page.locator('.card')).toHaveCount(0);
});

test('pinned HLS.js plays the local fixture and destroys its old instance on selection @mujian', async ({
  page,
}) => {
  const fixture = await setup(page, 'mujian_dzmm', 0, 0, true);
  await page.addInitScript(() => {
    const original = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = function (type) {
      return type === 'application/vnd.apple.mpegurl' ? '' : original.call(this, type);
    };
  });
  await page.goto('/catalog.html');
  await page.locator('.card').first().click();
  await expect(page.locator('video')).toHaveJSProperty('readyState', 4);
  await expect(page.locator('video')).toHaveAttribute('src', /^blob:/);
  await page.locator('.episodes button').nth(1).click();
  await expect.poll(() => fixture.counts().plays).toBe(2);
  await expect(page.locator('video')).toHaveJSProperty('readyState', 4);
  await page.locator('#modal .close').click();
  await expect(page.locator('video')).not.toHaveAttribute('src');
});

test('permanent playback failure stops at three requests and allows explicit retry @mujian', async ({
  page,
}) => {
  const fixture = await setup(page, 'mujian_dzmm', 99);
  await page.goto('/catalog.html');
  await page.locator('.card').first().click();
  await expect(page.getByRole('button', { name: '重新播放', exact: true })).toBeVisible();
  expect(fixture.counts().plays).toBe(3);
  await page.getByRole('button', { name: '重新播放', exact: true }).click();
  await expect.poll(() => fixture.counts().plays).toBeGreaterThan(3);
});

test('early community invitation queues behind Mijing without stacking or losing resume @mujian', async ({
  page,
}) => {
  await setup(page);
  await page.addInitScript(() => {
    Math.random = () => 0.1;
  });
  await page.clock.install();
  await page.goto('/catalog.html');
  await page.clock.fastForward(120001);
  await expect(page.locator('[data-invitation="mijing"]')).toBeVisible();
  await page.locator('[data-invitation="mijing"] .mujian-prompt-close').click();
  await expect(page.locator('[data-invitation="community"]')).toBeVisible();
  await expect(page.locator('dialog.mujian-prompt')).toHaveCount(1);
  await page.locator('[data-invitation="community"] a').click();
  expect(await page.evaluate(() => (window as unknown as { opened: string }).opened)).toBe(
    'https://t.me/MijingAI_Official'
  );
});

test('expired playback address is re-signed on resume without resetting the selected episode @mujian', async ({
  page,
}) => {
  const fixture = await setup(page, 'mujian_dzmm', 0, 0, false, true);
  await page.clock.install();
  await page.goto('/catalog.html');
  await page.locator('.card').first().click();
  await expect(page.locator('video')).toHaveJSProperty('readyState', 4);
  await page.locator('video').evaluate((v: HTMLVideoElement) => {
    v.pause();
    v.currentTime = 1;
  });
  await page.clock.fastForward(2000);
  await page.locator('video').evaluate((v: HTMLVideoElement) => {
    v.muted = true;
    void v.play().catch(() => {});
  });
  await expect.poll(() => fixture.counts().plays).toBe(2);
  await expect(page.locator('video')).toHaveJSProperty('readyState', 4);
  await expect(page.locator('.episodes button').first()).toHaveAttribute('aria-pressed', 'true');
});
