import type { Page } from '@playwright/test';
import { test, expect, expectMobileLayout } from './fixtures.js';

/** chat-folders 场景：32 段对话、前 4 个角色各 3 段、分组「主线剧情」「恋爱向」。 */
async function openFolderScenario(
  page: Page,
  preview: { scenario: (name: 'chat-folders') => Promise<void> }
) {
  await preview.scenario('chat-folders');
  await page.goto('/chats');
  await expect(page.getByRole('searchbox', { name: '搜索对话' })).toBeVisible();
}

const tabs = (page: Page) => page.getByRole('navigation', { name: '对话分组' });
const tab = (page: Page, name: RegExp) => tabs(page).getByRole('button', { name });
const rows = (page: Page) => page.getByRole('region', { name: '对话记录' }).locator('article');
const byCharacter = (page: Page) => page.getByRole('button', { name: '按角色', exact: true });

/** 默认按角色归拢；需要逐段看的用例先切回按时间平铺。 */
async function showFlat(page: Page) {
  await expect(byCharacter(page)).toHaveAttribute('aria-pressed', 'true');
  await byCharacter(page).click();
  await expect(byCharacter(page)).toHaveAttribute('aria-pressed', 'false');
}

test('@chats @layout 对话少时保持原样：不出现搜索、分组和管理', async ({ page }) => {
  await page.goto('/chats');
  await expect(page.getByRole('link', { name: /继续与 .+ 的对话/ }).first()).toBeVisible();
  await expect(page.getByText('继续你的故事，也可以在这里管理对话。')).toBeVisible();
  await expect(page.getByRole('searchbox', { name: '搜索对话' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '管理', exact: true })).toHaveCount(0);
  await expect(tabs(page)).toHaveCount(0);
  await expectMobileLayout(page);
});

test('@chats @layout 新建分组后挑选对话放进去，删分组后对话还在', async ({ page, preview }) => {
  await openFolderScenario(page, preview);
  await expect(tab(page, /^全部 32$/)).toHaveAttribute('aria-pressed', 'true');
  await expectMobileLayout(page);
  await preview.screenshot('对话页分组标签');

  await tabs(page).getByRole('button', { name: /新建/ }).click();
  const nameSheet = page.getByRole('dialog', { name: '新建分组' });
  await expect(nameSheet.getByRole('textbox', { name: '分组名' })).toBeFocused();
  await nameSheet.getByRole('textbox', { name: '分组名' }).fill('悬疑推理');
  await nameSheet.getByRole('button', { name: '保存' }).click();

  // 新建后停在空分组，空状态直接给下一步。
  await expect(tab(page, /^悬疑推理 0$/)).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '挑选对话放进来' }).click();
  await expect(page.getByRole('heading', { name: '挑选对话放进「悬疑推理」' })).toBeVisible();
  await expect(page.getByRole('toolbar', { name: '批量操作' })).toBeVisible();
  const pickable = page.getByRole('button', { name: /^选择：/ });
  await pickable.nth(0).click();
  await pickable.nth(0).click();
  const put = page.getByRole('button', { name: /放进「悬疑推理」 · 2/ });
  await expectMobileLayout(page);
  await preview.screenshot('挑选对话放进分组');
  await put.click();

  await expect(page.getByText('已把 2 个对话放进「悬疑推理」')).toBeVisible();
  await expect(tab(page, /^悬疑推理 2$/)).toHaveAttribute('aria-pressed', 'true');
  await expect(rows(page)).toHaveCount(2);

  await page.getByLabel('管理分组：悬疑推理').click();
  await page.getByRole('button', { name: '删除分组' }).click();
  const confirm = page.getByRole('dialog', { name: '删除分组「悬疑推理」？' });
  await expect(confirm.getByText('组里的对话不会删除')).toBeVisible();
  await confirm.getByRole('button', { name: '删除分组' }).click();
  await expect(page.getByText('分组已删除，里面的对话都还在')).toBeVisible();
  await expect(tab(page, /^全部 32$/)).toHaveAttribute('aria-pressed', 'true');
  await expect(tab(page, /^悬疑推理/)).toHaveCount(0);
});

test('@chats 单条「⋯ → 移到分组」，分组内只看本组', async ({ page, preview }) => {
  await openFolderScenario(page, preview);
  await showFlat(page);
  const first = rows(page).first();
  const title = (await first.getByRole('link').getAttribute('aria-label'))!;
  await first.getByLabel(/^管理对话：/).click();
  await first.getByRole('button', { name: '移到分组' }).click();
  const sheet = page.getByRole('dialog', { name: '移到分组' });
  await sheet.getByRole('button', { name: /恋爱向/ }).click();
  await expect(page.getByText('已放进「恋爱向」')).toBeVisible();
  await expect(tab(page, /^恋爱向 4$/)).toBeVisible();

  await tab(page, /^恋爱向/).click();
  await expect(rows(page)).toHaveCount(4);
  await expect(page.getByRole('link', { name: title }).first()).toBeVisible();
  // 分组内不再重复显示所属分组的小标签。
  await expect(rows(page).first().getByText('恋爱向', { exact: true })).toHaveCount(0);
});

test('@chats @layout 按角色归拢：一行接着聊最近一段，「N 段」展开每一段', async ({
  page,
  preview,
}) => {
  await openFolderScenario(page, preview);
  await expect(byCharacter(page)).toHaveAttribute('aria-pressed', 'true');
  const expand = page.getByRole('button', { name: /^展开 .+ 的 3 段对话$/ }).first();
  await expect(expand).toBeVisible();
  await expectMobileLayout(page);
  await preview.screenshot('按角色归拢');

  await expand.click();
  await expect(page.getByRole('button', { name: /^收起 .+ 的 3 段对话$/ }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: /第2段|第3段/ }).first()).toBeVisible();

  // 整组只给置顶与移到分组；改名、删除留在单段上。
  const groupMenu = page.getByLabel(/^管理角色：/).nth(1);
  await groupMenu.click();
  await expect(page.getByRole('button', { name: '整组移到分组' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: /重命名|删除/ }).filter({ visible: true })
  ).toHaveCount(0);
  await page.getByRole('button', { name: '整组移到分组' }).click();
  const sheet = page.getByRole('dialog', { name: '移到分组' });
  await expect(sheet.getByText(/的 3 段对话$/)).toBeVisible();
  await sheet.getByRole('button', { name: /恋爱向/ }).click();
  await expect(page.getByText(/^已把 3 个对话放进「恋爱向」$/)).toBeVisible();
  await page
    .getByLabel(/^管理角色：/)
    .first()
    .click();
  await page.getByRole('button', { name: /置顶这个角色/ }).click();
  await expect(page.getByText(/^已(取消)?置顶这个角色$/)).toBeVisible();

  // 关掉后记在本机：刷新后仍按时间平铺；再打开继续归拢。
  await byCharacter(page).click();
  await page.reload();
  await expect(byCharacter(page)).toHaveAttribute('aria-pressed', 'false');
  await byCharacter(page).click();
  await page
    .getByRole('link', { name: /^接着聊 .+ 最近的一段$/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/chat\//);
});

test('@chats 搜索不限分组，滑到底自动加载更早的对话', async ({ page, preview }) => {
  await openFolderScenario(page, preview);
  await showFlat(page);
  await expect(rows(page)).toHaveCount(20);
  await rows(page).last().scrollIntoViewIfNeeded();
  await expect(rows(page)).toHaveCount(32);

  await tab(page, /^主线剧情/).click();
  await page.getByRole('searchbox', { name: '搜索对话' }).fill('第3段');
  await expect(rows(page)).toHaveCount(4);
  await expect(tabs(page)).toHaveCount(0);
  await page.getByRole('searchbox', { name: '搜索对话' }).fill('没有这个名字');
  await expect(page.getByText('没找到「没有这个名字」相关的对话，换个词试试')).toBeVisible();
});

test('@chats @layout 管理：快速筛选自动全选，批量删除需确认', async ({ page, preview }) => {
  await openFolderScenario(page, preview);
  await page.getByRole('button', { name: '管理', exact: true }).click();
  await page.getByRole('button', { name: '只聊了一两句' }).click();
  await expect(page.getByRole('heading', { name: '已选 6 个' })).toBeVisible();
  const toolbar = page.getByRole('toolbar', { name: '批量操作' });
  await expect(toolbar.getByRole('button', { name: '删除 6' })).toBeEnabled();
  await expectMobileLayout(page);
  await preview.screenshot('管理模式快速筛选');

  await toolbar.getByRole('button', { name: '删除 6' }).click();
  const confirm = page.getByRole('dialog', { name: '删除 6 个对话？' });
  await confirm.getByRole('button', { name: '删除', exact: true }).click();
  await expect(page.getByText('已删除 6 个对话')).toBeVisible();
  await expect(tab(page, /^全部 26$/)).toBeVisible();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
});

test('@chats @layout 从分组里点开一段再返回：分组、展开都还在，停在刚才那一行并闪金边', async ({
  page,
  preview,
}) => {
  await openFolderScenario(page, preview);
  await tab(page, /^主线剧情/).click();
  await page
    .getByRole('button', { name: /^展开 .+ 的 2 段对话$/ })
    .first()
    .click();
  const parts = page.getByRole('group', { name: /的各段对话$/ });
  const target = parts.getByRole('link').last();
  const sessionId = new URL((await target.getAttribute('href'))!, 'http://local').searchParams.get(
    'session'
  )!;
  await target.click();
  await expect(page).toHaveURL(/\/chat\//);

  await page.goBack();
  await expect(page).toHaveURL(/\/chats$/);
  await expect(tab(page, /^主线剧情/)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: /^收起 .+ 的 2 段对话$/ })).toBeVisible();
  const anchor = parts.locator(`[data-chat-anchor="${sessionId}"]`);
  await expect(anchor).toBeInViewport();
  await expect(anchor.locator('[data-return-flash]')).toHaveCount(1);
  await expectMobileLayout(page);
  await preview.screenshot('返回停在刚才那一行');
});
