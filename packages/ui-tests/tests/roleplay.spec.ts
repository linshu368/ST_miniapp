import type { Locator } from '@playwright/test';
import { test, expect, IDS, chatPath, studioPath, expectMobileLayout } from './fixtures.js';

test('@roleplay @layout 浏览角色时栏目固定，进聊天后可返回', async ({ page, preview }) => {
  await page.goto('/characters');
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
  await expect(page).toHaveURL(/3130\/characters$/);
  await expectMobileLayout(page);
  await preview.screenshot('角色浏览与返回');
});

test('@roleplay 空对话列表有清晰入口', async ({ page, preview }) => {
  await preview.scenario('empty');
  await page.goto('/chats');
  await expect(page.getByText(/还没有|暂无/).first()).toBeVisible();
  await expectMobileLayout(page);
});

test('@navigation @layout 五入口跨模块保持统一，末项与操作条不被遮挡，深层页不留空位', async ({
  page,
  preview,
}) => {
  test.setTimeout(90_000);
  const nav = page.getByRole('navigation', { name: '主导航', exact: true });
  const labels = ['角色', 'AI短剧', '首页', '生成', '我的'];
  let baseline:
    | { background: string; radius: string; shadow: string; widths: number[] }
    | undefined;
  const checkNav = async (active: string) => {
    await expect(nav).toBeVisible();
    await expect(nav.getByRole('link')).toHaveCount(5);
    await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
    await expect(nav.getByRole('link', { name: active, exact: true })).toHaveAttribute(
      'aria-current',
      'page'
    );
    for (const [index, label] of labels.entries()) {
      await expect(nav.getByRole('link').nth(index)).toHaveAttribute('aria-label', label);
    }
    await expect(nav.getByRole('link', { name: '首页', exact: true }).locator('svg')).toBeVisible();
    const metrics = await nav.evaluate((node) => {
      const box = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        background: style.backgroundColor,
        radius: style.borderRadius,
        shadow: style.boxShadow,
        widths: Array.from(node.querySelectorAll('a')).map(
          (link) => link.getBoundingClientRect().width
        ),
      };
    });
    const size = page.viewportSize()!;
    expect(metrics.x).toBeCloseTo(0, 0);
    expect(metrics.width).toBeCloseTo(size.width, 0);
    expect(metrics.height).toBeCloseTo(66, 0);
    expect(metrics.y + metrics.height).toBeCloseTo(size.height, 0);
    const appearance = {
      background: metrics.background,
      radius: metrics.radius,
      shadow: metrics.shadow,
      widths: metrics.widths,
    };
    if (baseline) expect(appearance).toEqual(baseline);
    else baseline = appearance;
    await expect
      .poll(() =>
        page
          .locator('[data-main-content]')
          .evaluate((node) => parseFloat(getComputedStyle(node).paddingBottom))
      )
      .toBe(66);
    await expectMobileLayout(page);
  };
  const aboveNav = async (target: Locator) => {
    await expect(target).toBeInViewport({ ratio: 0.95 });
    await expect
      .poll(async () => {
        const content = await target.boundingBox();
        const navigation = await nav.boundingBox();
        return Boolean(content && navigation && content.y + content.height <= navigation.y + 1);
      })
      .toBe(true);
    expect(
      await target.evaluate((node) => {
        const box = node.getBoundingClientRect();
        const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return Boolean(top && node.contains(top));
      }),
      '末项应能实际点到，不被固定导航拦住'
    ).toBe(true);
  };

  await page.goto('/characters');
  await expect(
    page.getByRole('button', { name: '查看 林间旅人 的详情', exact: true })
  ).toBeVisible();
  await checkNav('角色');
  await preview.screenshot('统一五入口角色页', { fullPage: false });
  const lastCharacter = page.getByRole('button', { name: '查看 故事旅人 18 的详情', exact: true });
  // 首屏只挂12张，触底会再挂最后6张；等实际末项出现后继续滚到它。
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect(lastCharacter).toBeAttached();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await aboveNav(lastCharacter);
  await page
    .getByRole('navigation', { name: '角色栏目' })
    .getByRole('link', { name: '对话', exact: true })
    .click();
  await expect(page).toHaveURL(/\/chats$/);
  await checkNav('角色');
  await nav.getByRole('link', { name: 'AI短剧', exact: true }).click();
  await expect(page).toHaveURL(/\/dramas$/);
  await checkNav('AI短剧');
  const lastDrama = page.getByRole('link', { name: '观看 时光旅人', exact: true });
  await lastDrama.scrollIntoViewIfNeeded();
  await aboveNav(lastDrama);
  await nav.getByRole('link', { name: '首页', exact: true }).click();
  await expect(page).toHaveURL('http://127.0.0.1:3130/');
  await expect(page.locator('video')).toHaveCount(1);
  await page.locator('video').evaluate((node: HTMLVideoElement) => node.pause());
  await checkNav('首页');
  await page.locator('[data-player-toggle-controls]').click({ position: { x: 80, y: 180 } });
  await expect(nav).toHaveCount(0);
  await expect
    .poll(() =>
      page
        .locator('[data-main-content]')
        .evaluate((node) => parseFloat(getComputedStyle(node).paddingBottom))
    )
    .toBe(0);
  await page.goBack();
  await expect(page).toHaveURL(/\/dramas$/);
  await checkNav('AI短剧');
  await nav.getByRole('link', { name: '生成', exact: true }).click();
  await expect(page).toHaveURL(/\/create$/);
  await checkNav('生成');
  await expect(
    page.getByRole('button', { name: '用同款：薄雾中的山谷', exact: true })
  ).toBeVisible();
  const lastWork = page.getByRole('button', { name: /^用同款：/ }).last();
  await lastWork.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await aboveNav(lastWork);
  await page.goto(`/create/work/${IDS.work}`);
  await checkNav('生成');
  const workActions = page.getByRole('group', { name: '作品操作', exact: true });
  await aboveNav(workActions);
  await aboveNav(workActions.getByRole('button', { name: '用同款', exact: true }));
  await preview.screenshot('统一导航与影像操作条', { fullPage: false });
  await nav.getByRole('link', { name: '我的', exact: true }).click();
  await expect(page).toHaveURL(/\/profile$/);
  await checkNav('我的');
  await expect(page.getByRole('link', { name: '联系客服', exact: true })).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await aboveNav(page.getByRole('button', { name: /官方社群/ }));

  const secondary = [
    { path: studioPath, ready: () => page.getByPlaceholder('描述你想生成的画面…') },
    {
      path: '/profile/recharge',
      ready: () => page.getByRole('heading', { name: '充值星尘', exact: true }),
    },
    { path: '/vip', ready: () => page.getByRole('heading', { name: 'VIP 会员', exact: true }) },
    {
      path: '/profile/messages',
      ready: () => page.getByRole('heading', { name: '消息中心', exact: true }),
    },
    {
      path: '/profile/support',
      ready: () => page.getByRole('textbox', { name: '输入要发送给客服的问题', exact: true }),
    },
  ];
  for (const destination of secondary) {
    await page.goto(destination.path);
    await expect(destination.ready()).toBeVisible();
    await expect(nav).toHaveCount(0);
    await expect
      .poll(() =>
        page
          .locator('[data-main-content]')
          .evaluate((node) => parseFloat(getComputedStyle(node).paddingBottom))
      )
      .toBe(0);
    await expectMobileLayout(page);
  }
  await page.goto(chatPath);
  await expect(page.getByRole('textbox', { name: '输入消息', exact: true })).toBeVisible();
  await expect(nav).toHaveCount(0);
  await expectMobileLayout(page);
  await page.goto('/characters');
  await checkNav('角色');
});
