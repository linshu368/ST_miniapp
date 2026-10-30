import type { Locator } from '@playwright/test';
import {
  test,
  expect,
  IDS,
  chatPath,
  studioPath,
  sendChat,
  expectMobileLayout,
} from './fixtures.js';

test('@roleplay @layout 浏览角色时栏目固定，进聊天后可返回', async ({ page, preview }) => {
  await page.goto('/characters');
  await expect(page.getByText('林间旅人', { exact: true }).first()).toBeVisible();
  const card = page.getByRole('button', { name: '查看 林间旅人 的详情', exact: true });
  await expect
    .poll(() => card.locator('img').evaluate((node) => (node as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
  const initialRequests = (await preview.state()).requests;
  expect(
    initialRequests.filter(
      (request) => request.method === 'GET' && request.path === '/api/v1/conversations'
    )
  ).toHaveLength(1);
  expect(
    initialRequests.filter(
      (request) => request.method === 'GET' && request.path === `/api/characters/${IDS.character}`
    )
  ).toHaveLength(0);
  const discover = page.getByRole('link', { name: '发现', exact: true });
  await page.evaluate(() => window.scrollTo(0, 700));
  await expect(discover).toBeInViewport();
  await expect(page.getByRole('textbox', { name: '搜索角色', exact: true })).toBeInViewport();
  await expect(page.getByRole('tablist', { name: '角色排序' })).not.toBeInViewport();
  await preview.screenshot('角色下滑保留栏目与搜索', { fullPage: false });
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
  const labels = ['角色', '创作', '首页', 'AI短剧', '我的'];
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
  await nav.getByRole('link', { name: '创作', exact: true }).click();
  await expect(page).toHaveURL(/\/creation$/);
  await checkNav('创作');
  await page.getByRole('link', { name: /图片与视频/ }).click();
  await expect(page).toHaveURL(/\/create$/);
  await checkNav('创作');
  await expect(
    page.getByRole('button', { name: '用同款：薄雾中的山谷', exact: true })
  ).toBeVisible();
  const lastWork = page.getByRole('button', { name: /^用同款：/ }).last();
  await lastWork.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await aboveNav(lastWork);
  await page.goto(`/create/work/${IDS.work}`);
  await checkNav('创作');
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

test('@roleplay @character-social @layout 点赞收藏独立，列表详情和聊天同步', async ({
  page,
  preview,
}) => {
  await preview.scenario('character-social');
  await page.goto('/characters');
  const card = page.locator(`[data-lobby-character-id="${IDS.character}"]`);
  const like = () => card.getByRole('button', { name: /^(取消)?点赞 林间旅人$/ });
  const favorite = () => card.getByRole('button', { name: /^(收藏角色卡|取消收藏)$/ });
  await expect(like()).toContainText('128');
  await expect(favorite()).toHaveAttribute('aria-pressed', 'true');
  await expect(favorite()).toContainText('87');
  const buttons = card
    .getByRole('group', { name: '林间旅人的互动', exact: true })
    .getByRole('button');
  await expect(buttons).toHaveCount(3);
  for (const button of await buttons.all()) {
    const box = await button.boundingBox();
    expect(box!.width, '手机互动触区不应要求精确瞄准').toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
  await like().click();
  await expect(like()).toHaveAttribute('aria-pressed', 'true');
  await expect(like()).toContainText('129');
  await expect(favorite()).toHaveAttribute('aria-pressed', 'true');
  await favorite().click();
  await expect(favorite()).toHaveAttribute('aria-pressed', 'false');
  await expect(favorite()).toContainText('86');
  await expect(like()).toHaveAttribute('aria-pressed', 'true');
  await favorite().click();
  await expect(favorite()).toContainText('87');
  await expect(page).toHaveURL(/\/characters$/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await preview.screenshot('角色卡轻量互动栏', { fullPage: false });

  await card.getByRole('button', { name: '查看 林间旅人 的详情', exact: true }).click();
  const detail = page.getByRole('dialog');
  await expect(
    detail.getByRole('button', { name: '取消点赞 林间旅人', exact: true })
  ).toContainText('129');
  await expect(detail.getByRole('button', { name: '取消收藏', exact: true })).toContainText('87');
  await detail.getByRole('button', { name: '继续对话', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '输入消息', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '取消收藏', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await page.getByRole('button', { name: '返回发现', exact: true }).click();
  await expect(like()).toHaveAttribute('aria-pressed', 'true');
  await expect(favorite()).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('tab', { name: '已收藏', exact: true })).toHaveCount(0);
  await page.goto('/creation?tab=favorites');
  await expect(page.locator('[data-lobby-character-id]')).toHaveCount(1);
  await expect(card).toBeVisible();
  await expectMobileLayout(page);
});

test('@roleplay @character-social @layout 评论直达同层面板，分页发表删除举报可用', async ({
  page,
  preview,
}) => {
  await preview.scenario('character-social');
  await page.goto('/characters');
  const card = page.locator(`[data-lobby-character-id="${IDS.character}"]`);
  await card.getByRole('button', { name: '查看 林间旅人 的评论', exact: true }).click();
  const detail = page.getByRole('dialog');
  await expect(detail).toHaveCount(1);
  await expect(page).toHaveURL(/\/characters$/);
  await expect(detail.getByRole('tab', { name: '评论', exact: true })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  const input = detail.getByRole('textbox', { name: '公开角色评论', exact: true });
  await expect(input).not.toBeFocused();
  await expect(
    detail.getByText('这个角色会认真接住你的话，慢慢聊很有意思。', { exact: true })
  ).toBeVisible();
  await detail.getByRole('button', { name: '加载更多评论', exact: true }).click();
  await expect(
    detail.getByText('这是第 23 位演示玩家的角色体验。', { exact: true })
  ).toBeAttached();
  await input.fill('这位旅人的互动很自然。');
  await detail.getByRole('button', { name: '发表评论', exact: true }).click();
  await expect(input).toHaveValue('');
  await expect(detail.getByText('这位旅人的互动很自然。', { exact: true })).toHaveCount(1);
  await preview.screenshot('角色公开评论', { fullPage: false });
  await detail.getByRole('button', { name: '删除评论', exact: true }).click();
  await detail.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(detail.getByText('这位旅人的互动很自然。', { exact: true })).toHaveCount(0);
  await detail.getByRole('button', { name: '举报评论', exact: true }).first().click();
  await detail.getByRole('button', { name: '确认举报', exact: true }).click();
  await expect
    .poll(async () =>
      (await preview.state()).requests.some(
        (request) => request.method === 'POST' && request.path.endsWith('/report')
      )
    )
    .toBe(true);
  await detail.getByRole('button', { name: '关闭角色详情', exact: true }).click();
  await expect(page).toHaveURL(/\/characters$/);
  await expect(
    card.getByRole('button', { name: '查看 林间旅人 的评论', exact: true })
  ).toContainText('23');
  await expectMobileLayout(page);
});

test('@roleplay @character-social @layout 互动失败恢复，关面板后草稿重试不重复', async ({
  page,
  preview,
}) => {
  await preview.scenario('character-interaction-error');
  await page.goto('/characters');
  const card = page.locator(`[data-lobby-character-id="${IDS.character}"]`);
  const like = card.getByRole('button', { name: '点赞 林间旅人', exact: true });
  await expect(like).toBeEnabled();
  await like.click();
  await expect(like).toHaveAttribute('aria-pressed', 'false');
  await expect(like).toContainText('128');
  await expect
    .poll(
      async () =>
        (await preview.state()).requests.filter(
          (request) => request.method === 'PUT' && request.path.endsWith('/like')
        ).length
    )
    .toBe(1);
  await card.getByRole('button', { name: '收藏角色卡', exact: true }).click();
  await expect(card.getByRole('button', { name: '收藏角色卡', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false'
  );
  await expect(card.getByRole('button', { name: '收藏角色卡', exact: true })).toContainText('86');
  await expect
    .poll(
      async () =>
        (await preview.state()).requests.filter(
          (request) =>
            request.method === 'PUT' && request.path === `/api/favorites/${IDS.character}`
        ).length
    )
    .toBe(1);
  await card.getByRole('button', { name: '查看 林间旅人 的评论', exact: true }).click();
  const detail = page.getByRole('dialog');
  const input = detail.getByRole('textbox', { name: '公开角色评论', exact: true });
  const body = '这段对话让我很想继续探索，\n下次还要回来。';
  await input.fill(body);
  await detail.getByRole('button', { name: '发表评论', exact: true }).click();
  await expect(detail.getByRole('alert').filter({ hasText: '内容已保留' })).toBeVisible();
  await expect(input).toHaveValue(body);
  await detail.getByRole('button', { name: '关闭角色详情', exact: true }).click();
  await card.getByRole('button', { name: '查看 林间旅人 的评论', exact: true }).click();
  await expect(input).toHaveValue(body);
  const originalSize = page.viewportSize()!;
  await page.setViewportSize({ width: originalSize.width, height: 360 });
  const send = detail.getByRole('button', { name: '发表评论', exact: true });
  await expect(send).toBeInViewport();
  const box = await send.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await send.click();
  await expect(input).toHaveValue('');
  await expect(detail.getByText(body, { exact: true })).toHaveCount(1);
  await page.setViewportSize(originalSize);
  await detail.getByRole('button', { name: '关闭角色详情', exact: true }).click();
  await expect(
    card.getByRole('button', { name: '查看 林间旅人 的评论', exact: true })
  ).toContainText('24');
  await expectMobileLayout(page);
});

test('@roleplay @character-social @layout 草稿按角色保留，聊天面板关闭后原输入仍在', async ({
  page,
  preview,
}) => {
  await page.goto('/characters');
  const first = page.locator(`[data-lobby-character-id="${IDS.character}"]`);
  await first.getByRole('button', { name: '查看 林间旅人 的评论', exact: true }).click();
  const detail = page.getByRole('dialog');
  const input = detail.getByRole('textbox', { name: '公开角色评论', exact: true });
  await input.fill('这是留给林间旅人的草稿。');
  await detail.getByRole('tab', { name: '介绍', exact: true }).click();
  await detail.getByRole('tab', { name: '评论', exact: true }).click();
  await expect(input).toHaveValue('这是留给林间旅人的草稿。');
  await detail.getByRole('button', { name: '关闭角色详情', exact: true }).click();
  await page.getByRole('button', { name: '查看 故事旅人 2 的评论', exact: true }).click();
  await expect(input).toHaveValue('');
  await input.fill('这是另一位角色的草稿。');
  await detail.getByRole('button', { name: '关闭角色详情', exact: true }).click();
  await first.getByRole('button', { name: '查看 林间旅人 的详情', exact: true }).click();
  await detail.getByRole('button', { name: '继续对话', exact: true }).click();
  const chatInput = page.getByRole('textbox', { name: '输入消息', exact: true });
  await expect(chatInput).toBeVisible();
  await chatInput.fill('这条私人消息还没有发送。');
  const chatUrl = page.url();
  await page.getByRole('button', { name: '查看 林间旅人 的评论', exact: true }).click();
  await expect(input).toHaveValue('这是留给林间旅人的草稿。');
  await expect(input).not.toHaveValue('这条私人消息还没有发送。');
  await expect(page).toHaveURL(chatUrl);
  await detail.getByRole('button', { name: '关闭角色详情', exact: true }).click();
  await expect(chatInput).toHaveValue('这条私人消息还没有发送。');
  await page.getByRole('button', { name: '查看 林间旅人 的详情', exact: true }).click();
  await expect(detail.getByRole('tab', { name: '介绍', exact: true })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await detail.getByRole('button', { name: '关闭角色详情', exact: true }).click();
  await page.getByRole('button', { name: '返回发现', exact: true }).click();
  await page.getByRole('button', { name: '查看 故事旅人 2 的评论', exact: true }).click();
  await expect(input).toHaveValue('这是另一位角色的草稿。');
  await expectMobileLayout(page);
  await preview.screenshot('角色评论草稿与聊天隔离', { fullPage: false });
});

test('@roleplay @character-social 打开评论不打断正在生成的角色回复', async ({ page, preview }) => {
  await preview.scenario('chat-slow');
  await page.goto(chatPath);
  await sendChat(page);
  await expect(page.getByLabel('思考内容', { exact: true })).toBeVisible();
  const originalUrl = page.url();
  await page.getByRole('button', { name: '查看 林间旅人 的评论', exact: true }).click();
  const detail = page.getByRole('dialog');
  await expect(detail.getByRole('textbox', { name: '公开角色评论', exact: true })).toBeVisible();
  const reply = page.getByText('「那就出发吧。」旅人轻轻合上地图，把下一步的选择留给你。', {
    exact: true,
  });
  await expect(reply).toBeAttached();
  await detail.getByRole('button', { name: '关闭角色详情', exact: true }).click();
  await expect(reply).toBeVisible();
  await expect(page).toHaveURL(originalUrl);
  expect(
    (await preview.state()).requests.filter(
      (item) => item.method === 'POST' && item.path.endsWith('/messages')
    )
  ).toHaveLength(1);
});

test.describe('初始 HTML 框架', () => {
  test.use({ javaScriptEnabled: false });

  for (const path of ['/', '/characters', '/dramas']) {
    test(`@startup @layout ${path} 无 JS 时仍有框架和主导航`, async ({ page, preview }) => {
      await page.goto(path);
      await expect(page.locator('[data-startup-shell]')).toBeVisible();
      await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'AI短剧', exact: true })).toBeVisible();
      if (path === '/') {
        await expect(page.getByText('加载中', { exact: true })).toHaveCount(0);
      }
      if (path === '/dramas') {
        await expect(page.getByRole('navigation', { name: '短剧栏目' })).toBeVisible();
        await expect(page.getByRole('button', { name: '搜索短剧' })).toBeVisible();
        await expect(page.getByLabel('短剧加载中', { exact: true })).toBeVisible();
      }
      expect((await preview.state()).requests).toEqual([]);
      await expectMobileLayout(page);
      await preview.screenshot(`初始框架${path === '/' ? '大厅' : '短剧'}`);
    });
  }
});
