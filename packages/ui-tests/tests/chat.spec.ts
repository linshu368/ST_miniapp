import { previewApiUrl } from './fixtures';
import { test, expect, chatPath, sendChat, expectMobileLayout } from './fixtures.js';
import type { ReportFirstTokenRequest } from '@miniapp/shared';
import type { ForkConversationData, ListConversationsData } from '@miniapp/shared';
import type { Page } from '@playwright/test';
import { IDS } from './fixtures.js';
import { CHAT_SESSION_IDS, LONG_SESSION_TITLE, SURPLUS_PREVIEW_MODEL } from '../fixtures/data.js';

function likeResponse(page: Page) {
  return page.waitForResponse(
    (response) => response.url().endsWith('/like') && response.request().method() === 'PUT'
  );
}

test('@chat @surplus @layout Surplus Intelligence 目录、发送、重答与取消沿用真实页面', async ({
  page,
  preview,
  request,
}) => {
  await preview.scenario('chat-surplus');
  const catalog = (await (await request.get(`${previewApiUrl}/api/v1/models/config`)).json()).data;
  expect(catalog).toMatchObject({
    selected_provider: SURPLUS_PREVIEW_MODEL.provider,
    selected_provider_model_id: SURPLUS_PREVIEW_MODEL.provider_model_id,
  });
  await page.goto(chatPath);
  await page.getByRole('button', { name: /展开引擎选择/ }).click();
  await expect(page.getByText('Surplus Intelligence', { exact: true }).first()).toBeVisible();
  await page.keyboard.press('Escape');
  const answer = page.getByText('「那就出发吧。」旅人轻轻合上地图，把下一步的选择留给你。', {
    exact: true,
  });
  await sendChat(page, '我们用 Surplus Intelligence 继续故事。');
  await expect(answer).toBeVisible();
  await expect(page.getByRole('button', { name: '取消本次回复', exact: true })).toHaveCount(0);
  const regenerated = page.waitForResponse(
    (response) => response.url().endsWith('/regenerate') && response.request().method() === 'POST'
  );
  await page.getByRole('button', { name: '换一个回复', exact: true }).click();
  const generation = await regenerated;
  expect(generation.ok()).toBeTruthy();
  await expect
    .poll(async () => {
      const current = (
        await (await request.get(`${previewApiUrl}/api/v1/conversations/${IDS.session}`)).json()
      ).data;
      const last = current.messages.at(-1);
      return { revision: last?.revision, status: last?.status };
    })
    .toEqual({ revision: 2, status: 'complete' });
  await expect(page.getByRole('button', { name: '取消本次回复', exact: true })).toHaveCount(0);
  await expect(answer).toHaveCount(1);
  const detail = (
    await (await request.get(`${previewApiUrl}/api/v1/conversations/${IDS.session}`)).json()
  ).data;
  expect(detail.messages.at(-1)).toMatchObject({
    model_id: SURPLUS_PREVIEW_MODEL.id,
    revision: 2,
    status: 'complete',
  });
  const started = page.waitForResponse(
    (response) => response.url().endsWith('/messages') && response.request().method() === 'POST'
  );
  await sendChat(page, '这一轮先停下来。');
  expect((await started).ok()).toBeTruthy();
  const cancelled = page.waitForResponse(
    (response) => response.url().endsWith('/cancel') && response.request().method() === 'POST'
  );
  await page.getByRole('button', { name: '取消本次回复', exact: true }).click();
  expect((await cancelled).ok()).toBeTruthy();
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeVisible();
  const stopped = (
    await (await request.get(`${previewApiUrl}/api/v1/conversations/${IDS.session}`)).json()
  ).data;
  expect(stopped.messages.at(-1)).toMatchObject({
    model_id: SURPLUS_PREVIEW_MODEL.id,
    status: 'interrupted',
    finish_reason: 'user_cancelled',
  });
  await page.reload();
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeVisible();
  expect((await preview.state()).wallet.credits).toBe(3600);
  await expectMobileLayout(page);
  await preview.screenshot('Surplus Intelligence 重答与停止');
});

test('@chat @surplus @layout Surplus 慢主调用由 OpenRouter 兜底交付且不改变模型选择', async ({
  page,
  preview,
  request,
}) => {
  await preview.scenario('chat-surplus-fallback');
  await page.goto(chatPath);
  await page.getByRole('button', { name: '关闭深度思考', exact: true }).click();
  await sendChat(page, '等一会儿，也请把故事接下去。');
  await expect(
    page.getByText('「那就出发吧。」旅人轻轻合上地图，把下一步的选择留给你。', { exact: true })
  ).toBeVisible();
  const detail = (
    await (await request.get(`${previewApiUrl}/api/v1/conversations/${IDS.session}`)).json()
  ).data;
  expect(detail.messages.at(-1)).toMatchObject({
    model_id: 'preview-light',
    status: 'complete',
    finish_reason: 'stop',
  });
  const catalog = (await (await request.get(`${previewApiUrl}/api/v1/models/config`)).json()).data;
  expect(catalog).toMatchObject({
    selected_model_id: SURPLUS_PREVIEW_MODEL.id,
    selected_provider: 'surplus',
  });
  expect(
    (await preview.state()).requests.filter(
      (item) => item.method === 'POST' && item.path.endsWith('/messages')
    )
  ).toHaveLength(1);
  await page.reload();
  await expect(
    page.getByText('「那就出发吧。」旅人轻轻合上地图，把下一步的选择留给你。', { exact: true })
  ).toHaveCount(1);
  await expectMobileLayout(page);
  await preview.screenshot('Surplus Intelligence 选择与兜底回复');
});

test('@chat @chat-like @layout 回复点赞有48px触区，轻点立即反馈并持久保存', async ({
  page,
  preview,
}) => {
  await page.goto('/characters');
  await page.getByRole('tab', { name: '推荐', exact: true }).click();
  const card = page.locator(`[data-lobby-character-id="${IDS.character}"]`);
  const characterLike = card.getByRole('button', { name: '点赞 林间旅人', exact: true });
  await expect(characterLike).toContainText('128');
  await card.getByRole('button', { name: '查看 林间旅人 的详情', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '继续对话', exact: true }).click();
  await page.waitForURL(/\/chat\//);
  const like = page.getByTitle('赞第 1 轮回复', { exact: true });
  await like.scrollIntoViewIfNeeded();
  const box = await like.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(48);
  expect(box?.height).toBeGreaterThanOrEqual(48);
  await page.getByRole('textbox', { name: '输入消息' }).fill('点赞不影响我正在写的话');
  const saved = likeResponse(page);
  await like.click({ position: { x: 4, y: 24 } });
  await expect(like).toHaveAttribute('aria-pressed', 'true');
  expect((await saved).ok()).toBeTruthy();
  await expect(page.getByRole('textbox', { name: '输入消息' })).toHaveValue(
    '点赞不影响我正在写的话'
  );
  await preview.screenshot('回复点赞选中');
  await page.getByRole('button', { name: '返回发现', exact: true }).click();
  await expect(characterLike).toContainText('129');
  await expect(characterLike).toHaveAttribute('aria-pressed', 'false');
  await card.getByRole('button', { name: '查看 林间旅人 的详情', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '继续对话', exact: true }).click();
  await page.waitForURL(/\/chat\//);
  await page.reload();
  await expect(like).toHaveAttribute('aria-pressed', 'true');
  const removed = likeResponse(page);
  await like.click();
  expect((await removed).ok()).toBeTruthy();
  await expect(like).toHaveAttribute('aria-pressed', 'false');
  await page.reload();
  await expect(like).toHaveAttribute('aria-pressed', 'false');
  expect((await preview.state()).wallet.credits).toBe(3600);
  await page.getByRole('button', { name: '返回发现', exact: true }).click();
  await expect(characterLike).toContainText('128');
  await expectMobileLayout(page);
});

test('@chat @chat-like @layout 点赞失败恢复未赞状态，再试不打断输入', async ({ page, preview }) => {
  await preview.scenario('chat-like-error');
  await page.goto(chatPath);
  await page.getByRole('textbox', { name: '输入消息' }).fill('我还在想下一句');
  const like = page.getByTitle('赞第 1 轮回复', { exact: true });
  const failed = likeResponse(page);
  await like.click();
  expect((await failed).status()).toBe(503);
  await expect(like).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByText('点赞没能保存，请再试一次。', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '输入消息' })).toHaveValue('我还在想下一句');
  const retry = likeResponse(page);
  await like.click();
  expect((await retry).ok()).toBeTruthy();
  await expect(like).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('点赞没能保存，请再试一次。', { exact: true })).toHaveCount(0);
  await expectMobileLayout(page);
});

test('@chat @chat-like 历史回复可点赞，分支与重新生成各自独立', async ({
  page,
  preview,
  request,
}) => {
  await preview.scenario('chat-branch');
  await page.goto(chatPath);
  await loadBranchTurn(page, 20);
  const sourceLike = page.getByTitle('赞第 20 轮回复', { exact: true });
  const saved = likeResponse(page);
  await sourceLike.click();
  expect((await saved).ok()).toBeTruthy();
  await expect(sourceLike).toHaveAttribute('aria-pressed', 'true');
  const branch = await openBranch(page, 20);
  const inheritedLike = page.getByTitle('赞第 20 轮回复', { exact: true });
  await expect(inheritedLike).toHaveAttribute('aria-pressed', 'false');
  const branchSaved = likeResponse(page);
  await inheritedLike.click();
  expect((await branchSaved).ok()).toBeTruthy();
  await page.getByRole('button', { name: '换一个回复', exact: true }).click();
  await expect(
    page.getByText('「那就出发吧。」旅人轻轻合上地图，把下一步的选择留给你。', { exact: true })
  ).toBeVisible();
  await expect(inheritedLike).toHaveAttribute('aria-pressed', 'false');
  await page.reload();
  await expect(inheritedLike).toHaveAttribute('aria-pressed', 'false');
  const original = await request.get(
    `${previewApiUrl}/api/v1/conversations/${IDS.session}?before_turn_index=21`
  );
  const detail = (await original.json()).data as import('@miniapp/shared').GetConversationData;
  expect(detail.messages.find((m) => m.id === branch.messages.at(-1)?.id)?.liked).toBe(true);
});

async function loadBranchTurn(page: Page, turn: number) {
  const button = page.getByRole('button', { name: `第${turn}轮角色回复操作`, exact: true });
  for (let count = 0; count < 9; count += 1) {
    if (await button.count()) return button;
    const loaded = page.waitForResponse(
      (response) =>
        response.url().includes('before_turn_index=') && response.request().method() === 'GET'
    );
    await page.getByRole('button', { name: '查看更早的消息', exact: true }).click();
    await loaded;
    await expect(page.getByRole('button', { name: '加载中', exact: true })).toHaveCount(0);
  }
  throw new Error(`第 ${turn} 轮没有加载出来`);
}

async function openBranch(page: Page, turn: number): Promise<ForkConversationData> {
  const button = await loadBranchTurn(page, turn);
  const response = page.waitForResponse(
    (item) => item.url().endsWith('/branch') && item.request().method() === 'POST'
  );
  await button.click();
  await page.getByRole('button', { name: /分支到新聊天/ }).click();
  const result = await response;
  expect(result.ok()).toBeTruthy();
  const body = (await result.json()) as { data: ForkConversationData };
  await expect(page).toHaveURL(new RegExp(`session=${body.data.session.id}`));
  return body.data;
}

test('@chat @chat-branch @layout 200轮回到第20轮分支，原对话和草稿保留在列表', async ({
  page,
  preview,
  request,
}) => {
  await preview.scenario('chat-branch');
  await page.goto(chatPath);
  await expect(
    page.getByRole('button', { name: '第200轮角色回复操作', exact: true })
  ).toBeAttached();
  await page.getByRole('textbox', { name: '输入消息' }).fill('留在原对话的想法');
  const button = await loadBranchTurn(page, 20);
  await button.scrollIntoViewIfNeeded();
  const box = await button.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(44);
  expect(box?.height).toBeGreaterThanOrEqual(44);
  await preview.screenshot('历史回复的分支入口');
  const result = await openBranch(page, 20);
  expect(result.session.branch).toMatchObject({
    source_session_id: IDS.session,
    source_turn_index: 20,
    inherited_turns: 20,
  });
  expect(
    result.messages.filter((message) => message.role === 'assistant' && message.turn_index > 0)
  ).toHaveLength(20);
  expect(result.has_more).toBe(false);
  expect(result.messages.at(-1)?.content).toContain('第 20 轮');
  await expect(page.getByRole('textbox', { name: '输入消息' })).toHaveValue('');
  await expect(page.getByText(/这是第 200 轮的故事/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: '返回原对话' })).toHaveCount(0);
  expect((await preview.state()).wallet.credits).toBe(3600);
  await expectMobileLayout(page);
  await preview.screenshot('已进入独立分支');
  await sendChat(page, '我们从这里走另一条路。');
  await expect(
    page.getByText('「那就出发吧。」旅人轻轻合上地图，把下一步的选择留给你。', { exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: '第21轮角色回复操作', exact: true })
  ).toBeAttached();
  await page.reload();
  await expect(
    page.getByRole('button', { name: '第21轮角色回复操作', exact: true })
  ).toBeAttached();
  await page.getByRole('button', { name: '对话记录', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '对话记录' });
  await expect(
    drawer
      .getByTestId(`session-row-${result.session.id}`)
      .getByText('从第20轮分出', { exact: true })
  ).toBeVisible();
  await preview.screenshot('原对话与新分支并列');
  await drawer
    .getByTestId(`session-row-${IDS.session}`)
    .getByRole('button', { name: /^打开对话/ })
    .click();
  await expect(page).toHaveURL(new RegExp(`session=${IDS.session}`));
  // Reload deliberately starts a new in-memory draft lifetime; verify the source conversation itself survived.
  await expect(
    page.getByRole('button', { name: '第200轮角色回复操作', exact: true })
  ).toBeAttached();
  const listed = await request.get(`${previewApiUrl}/api/v1/conversations`);
  const sessions = ((await listed.json()) as { data: ListConversationsData }).data.sessions;
  expect(sessions).toHaveLength(2);
  expect(sessions.find((item) => item.id === IDS.session)?.message_count).toBe(400);
});

test('@chat @chat-branch 最新轮分支仅继承50轮，分支再分支与重答不改变原会话', async ({
  page,
  preview,
  request,
}) => {
  await preview.scenario('chat-branch');
  await page.goto(chatPath);
  await expect(
    page.getByRole('button', { name: '第200轮角色回复操作', exact: true })
  ).toBeAttached();
  const branch = await openBranch(page, 200);
  expect(branch.session.branch?.inherited_turns).toBe(50);
  expect(branch.session.message_count).toBe(100);
  expect(branch.has_more).toBe(true);
  await loadBranchTurn(page, 1);
  await expect(page.getByText(/这是第 151 轮的故事/)).toBeAttached();
  await expect(page.getByText(/这是第 150 轮的故事/)).toHaveCount(0);
  const nested = await openBranch(page, 50);
  expect(nested.session.branch?.source_session_id).toBe(branch.session.id);
  expect(nested.session.branch?.inherited_turns).toBe(50);
  await page.getByRole('button', { name: '换一个回复', exact: true }).click();
  await expect(
    page.getByText('「那就出发吧。」旅人轻轻合上地图，把下一步的选择留给你。', { exact: true })
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByText('「那就出发吧。」旅人轻轻合上地图，把下一步的选择留给你。', { exact: true })
  ).toBeVisible();
  const original = await request.get(`${previewApiUrl}/api/v1/conversations/${IDS.session}`);
  const unchanged = ((await original.json()) as { data: ForkConversationData }).data;
  expect(unchanged.messages.at(-1)?.content).toContain('第 200 轮的故事');
  expect(unchanged.session.message_count).toBe(400);
});

test('@chat @chat-branch @layout 分支丢响应重试不重复建对话，失败保留草稿', async ({
  page,
  preview,
  request,
}) => {
  await preview.scenario('chat-branch-error');
  const keys: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/branch'))
      keys.push((request.postDataJSON() as { request_id: string }).request_id);
  });
  await page.goto(chatPath);
  await expect(
    page.getByRole('button', { name: '第20轮角色回复操作', exact: true })
  ).toBeAttached();
  await page.getByRole('textbox', { name: '输入消息' }).fill('这段还没发出去');
  const failed = page.waitForResponse(
    (response) => response.url().endsWith('/branch') && response.status() === 503
  );
  await page.getByRole('button', { name: '第20轮角色回复操作', exact: true }).click();
  await page.getByRole('button', { name: /分支到新聊天/ }).click();
  await failed;
  await expect(page.getByRole('textbox', { name: '输入消息' })).toHaveValue('这段还没发出去');
  await expect(page).toHaveURL(new RegExp(`session=${IDS.session}`));
  await expect(page.getByRole('button', { name: '第20轮角色回复操作', exact: true })).toBeEnabled();
  await preview.screenshot('分支失败保留对话和输入');
  await openBranch(page, 20);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  const listed = await request.get(`${previewApiUrl}/api/v1/conversations`);
  expect(((await listed.json()) as { data: ListConversationsData }).data.sessions).toHaveLength(2);
  await page.getByRole('button', { name: '对话记录', exact: true }).click();
  await page
    .getByRole('dialog', { name: '对话记录' })
    .getByTestId(`session-row-${IDS.session}`)
    .getByRole('button', { name: /^打开对话/ })
    .click();
  await expect(page.getByRole('textbox', { name: '输入消息' })).toHaveValue('这段还没发出去');
  await expectMobileLayout(page);
});

test('@chat 同批文字后报错仍保留回复，首字不会误判为无字失败', async ({ page, preview }) => {
  await preview.scenario('chat-partial-error');
  const reports: ReportFirstTokenRequest[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/first-token'))
      reports.push(request.postDataJSON() as ReportFirstTokenRequest);
  });
  await page.goto(chatPath);
  await page.getByRole('button', { name: '关闭深度思考', exact: true }).click();
  await sendChat(page);
  await expect(page.getByText('旅人已经说出口的话会留在这里。', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '输入消息' })).toBeEnabled();
  await expect.poll(() => reports.length).toBe(1);
  expect(reports[0]).toMatchObject({
    measurement_method: 'client_committed_v4',
    outcome: 'observed',
  });
  await page.reload();
  await expect(page.getByText('旅人已经说出口的话会留在这里。', { exact: true })).toBeVisible();
  expect(reports).toHaveLength(1);
  await preview.screenshot('同批流错误保留已收到文字');
});

test('@chat 首字交付不等待滚回最新消息，单轮只回报一次', async ({ page, preview }) => {
  await preview.scenario('chat-slow');
  const reports: ReportFirstTokenRequest[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/first-token'))
      reports.push(request.postDataJSON() as ReportFirstTokenRequest);
  });
  await page.goto(chatPath);
  await page.getByRole('button', { name: '关闭深度思考', exact: true }).click();
  // The long user message leaves the arriving answer below the scroll viewport.
  await sendChat(page, Array(60).fill('旅人继续讲述沿途的故事。').join('\n'));
  const scroller = page.locator('div.chat-scroll-area');
  await expect
    .poll(() => scroller.evaluate((node) => node.scrollHeight - node.clientHeight))
    .toBeGreaterThan(500);
  await scroller.evaluate((node) => {
    node.scrollTop = 0;
    node.dispatchEvent(new Event('scroll'));
  });
  await expect.poll(() => reports.length).toBe(1);
  expect(reports[0]).toMatchObject({
    measurement_method: 'client_committed_v4',
    outcome: 'observed',
    backgrounded: false,
  });
  expect(reports[0]!.first_token_visible_ms).toBeLessThan(10_000);
  const answer = page.getByText('「那就出发吧。」旅人轻轻合上地图，把下一步的选择留给你。', {
    exact: true,
  });
  await expect(answer).toBeAttached();
  await expect(answer).not.toBeInViewport();
  await scroller.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
    node.dispatchEvent(new Event('scroll'));
  });
  await expect(answer).toBeInViewport();
  expect(reports).toHaveLength(1);
  await preview.screenshot('滚动位置不改变首字交付');
});

test('@chat 首字迟到只提示网络慢，回复到达后提示消失且不误报重试', async ({ page, preview }) => {
  await preview.scenario('chat-late-first-token');
  await page.goto(chatPath);
  await page.getByRole('button', { name: '关闭深度思考', exact: true }).click();
  await sendChat(page, '这条回复会晚一点到');
  const slowNotice = page.getByText('网络有点慢，正在接收回复', { exact: true });
  await expect(slowNotice).toBeVisible();
  await expect(page.getByText('这次回应稍慢，再试一次吧', { exact: true })).toHaveCount(0);
  await preview.screenshot('首字迟到时的网络提示');
  await expect(
    page.getByText('「那就出发吧。」旅人轻轻合上地图，把下一步的选择留给你。', { exact: true })
  ).toBeAttached();
  await expect(slowNotice).toHaveCount(0);
  await expect(page.getByText('这次回应稍慢，再试一次吧', { exact: true })).toHaveCount(0);
});

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
  // The final text precedes SSE done; wait for terminal auto-collapse before reopening it.
  await expect(page.getByRole('button', { name: '取消本次回复', exact: true })).toHaveCount(0);
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
  await page.getByRole('button', { name: '工具箱', exact: true }).click();
  await expect(page.getByRole('heading', { name: '工具箱', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: '工具箱', exact: true })).toHaveCount(0);
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

test('@chat @chat-edit @layout 最近十轮就地编辑、取消及删除单条，保留后续和输入草稿', async ({
  page,
  preview,
  request,
}) => {
  await preview.scenario('chat-edit');
  await page.goto(chatPath);
  await expect(page.getByRole('button', { name: '第12轮角色回复操作', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '第2轮我的消息操作', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '第3轮角色回复操作', exact: true })).toHaveCount(1);
  await page.getByRole('textbox', { name: '输入消息' }).fill('我还没发送的内容');
  const editButton = page.getByRole('button', { name: '编辑第11轮角色正文', exact: true });
  await editButton.scrollIntoViewIfNeeded();
  const editBox = await editButton.boundingBox();
  expect(editBox?.width).toBeGreaterThanOrEqual(44);
  expect(editBox?.height).toBeGreaterThanOrEqual(44);
  await editButton.click();
  const editor = page.getByRole('textbox', { name: '编辑角色回复' });
  await expect(editor).not.toHaveValue(/\[status\]|\[memory\]|\[choice\]|<details>/);
  await expect(editor).toBeFocused();
  await editor.fill('「换个方向聊。」\n旅人把地图递给你，等待你的选择。');
  const originalViewport = page.viewportSize()!;
  await page.setViewportSize({ width: originalViewport.width, height: 340 });
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeInViewport();
  await expectMobileLayout(page);
  await page.setViewportSize(originalViewport);

  await preview.screenshot('角色回复就地编辑');
  await expectMobileLayout(page);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.getByText('第 12 轮', { exact: false }).first()).toHaveCount(1);
  await expect(page.getByRole('textbox', { name: '输入消息' })).toHaveValue('我还没发送的内容');
  await page.getByRole('button', { name: '第11轮我的消息操作', exact: true }).click();
  await page.getByRole('button', { name: '编辑消息', exact: true }).click();
  await page.getByRole('textbox', { name: '编辑我的消息' }).fill('不保存这个修改');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByText('第 11 轮：我们继续走到这里。', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '第10轮我的消息操作', exact: true }).click();
  await page.getByRole('button', { name: '编辑消息', exact: true }).click();
  await page.getByRole('textbox', { name: '编辑我的消息' }).fill('我的修改也保存在这一条。');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('我的修改也保存在这一条。', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: '第11轮我的消息操作', exact: true }).click();
  await page.getByRole('button', { name: '删除这条', exact: true }).click();
  await expect(page.getByTestId('message-delete-confirm')).toContainText('确认吗？');
  await page
    .getByTestId('message-delete-confirm')
    .getByRole('button', { name: '取消', exact: true })
    .click();
  await expect(page.getByTestId('message-delete-confirm')).toHaveCount(0);
  await page.getByRole('button', { name: '删除这条', exact: true }).click();
  await preview.screenshot('轻量删除确认');
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(page.getByText('第 11 轮：我们继续走到这里。', { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByText('第 11 轮：我们继续走到这里。', { exact: true })).toHaveCount(0);
  await expect(page.getByText('「换个方向聊。」', { exact: false }).first()).toHaveCount(1);
  await expect(page.getByRole('button', { name: '第12轮角色回复操作', exact: true })).toHaveCount(
    1
  );
  const stored = (
    await (await request.get(`${previewApiUrl}/api/v1/conversations/${IDS.session}`)).json()
  ).data as import('@miniapp/shared').GetConversationData;
  const edited = stored.messages.find(
    (message: { turn_index: number; role: string }) =>
      message.turn_index === 11 && message.role === 'assistant'
  );
  expect(edited?.content).toContain('[memory]');
  expect(edited?.content).toContain('地点：林间小路');
  expect((await preview.state()).wallet.credits).toBe(3600);
});

test('@chat @chat-edit @layout 保存失败保留编辑输入，可再次保存', async ({ page, preview }) => {
  await preview.scenario('chat-edit-error');
  await page.goto(chatPath);
  await page.getByRole('button', { name: '编辑第12轮角色正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '编辑角色回复' });
  await expect(editor).not.toHaveValue(/\[status\]|\[memory\]|\[choice\]|<details>/);
  await editor.fill('保留这段修改，不要丢失。');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByTestId('message-inline-editor').getByRole('alert')).toContainText(
    '保存失败'
  );
  await expect(editor).toHaveValue('保留这段修改，不要丢失。');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.getByText('保留这段修改，不要丢失。', { exact: true })).toBeVisible();
  await expectMobileLayout(page);
});

test('@chat @chat-sessions @layout 同角色多段对话可区分，收纳管理不打断聊天', async ({
  page,
  preview,
  request,
}) => {
  await preview.scenario('chat-sessions');
  const listSessions = async () => {
    const response = await request.get(`${previewApiUrl}/api/v1/conversations`);
    expect(response.ok()).toBeTruthy();
    return ((await response.json()) as { data: ListConversationsData }).data.sessions;
  };
  const initial = await listSessions();
  await page.goto(chatPath);
  await page.getByRole('button', { name: '对话记录', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '对话记录' });
  const row = (id: string) => drawer.getByTestId(`session-row-${id}`);
  const current = row(IDS.session);
  const earlier = row(CHAT_SESSION_IDS.earlier);
  const named = row(CHAT_SESSION_IDS.named);
  const defaultBranch = row(CHAT_SESSION_IDS.branch);
  await expect(current.getByText('当前', { exact: true })).toBeVisible();
  await expect(drawer.getByText('当前', { exact: true })).toHaveCount(1);
  const currentTitle = await current
    .getByRole('button', { name: /^打开对话/ })
    .getAttribute('aria-label');
  const earlierTitle = await earlier
    .getByRole('button', { name: /^打开对话/ })
    .getAttribute('aria-label');
  expect(currentTitle).toContain('11月2日');
  expect(earlierTitle).toContain('11月1日');
  expect(currentTitle).not.toBe(earlierTitle);
  await expect(
    named.getByRole('button', { name: `打开对话：${LONG_SESSION_TITLE}`, exact: true })
  ).toBeAttached();
  await expect(
    row(CHAT_SESSION_IDS.namedBranch).getByRole('button', {
      name: '打开对话：分支 · 雨夜的约定',
      exact: true,
    })
  ).toBeAttached();
  await expect(defaultBranch.getByText('从第20轮分出', { exact: true })).toBeAttached();
  expect((await listSessions()).map(({ id, title }) => ({ id, title }))).toEqual(
    initial.map(({ id, title }) => ({ id, title }))
  );
  expect((await preview.state()).requests.filter(({ method }) => method === 'PATCH')).toHaveLength(
    0
  );
  await expectMobileLayout(page);
  await expect.poll(async () => Math.round((await drawer.boundingBox())?.x ?? -1)).toBe(0);
  await preview.screenshot('同角色多段对话与分支来源');

  await named.getByRole('button', { name: '更多操作', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`session=${IDS.session}`));
  await expect(named.getByRole('button', { name: '取消置顶', exact: true })).toBeVisible();
  await named.getByRole('button', { name: '重命名', exact: true }).click();
  await named.getByRole('textbox', { name: '对话名称', exact: true }).fill('不保存的名字');
  await named.getByRole('button', { name: '取消', exact: true }).click();
  await expect(
    named.getByRole('button', { name: `打开对话：${LONG_SESSION_TITLE}`, exact: true })
  ).toBeVisible();
  expect((await listSessions()).find(({ id }) => id === CHAT_SESSION_IDS.named)?.title).toBe(
    LONG_SESSION_TITLE
  );
  await named.getByRole('button', { name: '更多操作', exact: true }).click();
  await named.getByRole('button', { name: '重命名', exact: true }).click();
  const renamed = '雨停之后，沿着熟悉的小路再出发';
  await named.getByRole('textbox', { name: '对话名称', exact: true }).fill(renamed);
  await named.getByRole('button', { name: '保存', exact: true }).click();
  await expect(
    named.getByRole('button', { name: `打开对话：${renamed}`, exact: true })
  ).toBeVisible();
  expect((await listSessions()).find(({ id }) => id === CHAT_SESSION_IDS.named)?.title).toBe(
    renamed
  );

  await earlier.getByRole('button', { name: '更多操作', exact: true }).click();
  await earlier.getByRole('button', { name: '置顶', exact: true }).click();
  await expect.poll(async () => (await listSessions())[0]?.id).toBe(CHAT_SESSION_IDS.earlier);
  await earlier.getByRole('button', { name: '更多操作', exact: true }).click();
  await expect(earlier.getByRole('button', { name: '取消置顶', exact: true })).toBeVisible();
  await earlier.getByRole('button', { name: '删除', exact: true }).click();
  await expect(earlier.getByText('删除这段对话？', { exact: true })).toBeVisible();
  await earlier.getByRole('button', { name: '取消', exact: true }).click();
  expect((await listSessions()).some(({ id }) => id === CHAT_SESSION_IDS.earlier)).toBeTruthy();
  expect((await preview.state()).requests.filter(({ method }) => method === 'DELETE')).toHaveLength(
    0
  );
  await expect(page).toHaveURL(new RegExp(`session=${IDS.session}`));
  await earlier.getByRole('button', { name: /^打开对话/ }).click();
  await expect(page).toHaveURL(new RegExp(`session=${CHAT_SESSION_IDS.earlier}`));
  await expect(drawer).not.toBeVisible();
  await page.getByRole('button', { name: '对话记录', exact: true }).click();
  await expect(earlier.getByText('当前', { exact: true })).toBeVisible();
  await expect(current.getByText('当前', { exact: true })).toHaveCount(0);
  await expectMobileLayout(page);
  await expect.poll(async () => Math.round((await drawer.boundingBox())?.x ?? -1)).toBe(0);
  await preview.screenshot('重命名置顶与切换后的对话记录');
});
