import type { Page } from '@playwright/test';
import { test, expect, chatPath, sendChat, expectMobileLayout } from './fixtures.js';

test('@onboarding @layout 新人先开聊，再看编辑与分支；返回能找到对话', async ({
  page,
  preview,
}) => {
  await preview.scenario('new-user');
  await page.goto('/characters');
  await expect(page.getByRole('tab', { name: '推荐', exact: true })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await expect(page.getByText('先找一个让你好奇的角色')).toBeVisible();
  await preview.screenshot('新人发现页');
  await expectMobileLayout(page);
  await page
    .locator('[data-lobby-character-id]')
    .first()
    .getByRole('button', { name: /^查看 .* 的详情$/ })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /开始对话|继续对话|开始聊天/ })
    .click();
  await page.waitForURL(/\/chat\//);
  await expect(page.getByText('说一句话，或写下你想做的事')).toBeVisible();
  const preferences = page.getByRole('region', { name: '回复偏好', exact: true });
  const togglePreferences = preferences.locator('button[aria-expanded]');
  await page.getByRole('button', { name: '展开回复偏好', exact: true }).click();
  await expect(togglePreferences).toHaveAttribute('aria-expanded', 'true');
  await expectMobileLayout(page);
  await preview.screenshot('新手一键展开回复偏好');
  expect((await preview.state()).requests.filter((item) => item.method === 'PATCH')).toEqual([]);
  await togglePreferences.click();
  await page.getByRole('textbox', { name: '输入消息' }).fill('我们一起去海边吧');
  await expect(page.getByRole('complementary', { name: '聊天上手提示' })).toHaveCount(0);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('聊偏了？你可以改', { exact: true })).toBeVisible();
  await preview.screenshot('第一轮后的玩法提示');
  await page.getByRole('button', { name: '编辑 / 分支' }).click();
  await expect(page.getByRole('dialog')).toContainText('最近 10 轮可改');
  await expect(page.getByRole('dialog')).toContainText('原对话留着');
  await preview.screenshot('编辑分支玩法说明');
  await page.getByRole('button', { name: '试试编辑', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '编辑角色回复' })).toBeVisible();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('complementary', { name: '聊天上手提示' })).toHaveCount(0);
  const actions = (await preview.state()).requests;
  expect(
    actions.filter((item) => item.method === 'PATCH' || item.path.endsWith('/branch'))
  ).toEqual([]);
  await page.getByRole('button', { name: '返回发现', exact: true }).click();
  await expect(page.getByText('刚才的故事，会一直留在这里')).toBeVisible();
  await page.getByRole('link', { name: '去看我的对话' }).click();
  await expect(page).toHaveURL(/\/chats/);
  await page.reload();
  await expect(page.getByRole('complementary', { name: '新手引导' })).toHaveCount(0);
  await expectMobileLayout(page);
});

test('@onboarding @layout 分支说明只打开更多菜单，跳过后仍可重看玩法', async ({
  page,
  preview,
}) => {
  await preview.scenario('new-user-replied');
  await page.goto(chatPath);
  await page.getByRole('button', { name: '编辑 / 分支' }).click();
  await page.getByRole('button', { name: '看看分支入口' }).click();
  await expect(page.getByRole('button', { name: /分支到新聊天/ })).toBeVisible();
  expect(
    (await preview.state()).requests.filter((item) => item.path.endsWith('/branch'))
  ).toHaveLength(0);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '工具箱', exact: true }).click();
  await page.getByRole('button', { name: /玩法小贴士/ }).click();
  await expect(page.getByRole('dialog')).toContainText('改改你或角色的话');
  await expectMobileLayout(page);
});

test('@onboarding 跳过后刷新和换角色不重来', async ({ page, preview }) => {
  await preview.scenario('new-user');
  await page.goto('/characters');
  await page.getByRole('button', { name: '跳过新手引导' }).click();
  await page.reload();
  await expect(page.getByRole('complementary', { name: '新手引导' })).toHaveCount(0);
  await page.goto(chatPath);
  await sendChat(page);
  await expect(page.getByRole('button', { name: '换一个回复', exact: true })).toBeEnabled();
  await expect(page.getByRole('complementary', { name: '聊天上手提示' })).toHaveCount(0);
  expect(
    (await preview.state()).requests.filter((item) => item.path === '/api/users/onboarding')
  ).toHaveLength(1);
});

for (const scenario of ['standard', 'onboarding-error'] as const) {
  test(`@onboarding ${scenario} 不打扰旧用户，资格失败仍可聊天`, async ({ page, preview }) => {
    await preview.scenario(scenario);
    const result = page.waitForResponse((response) =>
      response.url().endsWith('/api/users/onboarding')
    );
    await page.goto(chatPath);
    await result;
    await expect(page.getByRole('complementary', { name: '聊天上手提示' })).toHaveCount(0);
    await sendChat(page);
    await expect(page.getByRole('button', { name: '换一个回复', exact: true })).toBeEnabled();
    expect(
      (await preview.state()).requests.filter((item) => item.path === '/api/users/onboarding')
    ).toHaveLength(1);
  });
}

async function seedBasicGuide(page: Page, finished = true, rounds = 10) {
  await page.addInitScript(
    ({ done, count }) => {
      const key = 'miniapp:guide:v1:local-browser';
      if (!localStorage.getItem(key))
        localStorage.setItem(
          key,
          JSON.stringify({
            expiresAt: Date.now() + 7 * 86400_000,
            skipped: false,
            started: true,
            replied: true,
            toolsSeen: done,
            returned: done,
            completedTurns: Array.from({ length: count }, (_, i) => `earlier-session:turn-${i}`),
          })
        );
    },
    { done: finished, count: rounds }
  );
}

async function returnToRecommended(page: Page) {
  await page.getByRole('button', { name: '返回发现', exact: true }).click();
  await expect(page.getByRole('tab', { name: '推荐', exact: true })).toBeVisible();
}

test('@onboarding @creator-onboarding @layout 9轮试卡不邀请，跨角色满10轮返场才展示福利与创作特色', async ({
  page,
  preview,
}) => {
  await preview.scenario('new-user-near-creator');
  await seedBasicGuide(page, true, 9);
  await page.goto(chatPath);
  await page.getByRole('button', { name: '换一个回复', exact: true }).click();
  await expect(page.getByRole('button', { name: '换一个回复', exact: true })).toBeEnabled();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem('miniapp:guide:v1:local-browser') ?? '{}').completedTurns
            ?.length
      )
    )
    .toBe(9);
  await returnToRecommended(page);
  await expect(page.getByRole('complementary', { name: '角色创作邀请' })).toHaveCount(0);
  await page.getByRole('button', { name: '查看 故事旅人 2 的详情', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /开始对话|开始聊天/ })
    .click();
  await page.waitForURL(/\/chat\//);
  await sendChat(page);
  await expect(page.getByRole('button', { name: '换一个回复', exact: true })).toBeEnabled();
  await expect(page.getByRole('complementary', { name: '角色创作邀请' })).toHaveCount(0);
  await returnToRecommended(page);
  const invite = page.getByRole('complementary', { name: '角色创作邀请' });
  await expect(invite).toBeVisible();
  await expect(invite).toContainText('40%');
  await expect(invite).toContainText('专项星尘奖励');
  await expect(invite).toContainText('8 折');
  await invite.getByRole('button', { name: '收起创作邀请' }).click({ trial: true });
  await expectMobileLayout(page);
  await preview.screenshot('满10轮的创作福利邀请');
  expect(
    (await preview.state()).requests.filter((r) => r.path === '/api/users/onboarding')
  ).toHaveLength(0);
  await invite.getByRole('link', { name: '试着做一个' }).click();
  const tips = page.getByRole('complementary', { name: '角色创作小贴士' });
  await expect(tips).toBeVisible();
  await expect(tips).toContainText('满意了再采用');
  await expectMobileLayout(page);
  await preview.screenshot('首次创作的两个特色提示');
  await tips.getByRole('button', { name: '看看 AI 润色' }).click();
  await expect(page.getByRole('button', { name: 'AI 润色开场白', exact: true })).toBeInViewport();
  await tips.getByRole('button', { name: '看看预设', exact: true }).click();
  await expect(page.getByRole('group', { name: '预设模板，可多选' })).toBeInViewport();
  expect(
    (await preview.state()).requests.filter(
      (r) => r.method === 'POST' && /polish|presets|creator\/characters/.test(r.path)
    )
  ).toHaveLength(0);
  await tips.getByRole('button', { name: '收起创作小贴士' }).click();
  await page.reload();
  await expect(tips).toHaveCount(0);
});

test('@onboarding @creator-onboarding 冷进入与基础引导未结束不邀请，关闭后不再读取资格', async ({
  page,
  preview,
}) => {
  await preview.scenario('new-user-creator-ready');
  await seedBasicGuide(page, false);
  await page.goto('/characters');
  await expect(page.getByRole('complementary', { name: '角色创作邀请' })).toHaveCount(0);
  await page.goto(chatPath);
  await returnToRecommended(page);
  await expect(page.getByText('刚才的故事，会一直留在这里')).toBeVisible();
  await page.getByRole('button', { name: '收起对话提示' }).click();
  await expect(page.getByRole('complementary', { name: '角色创作邀请' })).toHaveCount(0);
  expect(
    (await preview.state()).requests.filter((r) => r.path === '/api/users/onboarding')
  ).toHaveLength(0);
  await page.getByRole('tab', { name: '最新', exact: true }).click();
  await page.goto(chatPath);
  await page.getByRole('button', { name: '收起特色提示' }).click();
  await returnToRecommended(page);
  await expect(page.getByRole('tab', { name: '最新', exact: true })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await expect(page.getByRole('complementary', { name: '角色创作邀请' })).toHaveCount(0);
  await page.getByRole('tab', { name: '推荐', exact: true }).click();
  await expect(page.getByRole('complementary', { name: '角色创作邀请' })).toBeVisible();
  await page.getByRole('button', { name: '收起创作邀请' }).click();
  await page.reload();
  await page.goto(chatPath);
  await returnToRecommended(page);
  await expect(page.getByRole('complementary', { name: '角色创作邀请' })).toHaveCount(0);
  expect(
    (await preview.state()).requests.filter((r) => r.path === '/api/users/onboarding')
  ).toHaveLength(0);
});
