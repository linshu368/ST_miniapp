import { previewAppUrl, previewApiUrl } from './fixtures';
import type { Locator, Page } from '@playwright/test';
import {
  test,
  expect,
  IDS,
  chatPath,
  studioPath,
  sendChat,
  expectMobileLayout,
} from './fixtures.js';

async function openRecommendedLobby(page: Page, path = '/characters'): Promise<void> {
  await page.goto(path, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  const latest = page.getByRole('tab', { name: '最新', exact: true });
  await expect(latest).toHaveAttribute('aria-selected', 'true');
  const recommended = page.getByRole('tab', { name: '推荐', exact: true });
  await recommended.click();
  await expect(recommended).toHaveAttribute('aria-selected', 'true');
}

test('@roleplay @layout 浏览角色时栏目固定，进聊天后可返回', async ({ page, preview }) => {
  // 自动验收会启动独立 Next dev；390 项目首次进入动态 chat 路由包含冷编译，
  // 这里验证功能链路，不把开发编译时间当作 production 导航预算。
  test.setTimeout(180_000);
  await openRecommendedLobby(page);
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
  await expect(page).toHaveURL(/\/chat\//, { timeout: 60_000 });
  await expect(page.getByRole('textbox', { name: '输入消息' })).toBeVisible();
  await page.getByRole('button', { name: /返回发现/ }).click();
  await expect(page).toHaveURL(`${previewAppUrl}/characters`);
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
  // 该综合场景会在独立 Next dev 进程中首次编译多个动态路由和社群 Sheet；
  // 保留每项断言原超时，只给串行冷编译留足总预算。
  test.setTimeout(180_000);
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
  const revealWindowListTail = async (target: Locator) => {
    await expect
      .poll(async () => {
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        return target.count();
      })
      .toBe(1);
  };
  const revealScrollableListTail = async (scroller: Locator, target: Locator) => {
    await expect
      .poll(async () => {
        await scroller.evaluate((node) => {
          node.scrollTop = node.scrollHeight;
        });
        return target.count();
      })
      .toBe(1);
  };

  await openRecommendedLobby(page);
  await expect(
    page.getByRole('button', { name: '查看 林间旅人 的详情', exact: true })
  ).toBeVisible();
  await checkNav('角色');
  await preview.screenshot('统一五入口角色页', { fullPage: false });
  const lastCharacter = page.getByRole('button', { name: '查看 故事旅人 18 的详情', exact: true });
  // 列表按平台分批挂载；持续滚动哨兵，模拟用户浏览到末项，而不是假定末项已在 DOM。
  await revealWindowListTail(lastCharacter);
  await lastCharacter.scrollIntoViewIfNeeded();
  await aboveNav(lastCharacter);
  const conversationTab = page
    .getByRole('navigation', { name: '角色栏目' })
    .getByRole('link', { name: '对话', exact: true });
  await conversationTab.scrollIntoViewIfNeeded();
  await conversationTab.click();
  await expect(page).toHaveURL(/\/chats$/);
  await checkNav('角色');
  await nav.getByRole('link', { name: 'AI短剧', exact: true }).click();
  await expect(page).toHaveURL(/\/dramas$/);
  await checkNav('AI短剧');
  const lastDrama = page.getByRole('link', { name: '观看 时光旅人', exact: true });
  await revealScrollableListTail(page.getByLabel('短剧列表', { exact: true }), lastDrama);
  await lastDrama.scrollIntoViewIfNeeded();
  await aboveNav(lastDrama);
  await nav.getByRole('link', { name: '首页', exact: true }).click();
  await expect(page).toHaveURL(`${previewAppUrl}/`);
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
  const communityEntry = page.getByRole('button', { name: /官方社群/ });
  await aboveNav(communityEntry);
  await communityEntry.click();
  const communitySheet = page.getByRole('dialog');
  await expect(communitySheet).toBeVisible();
  await expect(
    communitySheet.getByRole('heading', { name: '官方社群', exact: true })
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(communitySheet).toHaveCount(0);

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
  await openRecommendedLobby(page);
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
  await openRecommendedLobby(page);
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
  await openRecommendedLobby(page);
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
  await openRecommendedLobby(page);
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

test('@startup 后台归因模块下载失败仍可浏览与跳页，邀请参数已保存', async ({ page, preview }) => {
  let deferredRequests = 0;
  await page.route(/\/_next\/.*deferred-entry-effects.*\.js/, async (route) => {
    deferredRequests += 1;
    await route.abort('failed');
  });
  await page.goto('/characters?startapp=inv_Abcd1234');
  await expect(
    page.getByRole('button', { name: '查看 林间旅人 的详情', exact: true })
  ).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('invite_bind_pending'))).toBe('Abcd1234');
  await expect.poll(() => deferredRequests).toBeGreaterThan(0);
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('link', { name: 'AI短剧', exact: true })
    .click();
  await expect(page).toHaveURL(/\/dramas$/);
  await expect(page.getByRole('button', { name: '搜索短剧', exact: true })).toBeVisible();
  expect((await preview.state()).requests.some((request) => request.path === '/api/dramas')).toBe(
    true
  );
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

test('@startup 原生 ready 不等待 Next 启动 JS，恢复下载后仍能进入业务', async ({
  page,
  preview,
}) => {
  let release: () => void = () => {};
  const scriptsAllowed = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.addInitScript(() => {
    const native = window as Window & {
      __readyNotifications?: number;
      TelegramWebviewProxy?: { postEvent: (event: string) => void };
    };
    native.__readyNotifications = 0;
    native.TelegramWebviewProxy = {
      postEvent: (event) => {
        if (event === 'web_app_ready')
          native.__readyNotifications = (native.__readyNotifications ?? 0) + 1;
      },
    };
  });
  await page.route('**/_next/**/*.js*', async (route) => {
    await scriptsAllowed;
    await route.continue();
  });
  try {
    await page.goto('/#tgWebAppVersion=9.6&tgWebAppPlatform=android', { waitUntil: 'commit' });
    await expect(page.getByRole('heading', { name: '推荐', exact: true })).toBeVisible();
    await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as Window & { __miniappStartup?: { status?: string } }).__miniappStartup?.status
        )
      )
      .toBe('sent');
    expect((await preview.state()).requests).toEqual([]);
    expect(
      await page.evaluate(
        () => (window as Window & { __readyNotifications?: number }).__readyNotifications
      )
    ).toBe(1);
    await preview.screenshot('启动JS阻塞时框架已展示');
    await page.getByRole('link', { name: 'AI短剧', exact: true }).click();
    await expect(page).toHaveURL(`${previewAppUrl}/#tgWebAppVersion=9.6&tgWebAppPlatform=android`);
  } finally {
    release();
  }
  // Normal browser API fixtures do not provide Telegram's full native SDK. Remove
  // launch metadata after the isolated bridge assertion, then exercise normal content.
  await page.evaluate(() => history.replaceState(history.state, '', '/'));
  await expect
    .poll(async () => (await preview.state()).requests.some((r) => r.path === '/api/dramas'))
    .toBe(true);
  expect(
    await page.evaluate(
      () => (window as Window & { __readyNotifications?: number }).__readyNotifications
    )
  ).toBe(1);
  await page.getByRole('link', { name: 'AI短剧', exact: true }).click();
  await expect(page).toHaveURL(`${previewAppUrl}/dramas`);
  await expect(page.getByRole('button', { name: '搜索短剧', exact: true })).toBeVisible();
});

// These scenarios reuse the real gallery/hooks and local HTTP protocol, not a parallel page.
test('@roleplay @lobby-rotation @layout 换批保留质量分层入口，撤回恢复顺序', async ({
  page,
  preview,
}) => {
  await preview.scenario('lobby-rotation');
  await openRecommendedLobby(page);
  const rotate = page.getByRole('button', { name: '换一批推荐角色', exact: true });
  await expect(rotate).toBeVisible();
  const wishEntry = page.getByRole('link', { name: '许个愿', exact: true });
  const search = page.getByRole('textbox', { name: '搜索角色', exact: true });
  await expect(wishEntry).toBeInViewport();
  await expect(search).toBeInViewport();
  const box = await rotate.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(40);
  const wishBox = await wishEntry.boundingBox();
  const searchBox = await search.boundingBox();
  expect(wishBox!.height).toBeGreaterThanOrEqual(44);
  expect(wishBox!.width).toBeGreaterThanOrEqual(44);
  expect(wishBox!.x).toBeGreaterThanOrEqual(searchBox!.x + searchBox!.width);
  expect(
    Math.abs(wishBox!.y + wishBox!.height / 2 - searchBox!.y - searchBox!.height / 2)
  ).toBeLessThanOrEqual(2);
  expect(wishBox!.y + wishBox!.height).toBeLessThanOrEqual(box!.y);
  await expectMobileLayout(page);
  await preview.screenshot('搜索旁心愿入口与独立换批行', { fullPage: false });
  const before = (await preview.state()).lobby.current!;
  await expect
    .poll(() =>
      page.locator('[data-lobby-character-id]').first().getAttribute('data-lobby-character-id')
    )
    .toBe(before.character_ids[0]);
  await rotate.click();
  await expect.poll(async () => (await preview.state()).lobby.batches_created).toBe(2);
  const after = (await preview.state()).lobby.current!;
  expect(after.head_ids.filter((id) => before.head_ids.includes(id))).toHaveLength(0);
  expect(new Set(after.character_ids).size).toBe(after.character_ids.length);
  await expect
    .poll(() =>
      page.locator('[data-lobby-character-id]').first().getAttribute('data-lobby-character-id')
    )
    .toBe(after.character_ids[0]);
  await preview.screenshot('推荐换一批与撤回', { fullPage: false });
  await page.getByRole('button', { name: '撤回', exact: true }).click();
  await expect
    .poll(() =>
      page.locator('[data-lobby-character-id]').first().getAttribute('data-lobby-character-id')
    )
    .toBe(before.character_ids[0]);
  expect((await preview.state()).lobby.batches_created).toBe(2);
  await page.evaluate(() => window.scrollTo(0, 700));
  await expect(wishEntry).toBeInViewport();
  await expect(search).toBeInViewport();
  await expect(rotate).not.toBeInViewport();
  await expect(wishEntry).toHaveCount(1);
  await expectMobileLayout(page);
  await expect(page.getByRole('status').filter({ hasText: '已回到上一批' })).not.toBeVisible();
  await preview.screenshot('下滑后搜索与心愿入口保持可见', { fullPage: false });
});

test('@roleplay @lobby-rotation 超过24小时试聊返回仍保原批，新打开才轮换', async ({
  page,
  preview,
  request,
}) => {
  test.setTimeout(90_000);
  await preview.scenario('lobby-rotation');
  await openRecommendedLobby(page);
  await expect(page.getByRole('button', { name: '换一批推荐角色', exact: true })).toBeVisible();
  const first = (await preview.state()).lobby.current!;
  await page.reload();
  await expect(page.getByRole('button', { name: '换一批推荐角色', exact: true })).toBeVisible();
  expect((await preview.state()).lobby.current!.batch_id).toBe(first.batch_id);
  await page.getByRole('button', { name: '查看 林间旅人 的详情', exact: true }).click();
  await page.getByRole('button', { name: /继续对话|开始对话|开始聊天|接着聊/ }).click();
  await expect(page.getByRole('textbox', { name: '输入消息' })).toBeVisible();
  await request.post(`${previewApiUrl}/__preview/lobby`, { data: { advance_hours: 25 } });
  await page.getByRole('button', { name: /返回发现/ }).click();
  await expect(page.getByRole('button', { name: '换一批推荐角色', exact: true })).toBeVisible();
  await expect
    .poll(() =>
      page.locator('[data-lobby-character-id]').first().getAttribute('data-lobby-character-id')
    )
    .toBe(first.character_ids[0]);
  expect((await preview.state()).lobby.batches_created).toBe(1);
  await page.reload();
  await expect.poll(async () => (await preview.state()).lobby.batches_created).toBe(2);
  const next = (await preview.state()).lobby.current!;
  await expect
    .poll(() =>
      page.locator('[data-lobby-character-id]').first().getAttribute('data-lobby-character-id')
    )
    .toBe(next.character_ids[0]);
});

for (const scenario of ['lobby-rotation-error', 'lobby-rotation-lost-response'] as const) {
  test(`@roleplay @lobby-rotation ${scenario} 保留旧卡并用同请求重试`, async ({
    page,
    preview,
  }) => {
    await preview.scenario(scenario);
    await openRecommendedLobby(page);
    const rotate = page.getByRole('button', { name: '换一批推荐角色', exact: true });
    await expect(rotate).toBeVisible();
    const first = (await preview.state()).lobby.current!;
    await rotate.click();
    await expect(rotate).toBeEnabled();
    await expect
      .poll(
        async () =>
          (await preview.state()).lobby.actions.filter((entry) => entry.action === 'refresh').length
      )
      .toBeGreaterThan(0);
    await expect
      .poll(() =>
        page.locator('[data-lobby-character-id]').first().getAttribute('data-lobby-character-id')
      )
      .toBe(first.character_ids[0]);
    await rotate.click();
    await expect.poll(async () => (await preview.state()).lobby.batches_created).toBe(2);
    const state = (await preview.state()).lobby;
    const refreshes = state.actions.filter((entry) => entry.action === 'refresh');
    expect(new Set(refreshes.map((entry) => entry.request_id)).size).toBe(1);
    await expect
      .poll(() =>
        page.locator('[data-lobby-character-id]').first().getAttribute('data-lobby-character-id')
      )
      .toBe(state.current!.character_ids[0]);
  });
}

test('@roleplay @lobby-rotation 只有实际看到的卡产生曝光，搜索和最新不换批', async ({
  page,
  preview,
}) => {
  await preview.scenario('lobby-rotation');
  await openRecommendedLobby(page);
  await expect(page.getByRole('button', { name: '换一批推荐角色', exact: true })).toBeVisible();
  await expect.poll(async () => (await preview.state()).lobby.exposures.length).toBeGreaterThan(0);
  const seen = (await preview.state()).lobby;
  expect(seen.exposures.length).toBeLessThan(12);
  expect(seen.exposures.every((entry) => seen.current!.head_ids.includes(entry.character_id))).toBe(
    true
  );
  await page.getByRole('textbox', { name: '搜索角色', exact: true }).fill('故事旅人 35');
  await expect(
    page.getByRole('button', { name: '查看 故事旅人 35 的详情', exact: true })
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '换一批推荐角色', exact: true })).not.toBeVisible();
  await page.getByRole('textbox', { name: '搜索角色', exact: true }).clear();
  await page.getByRole('tab', { name: /最新/ }).click();
  await expect(page.getByRole('button', { name: '换一批推荐角色', exact: true })).not.toBeVisible();
  expect((await preview.state()).lobby.batches_created).toBe(1);
});

test('@roleplay @lobby-rotation 下架只移除对应卡，其他卡和金框资格保持原序', async ({
  page,
  preview,
  request,
}) => {
  await preview.scenario('lobby-rotation');
  await openRecommendedLobby(page);
  await expect(page.getByRole('button', { name: '换一批推荐角色', exact: true })).toBeVisible();
  const first = (await preview.state()).lobby.current!;
  await request.post(`${previewApiUrl}/__preview/lobby`, {
    data: { remove_character_id: first.character_ids[1] },
  });
  await page.reload();
  const cards = page.locator('[data-lobby-character-id]');
  await expect
    .poll(() =>
      cards.evaluateAll((nodes) =>
        nodes.slice(0, 4).map((node) => node.getAttribute('data-lobby-character-id'))
      )
    )
    .toEqual([first.character_ids[0], ...first.character_ids.slice(2, 5)]);
  expect((await preview.state()).lobby.batches_created).toBe(1);
});

test('@roleplay @lobby-rotation 更换账号不读取上个账号的个人批次缓存', async ({
  page,
  preview,
}) => {
  await preview.scenario('lobby-rotation');
  const raw = (id: number) =>
    new URLSearchParams({ user: JSON.stringify({ id, first_name: '虚构验收用户' }) }).toString();
  await openRecommendedLobby(page, `/characters?tgWebAppData=${encodeURIComponent(raw(750001))}`);
  await expect(page.getByRole('button', { name: '换一批推荐角色', exact: true })).toBeVisible();
  const first = (await preview.state()).lobby.current!;
  const key = 'miniapp:lobby-recommendation:v1:';
  await expect
    .poll(() =>
      page.evaluate((prefix) => Object.keys(localStorage).filter((k) => k.startsWith(prefix)), key)
    )
    .toContain(`${key}750001`);
  // Same device storage survives while the next Telegram identity starts a new document.
  await page.evaluate(() => sessionStorage.clear());
  await openRecommendedLobby(page, `/characters?tgWebAppData=${encodeURIComponent(raw(750002))}`);
  await expect(page.getByRole('button', { name: '换一批推荐角色', exact: true })).toBeVisible();
  const state = (await preview.state()).lobby;
  const lastOpen = state.actions.filter((action) => action.action === 'open').at(-1)!;
  expect(lastOpen.expected_batch_id ?? null).toBeNull();
  await expect
    .poll(() =>
      page.evaluate((prefix) => Object.keys(localStorage).filter((k) => k.startsWith(prefix)), key)
    )
    .toContain(`${key}750002`);
  expect(first.batch_id).not.toBeNull();
});

test('@roleplay @lobby-rotation 撤回失效不误报成功，也不恢复旧位置', async ({
  page,
  preview,
  request,
}) => {
  await preview.scenario('lobby-rotation');
  await openRecommendedLobby(page);
  const rotate = page.getByRole('button', { name: '换一批推荐角色', exact: true });
  await expect(rotate).toBeVisible();
  await rotate.click();
  await expect(page.getByRole('button', { name: '撤回', exact: true })).toBeVisible();
  const current = (await preview.state()).lobby.current!;
  await request.post(`${previewApiUrl}/__preview/lobby`, { data: { advance_hours: 1 } });
  await page.getByRole('button', { name: '撤回', exact: true }).click();
  await expect(page.getByText('推荐已更新，暂时不能撤回', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '撤回', exact: true })).not.toBeVisible();
  await expect(page.getByText('已回到上一批', { exact: true })).not.toBeVisible();
  expect((await preview.state()).lobby.current!.batch_id).toBe(current.batch_id);
  await expect
    .poll(() =>
      page.locator('[data-lobby-character-id]').first().getAttribute('data-lobby-character-id')
    )
    .toBe(current.character_ids[0]);
});

test('@roleplay @lobby-rotation 新批次资料未到齐时不先画残缺卡片再重排', async ({
  page,
  preview,
  request,
}) => {
  await preview.scenario('lobby-rotation');
  const catalog = (await (await request.get(`${previewApiUrl}/api/characters`)).json()).data;
  await page.addInitScript(
    (cached) => {
      localStorage.setItem(
        'miniapp:lobby-characters:v4:recommended',
        JSON.stringify({ savedAt: Date.now(), data: cached })
      );
    },
    { characters: catalog.characters.slice(4) }
  );
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/lobby-characters?sort=recommended', async (route) => {
    await held;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: catalog }),
    });
  });
  await openRecommendedLobby(page);
  await expect.poll(async () => (await preview.state()).lobby.batches_created).toBe(1);
  await expect(page.locator('[data-lobby-character-id]')).toHaveCount(0);
  release();
  await expect(page.getByRole('button', { name: '换一批推荐角色', exact: true })).toBeVisible();
  await expect
    .poll(() =>
      page.locator('[data-lobby-character-id]').first().getAttribute('data-lobby-character-id')
    )
    .toBe(catalog.characters[0].id);
});

test('@roleplay @lobby-rotation 换批缺新卡资料时保旧，资料失败后同请求再试', async ({
  page,
  preview,
  request,
}) => {
  await preview.scenario('lobby-rotation');
  const catalog = (await (await request.get(`${previewApiUrl}/api/characters`)).json()).data;
  let phase: 'initial' | 'fail' | 'ready' = 'initial';
  await page.route('**/api/lobby-characters?sort=recommended', async (route) => {
    if (phase === 'fail') {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          success: false,
          error: { code: 'UNAVAILABLE', message: 'fixture catalogue unavailable' },
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          characters: phase === 'initial' ? catalog.characters.slice(0, 12) : catalog.characters,
        },
      }),
    });
  });
  await openRecommendedLobby(page);
  const rotate = page.getByRole('button', { name: '换一批推荐角色', exact: true });
  await expect(rotate).toBeVisible();
  phase = 'fail';
  await rotate.click();
  await expect(page.getByText('没换成功，原来的还在', { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      page.locator('[data-lobby-character-id]').first().getAttribute('data-lobby-character-id')
    )
    .toBe(catalog.characters[0].id);
  phase = 'ready';
  await rotate.click();
  await expect
    .poll(() =>
      page.locator('[data-lobby-character-id]').first().getAttribute('data-lobby-character-id')
    )
    .toBe(catalog.characters[12].id);
  const state = (await preview.state()).lobby;
  expect(state.batches_created).toBe(2);
  expect(
    new Set(
      state.actions
        .filter((action) => action.action === 'refresh')
        .map((action) => action.request_id)
    ).size
  ).toBe(1);
});
