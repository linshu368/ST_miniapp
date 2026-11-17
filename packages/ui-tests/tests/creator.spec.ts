import { previewApiUrl } from './fixtures';
import { test, expect, expectMobileLayout } from './fixtures.js';
import type { Page } from '@playwright/test';
import { WISH_IDS } from '../fixtures/data.js';

const cover = {
  name: 'cover.png',
  mimeType: 'image/png',
  buffer: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
    'base64'
  ),
};
const background =
  '定义角色的外观、个性和背景。你也可以添加自定义提示、故事、规则或者上传剧本小说。这些细节将指导角色的行为和回应';

test('@creator @creator-data @layout 创作数据支持多角色总览、单卡与时间筛选，明细反馈随之切换', async ({
  page,
  preview,
}) => {
  await preview.scenario('creator-data');
  await page.goto('/creation?tab=created');
  await page.getByRole('link', { name: '创作数据', exact: true }).click();
  await expect(page.getByRole('heading', { name: '创作数据', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: '主导航', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('获得星尘', { exact: true })).toHaveText('4,286');
  await expect(page.getByLabel('使用人数', { exact: true })).toHaveText('130人');
  await expectMobileLayout(page);
  await preview.screenshot('创作数据总览', { fullPage: true });
  const homeWorks = page.getByRole('region', { name: '作品表现' });
  await expect(homeWorks.getByRole('button', { name: /^查看.+的数据$/ })).toHaveCount(3);
  await expect(page.getByRole('navigation', { name: '列表分页' })).toHaveCount(0);
  await page.getByRole('button', { name: '查看全部作品' }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByRole('button', { name: /^查看.+的数据$/ })).toHaveCount(4);
  await expect(sheet.getByRole('button', { name: '上一页' })).toBeDisabled();
  await sheet.getByRole('button', { name: '下一页' }).click();
  await expect(sheet.getByRole('button', { name: /^查看.+的数据$/ })).toHaveCount(1);
  await expect(sheet.getByRole('button', { name: '下一页' })).toBeDisabled();
  await expectMobileLayout(page);
  await preview.screenshot('全部作品分页', { fullPage: false });
  await sheet.getByRole('button', { name: '关闭面板' }).click();
  await page.getByRole('button', { name: '查看全部作品' }).click();
  await expect(sheet.getByRole('navigation', { name: '列表分页' })).toContainText('2 / 2');
  await sheet.getByRole('button', { name: '查看月亮停在窗前的数据' }).click();
  await expect(page.getByLabel('使用人数', { exact: true })).toHaveText('0人');
  await page.getByRole('button', { name: '查看总览' }).click();
  await page.getByRole('button', { name: '查看全部作品' }).click();
  await expect(sheet.getByRole('navigation', { name: '列表分页' })).toContainText('2 / 2');

  await sheet.getByRole('button', { name: '关闭面板' }).click();
  for (const title of ['查看全部奖励', '查看全部反馈']) {
    await page.getByRole('button', { name: title }).click();
    await expect(sheet.getByRole('navigation', { name: '列表分页' })).toContainText('1 /');
    await sheet.getByRole('button', { name: '下一页' }).click();
    await expect(sheet.getByRole('navigation', { name: '列表分页' })).toContainText('2 /');
    await sheet.getByRole('button', { name: '关闭面板' }).click();
  }

  await page.getByRole('button', { name: '查看雨夜来信的数据', exact: true }).click();
  await expect(page.getByLabel('获得星尘', { exact: true })).toHaveText('986');
  await expect(page.getByLabel('使用人数', { exact: true })).toHaveText('24人');
  await expect(page.getByText('私密', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '近7天', exact: true }).click();
  await expect(page.getByLabel('获得星尘', { exact: true })).toHaveText('270');
  await page.getByRole('button', { name: '奖励明细', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('雨夜来信 · 近7天');
  await expect(page.getByRole('dialog')).toContainText('+96');
  await expect(page.getByRole('dialog')).not.toContainText('旧书店的林舟');
  await preview.screenshot('单卡奖励明细', { fullPage: false });
  await page.getByRole('dialog').getByRole('button', { name: '关闭面板', exact: true }).click();
  await page.getByRole('button', { name: '选择角色', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '长街未眠 公开', exact: true })
    .click();
  await expect(page.getByLabel('获得星尘', { exact: true })).toHaveText('0');
  await expect(page.getByLabel('使用人数', { exact: true })).toHaveText('18人');
  await expect(page.getByText(/自用不计|排除作者|已有玩家开始聊天|私密.*奖励照常/)).toHaveCount(0);
  await preview.screenshot('单卡创作数据', { fullPage: true });
  await page.getByRole('button', { name: '查看总览', exact: true }).click();
  await page.getByRole('button', { name: '作品排序', exact: true }).click();
  await expect(
    page.getByRole('dialog').getByRole('button', { name: '使用人数', exact: true })
  ).toHaveAttribute('aria-pressed', 'true');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '最近创作', exact: true })
    .click({ trial: true });
  await preview.screenshot('作品排序面板', { fullPage: false });
  await page.getByRole('dialog').getByRole('button', { name: '最近创作', exact: true }).click();
  const works = page.getByRole('region', { name: '作品表现' });
  await expect(works.getByRole('button', { name: /^查看.+的数据$/ }).first()).toHaveAccessibleName(
    '查看月亮停在窗前的数据'
  );
  await page.getByRole('button', { name: '作品排序', exact: true }).scrollIntoViewIfNeeded();
  const beforeSortY = await page.evaluate(() => window.scrollY);
  const beforeSortEarned = await page.getByLabel('获得星尘', { exact: true }).innerText();
  let releaseSort!: () => void;
  const sortGate = new Promise<void>((resolve) => {
    releaseSort = resolve;
  });
  await page.route('**/api/creator/analytics?**', async (route) => {
    if (new URL(route.request().url()).searchParams.get('sort') === 'earned') await sortGate;
    await route.continue();
  });
  await page.getByRole('button', { name: '作品排序', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '获得星尘', exact: true }).click();
  await expect(page.getByLabel('正在排序', { exact: true })).toBeVisible();
  await expect(page.getByLabel('获得星尘', { exact: true })).toHaveText(beforeSortEarned);
  await expect(page.getByText('正在读取创作数据…', { exact: true })).toHaveCount(0);
  expect(Math.abs((await page.evaluate(() => window.scrollY)) - beforeSortY)).toBeLessThan(4);
  releaseSort();
  await expect(page.getByLabel('正在排序', { exact: true })).toHaveCount(0);
  await expect(works.getByRole('button', { name: /^查看.+的数据$/ }).nth(1)).toHaveAccessibleName(
    '查看深海来客的数据'
  );
  await page.unroute('**/api/creator/analytics?**');
  await page.getByRole('link', { name: '返回我的创作', exact: true }).click();
  await expect(page).toHaveURL(/\/creation\?tab=created$/);
});

test('@creator @creator-data @layout 创作数据空态与读取失败可恢复，不展示虚构成功', async ({
  page,
  preview,
}) => {
  await preview.scenario('creator-data-empty');
  await page.goto('/creation/data?state=empty');
  await expect(page.getByLabel('获得星尘', { exact: true })).toHaveText('0');
  await expect(page.getByRole('link', { name: '创作角色', exact: true })).toBeVisible();
  await expectMobileLayout(page);
  await preview.screenshot('创作数据空态', { fullPage: false });
  await preview.scenario('creator-data-error');
  await page.goto('/creation/data?state=error');
  await expect(page.locator('main').getByRole('alert')).toContainText('暂时没能读取创作数据');
  await expect(page.getByLabel('获得星尘', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '重新加载', exact: true }).click();
  await expect(page.getByLabel('获得星尘', { exact: true })).toHaveText('4,286');
  await expectMobileLayout(page);
});
async function fillCharacter(page: Page) {
  await page.getByRole('textbox', { name: '名称' }).fill('旧书店的林舟');
  await page
    .getByPlaceholder('描述你的角色或故事，会展示在卡片和聊天页顶部')
    .fill('一封旧信，和一段等待续写的重逢。');
  await page
    .getByPlaceholder('玩家进入聊天后看到的第一段内容。可以描写开场场景，也可以让角色先说一句话。')
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
  const coverSection = page.getByRole('region', { name: '角色形象' });
  await expect(coverSection.getByText('还差 6 项必填')).toBeInViewport();
  await page.getByLabel('上传角色封面').setInputFiles({ ...cover, buffer: Buffer.alloc(0) });
  await expect(coverSection.getByRole('alert')).toHaveText('图片不能为空');
  await expect(coverSection.getByRole('alert')).toBeInViewport();
  await page.getByLabel('上传角色封面').setInputFiles(cover);
  await expect(coverSection.getByRole('alert')).toHaveCount(0);
  await expect(coverSection.getByText('还差 5 项必填')).toBeVisible();
  await coverSection.getByRole('button', { name: '去补名称' }).click();
  await expect(page.getByRole('textbox', { name: '名称' })).toBeFocused();
  await fillCharacter(page);
  await expectMobileLayout(page);
  await page.getByRole('button', { name: '保存到我的空间', exact: true }).click();
  await expect(page).toHaveURL(/\/creation\?tab=created$/);
  await page.getByRole('link', { name: '与旧书店的林舟聊天', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '输入消息' })).toBeVisible();
  await page.getByRole('button', { name: '返回我的创作', exact: true }).click();
  await expect(page).toHaveURL(/\/creation\?tab=created$/);
  await expect(page.getByRole('link', { name: '与旧书店的林舟聊天' })).toBeVisible();
  await page.getByRole('button', { name: '修改旧书店的林舟的可见性' }).click();
  await page.getByRole('button', { name: '确认公开', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('已公开', { exact: true })).toBeVisible();
  await page
    .getByRole('navigation', { name: '主导航', exact: true })
    .getByRole('link', { name: '秘境', exact: true })
    .click();
  await page.getByRole('textbox', { name: '搜索角色', exact: true }).fill('旧书店的林舟');
  await expect(
    page.getByRole('button', { name: '查看 旧书店的林舟 的详情', exact: true })
  ).toBeVisible();
  await page
    .getByRole('navigation', { name: '主导航', exact: true })
    .getByRole('link', { name: '创作', exact: true })
    .click();
  await page
    .getByRole('navigation', { name: '空间分类', exact: true })
    .getByRole('link', { name: '我的创作', exact: true })
    .click();
  await page.getByRole('button', { name: '修改旧书店的林舟的可见性' }).click();
  await expect(
    page.getByText('将不再展示在大厅，已收藏或使用过的玩家仍可继续使用。')
  ).toBeVisible();
  await page.getByRole('button', { name: '确认设为私密', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('link', { name: '编辑', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '名称' })).toHaveValue('旧书店的林舟');
  await expect(page.getByRole('navigation', { name: '主导航', exact: true })).toHaveCount(0);
  await preview.screenshot('角色编辑与发布闭环');
});

test('@creator @creator-review 新建公开和发布更新审核通过后静默返回，缓存大厅展示最新角色', async ({
  page,
  preview,
}) => {
  await preview.scenario('creation');
  await page.goto('/characters');
  await expect(
    page.getByRole('button', { name: '查看 林间旅人 的详情', exact: true })
  ).toBeVisible();
  await page
    .getByRole('navigation', { name: '主导航', exact: true })
    .getByRole('link', { name: '创作', exact: true })
    .click();
  await page.getByRole('button', { name: '开始创作角色', exact: true }).click();
  await fillCharacter(page);
  await page.getByText('公开', { exact: true }).click();
  await page.getByRole('button', { name: '公开角色', exact: true }).click();
  await expect(page).toHaveURL(/\/creation\?tab=created$/);
  await expect(page.locator('main [role="alert"]')).toHaveCount(0);
  await page
    .getByRole('navigation', { name: '主导航', exact: true })
    .getByRole('link', { name: '秘境', exact: true })
    .click();
  await page.getByRole('textbox', { name: '搜索角色', exact: true }).fill('旧书店的林舟');
  await expect(
    page.getByRole('button', { name: '查看 旧书店的林舟 的详情', exact: true })
  ).toBeVisible();
  await page
    .getByRole('navigation', { name: '主导航', exact: true })
    .getByRole('link', { name: '创作', exact: true })
    .click();
  await page
    .getByRole('navigation', { name: '空间分类', exact: true })
    .getByRole('link', { name: '我的创作', exact: true })
    .click();
  await page.getByRole('link', { name: '编辑', exact: true }).click();
  await page.getByRole('textbox', { name: '名称' }).fill('重逢后的林舟');
  await page.getByRole('button', { name: '发布更新', exact: true }).click();
  await expect(page).toHaveURL(/\/creation\?tab=created$/);
  await expect(page.locator('main [role="alert"]')).toHaveCount(0);
  await page
    .getByRole('navigation', { name: '主导航', exact: true })
    .getByRole('link', { name: '秘境', exact: true })
    .click();
  await page.getByRole('textbox', { name: '搜索角色', exact: true }).fill('重逢后的林舟');
  await expect(
    page.getByRole('button', { name: '查看 重逢后的林舟 的详情', exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: '查看 旧书店的林舟 的详情', exact: true })
  ).toHaveCount(0);
});

test('@creator @creator-review 审核拒绝显示原因并保留原稿，修改重试后静默返回', async ({
  page,
  preview,
}) => {
  await preview.scenario('creator-review-rejected');
  await page.goto('/creation/characters/new');
  await fillCharacter(page);
  await page.getByText('公开', { exact: true }).click();
  await page.getByRole('button', { name: '公开角色', exact: true }).click();
  await expect(page.getByRole('button', { name: '正在发布…', exact: true })).toBeDisabled();
  await expect(page.getByRole('alert').filter({ hasText: '未通过审核' })).toContainText(
    '未通过审核：描述中包含站外转账引导，请删除相关内容后重试。'
  );
  await expect(page).toHaveURL(/\/creation\/characters\/new/);
  await expect(page.getByRole('textbox', { name: '名称' })).toHaveValue('旧书店的林舟');
  await expect(page.getByRole('textbox', { name: '背景', exact: true })).toHaveValue(
    '林舟，32岁，书店店主。随和但敏锐，习惯用玩笑隐藏心事。'
  );
  await page
    .getByRole('textbox', { name: '描述', exact: true })
    .fill('已修改的描述。一起续写旧书店里的重逢。');
  await page.getByRole('button', { name: '公开角色', exact: true }).click();
  await expect(page).toHaveURL(/\/creation\?tab=created$/);
  await expect(page.getByText('已公开', { exact: true })).toBeVisible();
  expect(
    (await preview.state()).requests.filter(
      (request) => request.method === 'POST' && request.path === '/api/creator/characters'
    )
  ).toHaveLength(1);
  await page.getByRole('link', { name: '编辑', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '描述', exact: true })).toHaveValue(
    '已修改的描述。一起续写旧书店里的重逢。'
  );
  await page.getByRole('textbox', { name: '名称' }).fill('未通过的新版本林舟');
  await page.getByRole('button', { name: '发布更新', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '未通过审核' })).toContainText(
    '描述中包含站外转账引导'
  );
  await expect(page.getByRole('textbox', { name: '名称' })).toHaveValue('未通过的新版本林舟');
  await page.getByRole('button', { name: '编辑角色', exact: true }).click();
  await page
    .getByRole('navigation', { name: '主导航', exact: true })
    .getByRole('link', { name: '秘境', exact: true })
    .click();
  await page.getByRole('textbox', { name: '搜索角色', exact: true }).fill('林舟');
  await expect(
    page.getByRole('button', { name: '查看 旧书店的林舟 的详情', exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: '查看 未通过的新版本林舟 的详情', exact: true })
  ).toHaveCount(0);
});

test('@creator @creator-review 审核格式异常不放行，原稿保留且用户可重试', async ({
  page,
  preview,
}) => {
  await preview.scenario('creator-review-unavailable');
  await page.goto('/creation/characters/new');
  await fillCharacter(page);
  await page.getByText('公开', { exact: true }).click();
  await page.getByRole('button', { name: '公开角色', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '审核暂时不可用' })).toContainText(
    '原稿已保留'
  );
  await expect(page.getByRole('alert').filter({ hasText: '审核暂时不可用' })).not.toContainText(
    '未通过审核'
  );
  await expect(page.getByRole('textbox', { name: '名称' })).toHaveValue('旧书店的林舟');
  await page.getByRole('button', { name: '公开角色', exact: true }).click();
  await expect(page).toHaveURL(/\/creation\?tab=created$/);
  await expect(page.getByText('已公开', { exact: true })).toBeVisible();
});

test('@creator @creator-review 私密转公开未通过时保留弹层和原因，重试通过才关闭', async ({
  page,
  preview,
}) => {
  await preview.scenario('creator-review-rejected');
  await page.goto('/creation/characters/new');
  await fillCharacter(page);
  await page.getByRole('button', { name: '保存到我的空间', exact: true }).click();
  await expect(page).toHaveURL(/\/creation\?tab=created$/);
  await page.getByRole('button', { name: '修改旧书店的林舟的可见性' }).click();
  await page.getByRole('button', { name: '确认公开', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('描述中包含站外转账引导');
  await page.getByRole('button', { name: '确认公开', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('已公开', { exact: true })).toBeVisible();
});

test('@creator 封面工作室生成并回流保留原稿', async ({ page, preview }) => {
  await preview.scenario('creation');
  await page.goto('/creation/characters/new');
  await page.getByRole('textbox', { name: '名称' }).fill('封面回流草稿');
  const description = '旧书店的店主，卷发、黑框眼镜。';
  await page.getByRole('textbox', { name: '描述', exact: true }).fill(description);
  const customPreset = page.getByPlaceholder('破甲话术。对有些模型来说必不可少。');
  await customPreset.fill('保持角色的语言习惯和世界观。');
  const preset = page.getByRole('checkbox', { name: '活的世界与真实因果', exact: true });
  await preset.check();
  await page.getByRole('button', { name: '生成', exact: true }).click();
  await expect(page).toHaveURL(/\/create\/studio\/.*creator_return=/);
  const studioUrl = page.url();
  const composer = page.getByPlaceholder('描述你想生成的画面…');
  await expect(composer).toBeEditable();
  await composer.fill('');
  await page.getByRole('button', { name: '带入角色描述', exact: true }).click();
  await expect(composer).toHaveValue(description);
  await composer.fill('夜晚，柔和灯光。');
  await page.getByRole('button', { name: '追加角色描述', exact: true }).click();
  await expect(composer).toHaveValue('夜晚，柔和灯光。\n\n' + description);
  expect(
    (await preview.state()).requests.filter(
      (request) => request.path.endsWith('/attempts') && request.method === 'POST'
    )
  ).toHaveLength(0);
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
  await expect(page).toHaveURL(/\/creation\?tab=created$/);
  await expect(page.getByRole('link', { name: /^与.+聊天$/ })).toBeVisible();
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
    '玩家进入聊天后看到的第一段内容。可以描写开场场景，也可以让角色先说一句话。'
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

test('@creator @layout 主动停止润色后可编辑采用已有文字，首字前停止保留原稿', async ({
  page,
  preview,
}) => {
  await preview.scenario('creator-polish-stop');
  await page.goto('/creation/characters/new');
  const opening = page.getByRole('textbox', { name: '开场白', exact: true });
  const original = '「门没锁，进来吧。」';
  await opening.fill(original);
  const start = page.getByRole('button', { name: 'AI 润色开场白', exact: true });
  const stop = page.getByRole('button', { name: '停止生成', exact: true });
  const result = page.getByRole('textbox', { name: '润色结果' });
  await start.click();
  await expect(result).toHaveValue(/书店/);
  const partial = await result.inputValue();
  await stop.click();
  await expect(result).toHaveValue(partial);
  await expect(result).toBeEditable();
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await expect(opening).toHaveValue(original);
  await start.click();
  await expect(result).toHaveValue(partial);
  await result.fill(partial + '他抬起头。');
  await page.getByRole('button', { name: '采用这一版', exact: true }).click();
  await expect(opening).toHaveValue(partial + '他抬起头。');
  await page.getByRole('button', { name: '恢复上一版', exact: true }).click();
  await expect(opening).toHaveValue(original);

  const background = page.getByRole('textbox', { name: '背景', exact: true });
  await background.fill('她经营一家旧书店。');
  const backgroundPolish = page.getByRole('button', { name: 'AI 润色背景', exact: true });
  const pending = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/creator/polish' && r.request().method() === 'POST'
  );
  await backgroundPolish.click();
  await pending;
  await stop.click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(background).toHaveValue('她经营一家旧书店。');
  await expect(backgroundPolish).toHaveText('AI 润色');
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
  await expect(page).toHaveURL(/\/creation\?tab=created$/);
  await expect(page.getByRole('link', { name: /^与.+聊天$/ })).toBeVisible();
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
  await expect(page).toHaveURL(/\/creation\?tab=created$/);
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
  await expect(page).toHaveURL(/\/creation\?tab=created$/);
  await expect(page.getByRole('link', { name: /^与.+聊天$/ })).toBeVisible();
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
  await expect(page).toHaveURL(/\/creation\?tab=created$/);
  await page.getByRole('link', { name: '编辑', exact: true }).click();
  await expect(page).toHaveURL(/\/creation\/characters\/[^/]+\/edit$/);
  const id = new URL(page.url()).pathname.split('/')[3];
  await page.getByRole('textbox', { name: '名称' }).fill('我的重要未提交修改');
  await page.getByRole('textbox', { name: '描述', exact: true }).click();
  await expect(page.getByText('草稿已保存到本地', { exact: true })).toBeVisible();
  const detail = await (await request.get(`${previewApiUrl}/api/creator/characters/${id}`)).json();
  const card = detail.data.character;
  const updated = await request.patch(`${previewApiUrl}/api/creator/characters/${id}`, {
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

test('@creator @wishes @layout 心愿墙说明匿名公开、支持想玩与本人撤回，返回保留来源', async ({
  page,
  preview,
}) => {
  await preview.scenario('wishes');
  await page.goto('/characters');
  const wishEntry = page.getByRole('link', { name: '许个愿', exact: true });
  await expect(wishEntry).toBeInViewport();
  await expect(wishEntry).toHaveAttribute('href', '/wishes?from=characters');
  const search = page.getByRole('textbox', { name: '搜索角色', exact: true });
  await search.fill('不存在的心愿角色');
  await expect(page.getByRole('link', { name: '许个愿，让创作者看见', exact: true })).toBeVisible();
  await expect(wishEntry).toBeInViewport();
  await page.getByRole('button', { name: '清空搜索', exact: true }).click();
  await wishEntry.click();
  await expect(page.getByRole('heading', { name: '心愿墙', exact: true })).toBeVisible();
  await expect(
    page.getByText('所有心愿均匿名公开，不展示昵称和头像。', { exact: true })
  ).toBeVisible();
  await expectMobileLayout(page);
  await preview.screenshot('心愿墙', { fullPage: true });
  await page.goto(`/wishes/${WISH_IDS.adventure}?from=characters`);
  const support = page.getByRole('button', { name: '我也想玩', exact: true });
  await expect(support).toBeVisible();
  const supportBox = await support.boundingBox();
  expect(supportBox?.height).toBeGreaterThanOrEqual(44);
  await support.click();
  await expect(page.getByRole('button', { name: '取消期待', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '取消期待', exact: true }).click();
  await expect(support).toBeVisible();
  await expect(page.getByRole('link', { name: '以此创作', exact: true })).toHaveAttribute(
    'href',
    `/creation/characters/new?wish=${WISH_IDS.adventure}`
  );
  await preview.screenshot('心愿详情', { fullPage: true });
  await page.goto('/wishes');
  await page.getByRole('button', { name: '许个愿', exact: true }).click();
  const sheet = page.getByRole('dialog');
  await sheet
    .getByRole('textbox', { name: '你想玩什么样的角色', exact: true })
    .fill('希望有一位愿意和我共同经营星空旅馆的朋友。');
  await expect(
    sheet.getByText('心愿将匿名公开，不展示昵称和头像，所有人都能看到。', { exact: true })
  ).toBeVisible();
  await expect(sheet.getByRole('button', { name: '私密', exact: true })).toHaveCount(0);
  await expect(sheet.getByText('谁可以看到', { exact: true })).toHaveCount(0);
  await sheet.getByRole('button', { name: '提交心愿', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('希望有一位愿意和我共同经营星空旅馆的朋友。')).toBeVisible();
  await page.goto('/wishes');
  await expect(page.getByText('希望有一位愿意和我共同经营星空旅馆的朋友。')).toBeVisible();
  await page.getByText('希望有一位愿意和我共同经营星空旅馆的朋友。').click();
  await page.getByRole('button', { name: '撤回心愿', exact: true }).click();
  await page.getByRole('button', { name: '确认撤回', exact: true }).click();
  await expect(page.getByText('希望有一位愿意和我共同经营星空旅馆的朋友。')).toHaveCount(0);
  await expectMobileLayout(page);
});

test('@creator @wishes @layout 心愿提交失败保留文字和匿名公开提示，重试成功且不重复', async ({
  page,
  preview,
}) => {
  await preview.scenario('wishes-error');
  await page.goto('/wishes');
  await page.getByRole('button', { name: '许个愿', exact: true }).click();
  const sheet = page.getByRole('dialog');
  const input = sheet.getByRole('textbox', { name: '你想玩什么样的角色', exact: true });
  await expect(input).toHaveAttribute('maxlength', '500');
  const body = '我想和一位喜欢讲冷笑话的星际船长一起去旅行。';
  await input.fill(body);
  await expect(
    sheet.getByText('心愿将匿名公开，不展示昵称和头像，所有人都能看到。', { exact: true })
  ).toBeVisible();
  await sheet.getByRole('button', { name: '提交心愿', exact: true }).click();
  await expect(sheet.getByRole('alert')).toContainText('这次没能提交');
  await expect(input).toHaveValue(body);
  await expect(
    sheet.getByText('心愿将匿名公开，不展示昵称和头像，所有人都能看到。', { exact: true })
  ).toBeVisible();
  await expectMobileLayout(page);
  await preview.screenshot('心愿失败保留原稿', { fullPage: false });
  await sheet.getByRole('button', { name: '提交心愿', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText(body)).toHaveCount(1);
});

test('@creator @wishes @layout 从创作数据找选题、作品回应与站内通知回到心愿', async ({
  page,
  preview,
}) => {
  await preview.scenario('wishes');
  await page.goto('/creation/data');
  await page.getByRole('link', { name: /看看玩家想玩什么/ }).click();
  await expect(page).toHaveURL(/\/wishes/);
  await page.goto(`/wishes/${WISH_IDS.adventure}?from=creator-data`);
  await page.getByRole('button', { name: '用已有作品回应', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: '选择回应作品' });
  await sheet.getByRole('button', { name: /深海来客/ }).click();
  await sheet.getByRole('button', { name: '确认回应', exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByText('深海来客', { exact: true })).toBeVisible();
  await expectMobileLayout(page);
  await preview.screenshot('作品回应心愿', { fullPage: true });
  await page.goto('/profile/messages');
  await page.getByRole('tab', { name: '消息', exact: true }).click();
  await page.getByRole('button', { name: /你期待的角色有回应了/ }).click();
  await expect(
    page.getByRole('heading', { name: '你期待的角色有回应了', exact: true })
  ).toBeVisible();
  await page.getByRole('button', { name: '去看看回应的角色', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/wishes/${WISH_IDS.minePublic}`));
  await expect(page.getByRole('heading', { name: /为这个心愿创作的角色/ })).toBeVisible();
});

test('@creator @wishes @layout 从心愿创作保留来源，公开后关联失败只重试回应', async ({
  page,
  preview,
}) => {
  await preview.scenario('wishes-response-error');
  await page.goto(`/wishes/${WISH_IDS.detective}`);
  await page.getByRole('link', { name: '以此创作', exact: true }).click();
  await expect(page).toHaveURL(/wish=/);
  await fillCharacter(page);
  await expect(page.getByRole('button', { name: /全屏查看|查看封面/ }).first()).toBeVisible();
  await expect(page.getByText('草稿已保存到本地', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('textbox', { name: '名称' })).toHaveValue('旧书店的林舟');
  await expect(page.getByText(/希望有一张双人破案的角色卡/)).toBeVisible();
  await page.getByText('公开', { exact: true }).click();
  await page.getByRole('button', { name: '公开角色', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/wishes/${WISH_IDS.detective}\\?respond=`));
  await expect(page.getByText('角色已发布，暂未关联到心愿')).toBeVisible();
  await page.getByRole('button', { name: '重新回应', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/wishes/${WISH_IDS.detective}$`));
  await expect(page.getByText('旧书店的林舟', { exact: true })).toBeVisible();
  const state = await preview.state();
  expect(
    state.requests.filter((item) => item.method === 'POST' && item.path.endsWith('/publish'))
  ).toHaveLength(1);
  await expectMobileLayout(page);
  await preview.screenshot('新创作回应恢复', { fullPage: true });
});

test('@creator @wishes @layout 原心愿已撤回时仍告知角色已发布并提供返回创作入口', async ({
  page,
  request,
  preview,
}) => {
  await preview.scenario('wishes');
  const result = await request.delete(
    `${previewApiUrl}/api/character-wishes/${WISH_IDS.minePublic}`
  );
  expect(result.ok()).toBeTruthy();
  await page.goto(`/wishes/${WISH_IDS.minePublic}?respond=${WISH_IDS.ownCard}`);
  await expect(page.getByText('角色已发布，暂未关联到心愿')).toBeVisible();
  await expect(page.getByRole('link', { name: '查看我的角色', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '重新回应', exact: true })).toHaveCount(0);
  await expectMobileLayout(page);
  await page.getByRole('link', { name: '查看我的角色', exact: true }).click();
  await expect(page).toHaveURL(/\/creation\?tab=created$/);
  await expect(page.getByRole('link', { name: '与深海来客聊天', exact: true })).toBeVisible();
});

test('@creator @wish-sort @wishes @layout 心愿排序轻触选择、保留列表，切换我的心愿不串内容', async ({
  page,
  preview,
}) => {
  await preview.scenario('wishes');
  await page.goto('/wishes?from=characters');
  const articles = page.locator('main article');
  await expect(articles).toHaveCount(4);
  await expect(articles.first()).toContainText('深海探险家');
  const sortButton = page.getByRole('button', { name: '心愿排序', exact: true });
  await expect(sortButton).toBeVisible();
  expect((await sortButton.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  const listRequests = () =>
    preview
      .state()
      .then(
        (state) =>
          state.requests.filter(
            (item) => item.method === 'GET' && item.path === '/api/character-wishes'
          ).length
      );
  const initialRequests = await listRequests();
  await sortButton.click();
  const sheet = page.getByRole('dialog', { name: '排序方式', exact: true });
  await expect(sheet.getByRole('radio', { name: '最新心愿', exact: true })).toHaveAttribute(
    'aria-checked',
    'true'
  );
  await expect(sheet.getByRole('radio', { name: '最多人想玩', exact: true })).toHaveAttribute(
    'aria-checked',
    'false'
  );
  await expectMobileLayout(page);
  await expect(sheet.getByRole('radio', { name: '最多人想玩', exact: true })).toBeInViewport({
    ratio: 1,
  });
  await preview.screenshot('心愿排序面板', { fullPage: false });
  await sheet.getByRole('button', { name: '关闭排序', exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect(articles.first()).toContainText('深海探险家');
  expect(await listRequests()).toBe(initialRequests);

  let releaseSort!: () => void;
  let releaseMine!: () => void;
  let sortStarted!: () => void;
  let mineStarted!: () => void;
  const sortGate = new Promise<void>((resolve) => {
    releaseSort = resolve;
  });
  const mineGate = new Promise<void>((resolve) => {
    releaseMine = resolve;
  });
  const sortRequest = new Promise<void>((resolve) => {
    sortStarted = resolve;
  });
  const mineRequest = new Promise<void>((resolve) => {
    mineStarted = resolve;
  });
  const pattern = '**/api/character-wishes?**';
  await page.route(pattern, async (route) => {
    const params = new URL(route.request().url()).searchParams;
    if (params.get('scope') === 'public' && params.get('sort') === 'popular') {
      sortStarted();
      await sortGate;
    }
    if (params.get('scope') === 'mine') {
      mineStarted();
      await mineGate;
    }
    await route.continue();
  });
  try {
    await sortButton.click();
    await sheet.getByRole('radio', { name: '最多人想玩', exact: true }).click();
    await sortRequest;
    await expect(sheet).toHaveCount(0);
    await expect(page.getByLabel('正在排序', { exact: true })).toBeVisible();
    await expect(articles).toHaveCount(4);
    await expect(articles.first()).toContainText('深海探险家');
    await expect(page.getByText('正在加载…', { exact: true })).toHaveCount(0);
    releaseSort();
    await expect(articles.first()).toContainText('双人破案');
    await expect(page.getByLabel('正在排序', { exact: true })).toHaveCount(0);
    const sortedRequests = await listRequests();
    expect(sortedRequests).toBe(initialRequests + 1);
    await sortButton.click();
    await expect(sheet.getByRole('radio', { name: '最多人想玩', exact: true })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    await sheet.getByRole('radio', { name: '最多人想玩', exact: true }).click();
    await expect(sheet).toHaveCount(0);
    await sortButton.click();
    await expect(sheet).toBeVisible();
    expect(await listRequests()).toBe(sortedRequests);
    await sheet.getByRole('button', { name: '关闭排序', exact: true }).click();

    await page
      .getByRole('group', { name: '心愿范围' })
      .getByRole('button', { name: '我的心愿', exact: true })
      .click();
    await mineRequest;
    await expect(page.getByText(/想玩一个有自己生活的深海探险家/)).toHaveCount(0);
    await expect(page.getByText(/希望有一张双人破案的角色卡/)).toHaveCount(0);
    await expect(sortButton).toHaveCount(0);
    releaseMine();
    await expect(articles).toHaveCount(2);
    await expect(
      page.getByText('想和一位经营山间小旅馆的朋友，一起把荒废的花园重新种好。')
    ).toBeVisible();
    await page
      .getByRole('group', { name: '心愿范围' })
      .getByRole('button', { name: '心愿墙', exact: true })
      .click();
    await expect(articles.first()).toContainText('双人破案');
    await expect(articles).toHaveCount(4);
    await expect(page.getByText(/想玩一个有自己生活的深海探险家/)).toBeVisible();
    await expectMobileLayout(page);
    await preview.screenshot('心愿热度排序', { fullPage: true });
    await articles.first().getByRole('link').first().click();
    await expect(page).toHaveURL(new RegExp(`/wishes/${WISH_IDS.detective}.*sort=popular`));
    await page.getByRole('link', { name: '返回', exact: true }).click();
    await expect(articles.first()).toContainText('双人破案');
    await expect(sortButton).toContainText('最多人想玩');
  } finally {
    releaseSort();
    releaseMine();
    await page.unroute(pattern);
  }
});
