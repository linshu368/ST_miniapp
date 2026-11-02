import { test, expect, expectMobileLayout } from './fixtures.js';
import type { Page } from '@playwright/test';

const cover = {
  name: 'cover.png',
  mimeType: 'image/png',
  buffer: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGqkAAAAASUVORK5CYII=',
    'base64'
  ),
};
const background =
  '定义角色的外观、个性和背景。你也可以添加自定义提示、故事、规则或者上传剧本小说。这些细节将指导角色的行为和回应';
async function fillCharacter(page: Page) {
  await page.getByRole('textbox', { name: '名称' }).fill('旧书店的林舟');
  await page
    .getByPlaceholder('描述你的角色或故事，会展示在卡片和聊天页顶部')
    .fill('一封旧信，和一段等待续写的重逢。');
  await page
    .getByPlaceholder('用户进入聊天后看到的第一段内容。可以描写开场场景，也可以让角色先说一句话。')
    .fill('「你终于回来了。」他轻轻合上手里的书。');
  await page
    .getByPlaceholder(background)
    .fill('林舟，32岁，书店店主。随和但敏锐，习惯用玩笑隐藏心事。');
  await page.getByText('纯爱', { exact: true }).click();
  await page.locator('input[type=file][accept*="image"]').setInputFiles(cover);
}

test('@creator @layout 私密发布、本人试聊、编辑与可见性切换连成闭环', async ({ page, preview }) => {
  await preview.scenario('creation');
  await page.goto('/creation');
  await page.getByRole('button', { name: '开始创作角色', exact: true }).click();
  await expect(page.getByRole('navigation', { name: '主导航', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '保存到我的空间', exact: true }).click();
  await expect(page.getByText(/请补全必填项/).first()).toBeVisible();
  await expect(page.getByRole('button', { name: '上传', exact: true })).toBeFocused();
  await page.getByRole('button', { name: '名称', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '名称' })).toBeFocused();
  await fillCharacter(page);
  await expectMobileLayout(page);
  await page.getByRole('button', { name: '保存到我的空间', exact: true }).click();
  await page.getByRole('button', { name: '开始聊天', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '输入消息' })).toBeVisible();
  await page.getByRole('button', { name: '返回我的创作', exact: true }).click();
  await expect(page).toHaveURL(/\/creation\?tab=created$/);
  await expect(page.getByRole('link', { name: '与旧书店的林舟聊天' })).toBeVisible();
  await page.getByRole('button', { name: '修改旧书店的林舟的可见性' }).click();
  await page.getByRole('button', { name: '提交审核', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('待审核 · 可先玩', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '修改旧书店的林舟的可见性' }).click();
  await expect(
    page.getByText('将不再展示在大厅，已收藏或使用过的用户仍可继续使用。')
  ).toBeVisible();
  await page.getByRole('button', { name: '确认设为私密', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('link', { name: '编辑', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '名称' })).toHaveValue('旧书店的林舟');
  await preview.screenshot('角色编辑与发布闭环');
});

test('@creator 封面工作室生成并回流保留原稿', async ({ page, preview }) => {
  await preview.scenario('creation');
  await page.goto('/creation/characters/new');
  await page.getByRole('textbox', { name: '名称' }).fill('封面回流草稿');
  const customPreset = page.getByPlaceholder('破甲话术。对有些模型来说必不可少。');
  await customPreset.fill('保持角色的语言习惯和世界观。');
  const preset = page.getByRole('checkbox', { name: '活的世界与真实因果', exact: true });
  await preset.check();
  await page.getByRole('button', { name: '生成', exact: true }).click();
  await expect(page).toHaveURL(/\/create\/studio\/.*creator_return=/);
  const studioUrl = page.url();
  await page.getByPlaceholder('描述你想生成的画面…').fill('夜晚的旧书店，32岁店主，柔和灯光。');
  await page.getByRole('button', { name: '发送生成', exact: true }).click();
  await page.getByRole('button', { name: '用作角色封面', exact: true }).first().click();
  await expect(page.getByRole('textbox', { name: '名称' })).toHaveValue('封面回流草稿');
  await expect(customPreset).toHaveValue('保持角色的语言习惯和世界观。');
  await expect(preset).toBeChecked();
  await expect(page.getByRole('button', { name: /全屏查看|查看封面/ }).first()).toBeVisible();
  await page.reload();
  await expect(page.getByRole('textbox', { name: '名称' })).toHaveValue('封面回流草稿');
  await expect(customPreset).toHaveValue('保持角色的语言习惯和世界观。');
  await expect(preset).toBeChecked();
  await page.getByRole('button', { name: '生成', exact: true }).click();
  await expect(page).toHaveURL(studioUrl);
  await expect(
    page.getByRole('button', { name: '用作角色封面', exact: true }).first()
  ).toBeVisible();
  await page.getByRole('button', { name: '返回角色编辑', exact: true }).click();
  await expect(customPreset).toHaveValue('保持角色的语言习惯和世界观。');
});

test('@creator 发布失败保留原稿，重试不重复创建', async ({ page, preview }) => {
  await preview.scenario('creator-save-error');
  await page.goto('/creation/characters/new');
  await fillCharacter(page);
  await page.getByRole('button', { name: '保存到我的空间', exact: true }).click();
  await expect(page.getByText('暂时未能发布，草稿已保留', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '名称' })).toHaveValue('旧书店的林舟');
  await page.getByRole('button', { name: '保存到我的空间', exact: true }).click();
  await expect(page.getByRole('button', { name: '开始聊天', exact: true })).toBeVisible();
  expect(
    (await preview.state()).requests.filter(
      (request) => request.method === 'POST' && request.path === '/api/creator/characters'
    )
  ).toHaveLength(1);
});

test('@creator 润色截断仍可采用，刷新后可恢复上一版', async ({ page, preview }) => {
  await preview.scenario('creator-polish-partial');
  await page.goto('/creation/characters/new');
  const opening = page.getByPlaceholder(
    '用户进入聊天后看到的第一段内容。可以描写开场场景，也可以让角色先说一句话。'
  );
  await page.getByRole('textbox', { name: '名称' }).fill('旧书店的林舟');
  await opening.fill('「好久不见。」他轻轻合上书。');
  await page.getByRole('button', { name: 'AI 润色开场白', exact: true }).click();
  await expect(page.getByText('这次润色未完整完成，可以采用已有内容后继续编辑。')).toBeVisible();
  const proposed = await page.getByRole('textbox', { name: '润色结果' }).inputValue();
  await page.getByRole('button', { name: '采用这一版', exact: true }).click();
  await expect(opening).toHaveValue(proposed);
  await page.reload();
  await expect(opening).toHaveValue(proposed);
  await page.getByRole('button', { name: '恢复上一版', exact: true }).click();
  await expect(opening).toHaveValue('「好久不见。」他轻轻合上书。');
});

test('@creator @creator-presets @layout 预设只展示简短说明，多选与自己补充一起保存', async ({
  page,
  preview,
}) => {
  await preview.scenario('creation');
  await page.goto('/creation/characters/new');
  await fillCharacter(page);
  const presets = page.getByRole('group', { name: '预设模板，可多选' });
  const world = presets.getByRole('checkbox', { name: '活的世界与真实因果', exact: true });
  const player = presets.getByRole('checkbox', { name: '不抢话、不阴谋论的丝滑互动', exact: true });
  await expect(presets.getByRole('checkbox')).toHaveCount(4);
  await expect(world).not.toBeChecked();
  await presets.getByRole('button', { name: '活的世界与真实因果：适用与效果' }).click();
  await expect(presets.getByText(/世界有真实的时间流逝和蝴蝶效应/)).toBeVisible();
  await expect(world).not.toBeChecked();
  await presets.getByRole('button', { name: '查看详情', exact: true }).click();
  const detail = page.getByRole('dialog', { name: '活的世界与真实因果', exact: true });
  await expect(detail.locator('pre')).toContainText('你将扮演本世界的核心叙事引擎');
  await expectMobileLayout(page);
  await detail.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(world).not.toBeChecked();
  await world.check();
  await player.check();
  await expect(world).toBeChecked();
  await expect(player).toBeChecked();
  await expect(page.getByPlaceholder('破甲话术。对有些模型来说必不可少。')).toBeVisible();
  await page
    .getByPlaceholder('破甲话术。对有些模型来说必不可少。')
    .fill('角色说话简洁，使用中文直角引号。');
  await page.reload();
  await expect(world).toBeChecked();
  await expect(player).toBeChecked();
  await expect(page.getByPlaceholder('破甲话术。对有些模型来说必不可少。')).toHaveValue(
    '角色说话简洁，使用中文直角引号。'
  );
  await presets.scrollIntoViewIfNeeded();
  await expectMobileLayout(page);
  await preview.screenshot('预设选择默认效果', { fullPage: false });
  expect(await page.locator('body').innerText()).not.toContain('你将扮演本世界的核心叙事引擎');
  const create = page.waitForRequest(
    (request) =>
      request.method() === 'POST' && new URL(request.url()).pathname === '/api/creator/characters'
  );
  await page.getByRole('button', { name: '保存到我的空间', exact: true }).click();
  const payload = (await create).postDataJSON();
  expect(payload.draft.selectedPresetIds).toEqual(['world-causality', 'player-boundaries']);
  expect(payload.draft.preset).toBe('角色说话简洁，使用中文直角引号。');
  expect(JSON.stringify(payload)).not.toContain('你将扮演本世界的核心叙事引擎');
  await expect(page.getByRole('button', { name: '开始聊天', exact: true })).toBeVisible();
});

test('@creator @creator-continuity @layout 润色收起和刷新保留候选，明确放弃才删除', async ({
  page,
  preview,
}) => {
  await preview.scenario('creation');
  await page.goto('/creation/characters/new');
  const opening = page.getByRole('textbox', { name: '开场白', exact: true });
  await opening.fill('「门没锁，进来吧。」');
  await page.getByRole('button', { name: 'AI 润色开场白', exact: true }).click();
  await expect(page.getByText('润色完成，你也可以直接修改')).toBeVisible();
  const candidate = page.getByRole('textbox', { name: '润色结果' });
  await candidate.fill('保留的候选稿。她把台灯向你转了转。');
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await expect(opening).toHaveValue('「门没锁，进来吧。」');
  await page.reload();
  await page.getByRole('button', { name: 'AI 润色开场白', exact: true }).click();
  await expect(candidate).toHaveValue('保留的候选稿。她把台灯向你转了转。');
  expect(
    (await preview.state()).requests.filter((r) => r.path === '/api/creator/polish')
  ).toHaveLength(1);
  await expectMobileLayout(page);
  await page.getByRole('button', { name: '暂不采用', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: 'AI 润色开场白', exact: true })).toHaveText(
    'AI 润色'
  );
  await expect(opening).toHaveValue('「门没锁，进来吧。」');
});

test('@creator @creator-continuity 已有卡未提交修改可找回，发布失败仍可刷新重试', async ({
  page,
  preview,
}) => {
  await preview.scenario('creation');
  await page.goto('/creation/characters/new');
  await fillCharacter(page);
  await page.getByRole('button', { name: '保存到我的空间', exact: true }).click();
  await page.getByRole('link', { name: '返回我的创作', exact: true }).click();
  await page.getByRole('link', { name: '编辑', exact: true }).click();
  await expect(page.getByRole('button', { name: '没有新修改', exact: true })).toBeDisabled();
  await page.getByRole('textbox', { name: '名称' }).fill('林舟的未提交修改');
  await page.getByRole('button', { name: '编辑角色', exact: true }).click();
  await expect(page.getByText('有未提交修改', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '草稿', exact: true }).click();
  await expect(page.getByRole('link', { name: '继续编辑', exact: true })).toHaveCount(1);
  await page.getByRole('link', { name: '继续编辑', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '名称' })).toHaveValue('林舟的未提交修改');
  let failed = false;
  await page.route('**/api/creator/characters/*/publish', async (route) => {
    if (!failed) {
      failed = true;
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          success: false,
          error: { code: 'UNAVAILABLE', message: '提交暂未完成，请重试' },
        }),
      });
    } else await route.continue();
  });
  await page.getByRole('button', { name: '保存到我的空间', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '提交暂未完成' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: '保存到我的空间', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '保存到我的空间', exact: true }).click();
  await expect(page.getByRole('button', { name: '开始聊天', exact: true })).toBeVisible();
});

test('@creator @creator-continuity 载入最新版本前保留修改备份', async ({
  page,
  preview,
  request,
}) => {
  await preview.scenario('creation');
  await page.goto('/creation/characters/new');
  await fillCharacter(page);
  await page.getByRole('button', { name: '保存到我的空间', exact: true }).click();
  await page.getByRole('link', { name: '返回我的创作', exact: true }).click();
  await page.getByRole('link', { name: '编辑', exact: true }).click();
  await expect(page).toHaveURL(/\/creation\/characters\/[^/]+\/edit$/);
  const id = new URL(page.url()).pathname.split('/')[3];
  await page.getByRole('textbox', { name: '名称' }).fill('我的重要未提交修改');
  await page.getByRole('textbox', { name: '描述', exact: true }).click();
  await expect(page.getByText('草稿已保存到本地', { exact: true })).toBeVisible();
  const detail = await (
    await request.get(`http://127.0.0.1:3131/api/creator/characters/${id}`)
  ).json();
  const card = detail.data.character;
  const updated = await request.patch(`http://127.0.0.1:3131/api/creator/characters/${id}`, {
    data: {
      expected_revision: card.revision,
      draft: { ...card.draft, name: '已更新的最新角色' },
      cover_asset_id: card.cover_asset_id,
    },
  });
  expect(updated.ok()).toBeTruthy();
  await page.reload();
  await expect(page.getByRole('textbox', { name: '名称' })).toHaveValue('我的重要未提交修改');
  await page.getByRole('button', { name: '载入最新版本', exact: true }).click();
  await page.getByRole('button', { name: '保留修改并载入', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '名称' })).toHaveValue('已更新的最新角色');
  await page.getByRole('link', { name: '查看修改备份', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '名称' })).toHaveValue('我的重要未提交修改');
  await page.getByRole('button', { name: '创建角色', exact: true }).click();
  await expect(page.getByText('修改备份', { exact: true })).toBeVisible();
});
