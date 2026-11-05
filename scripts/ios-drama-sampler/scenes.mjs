import { fail } from './config.mjs';
import { identity, readProgress } from './ui.mjs';
import { sleep } from './webdriver.mjs';

export class Scenes {
  constructor(ui, manifest, log) {
    this.ui = ui;
    this.videos = manifest.videos;
    this.log = log;
  }

  async leave() {
    const ui = this.ui;
    let rows = await ui.controls();
    await ui.tap(/^(返回短剧|返回放映)$/, { optional: true, rows });
    rows = await ui.controls();
    await ui.tap(/^(剧场|AI短剧)$/, { rows });
    await sleep(600);
  }

  async top() {
    let previous = '',
      steady = 0;
    for (let i = 0; i < 20; i += 1) {
      const rows = await this.ui.snapshot();
      const signature = rows.map((row) => `${row.text}:${Math.round(row.y)}`).join('|');
      steady = signature === previous ? steady + 1 : 0;
      if (steady >= 2) return;
      previous = signature;
      await this.ui.scroll('down');
    }
    fail('locate', '无法确认剧场已到顶部', false);
  }

  async browse(sort = '精选', category = '全部') {
    await this.leave();
    await this.ui.tap('剧场', { optional: true });
    await this.ui.tap('清除搜索', { optional: true });
    await this.top();
    await this.ui.tap(category);
    await this.ui.tap(sort);
  }

  async card(video) {
    const ui = this.ui;
    const exact = video.uiTitle || video.title;
    const patterns = [new RegExp(`^观看\\s*${escapeRegex(exact)}$`), exact];
    for (let i = 0; i < ui.cfg.maxScrolls; i += 1) {
      const rows = await ui.snapshot();
      const found = patterns.map((pattern) => ui.find(rows, pattern)).find(Boolean);
      if (found) {
        await ui.device.tap(found.x + found.width / 2, found.y + found.height / 2);
        return;
      }
      await ui.scroll('up');
    }
    fail('locate', `第 ${video.index} 条卡片未找到`, false);
  }

  async catalog(video, sort = '精选', category = '全部') {
    await this.browse(sort, category);
    await this.card(video);
  }

  async search(video) {
    await this.browse();
    await this.ui.tap('搜索短剧名称或题材');
    await this.ui.device.type(video.title);
    // Hide only the keyboard. Never accept system alerts or change account/login state.
    await this.ui.device.execute('mobile: hideKeyboard', {}).catch(() => {});
    const keyboards = await this.ui.device.request('POST', this.ui.device.path('/elements'), {
      using: 'class name',
      value: 'XCUIElementTypeKeyboard',
    });
    if (keyboards.length)
      fail('keyboard', '搜索键盘仍显示，请人工收起；未点击可能被键盘覆盖的卡片');
    await this.card(video);
  }

  async feed(video) {
    await this.leave();
    await this.ui.tap('放映');
    for (let i = 0; i < this.videos.length; i += 1) {
      const rows = await this.ui.controls();
      if (identity(rows, video).title) return;
      const current = this.videos.find((item) => identity(rows, item).title);
      if (!current) fail('feed_position', '放映当前剧不在冻结名单，先手动定位名单中的一部后重试');
      await this.ui.scroll(current.index < video.index ? 'up' : 'down', 'feed');
    }
    fail('locate', '放映滑动后未到达目标条目', false);
  }

  async enter(entry, video) {
    this.ui.expectedLayout = entry === 'feed' ? 'feed' : 'detail';
    await this.log('prepare', { entry, index: video.index });
    if (entry === 'catalog') return this.catalog(video);
    if (entry === 'latest') return this.catalog(video, '最新');
    if (entry === 'category') {
      if (!video.category) fail('not_applicable', '此条未标注已确认的分类入口', false);
      return this.catalog(video, '精选', video.category);
    }
    if (entry === 'search') return this.search(video);
    if (entry === 'feed') return this.feed(video);
    if (entry === 'detail-next') return this.detailNext(video);
    await this.feed(video);
    await this.ui.waitPlaying(video, this.ui.cfg.timing.startupSeconds);
    if (entry === 'full')
      return this.ui.tap(
        new RegExp(`^观看完整短剧(?:\\s*${escapeRegex(video.uiTitle || video.title)})?$`)
      );
    if (entry === 'feed-episode') {
      await this.ui.tap('查看全部选集');
      await this.ui.tap(new RegExp(`^第\\s*${video.episode}\\s*集(?:，当前播放)?$`));
      return;
    }
    fail('entry', '未知入口');
  }

  async detailNext(video) {
    if (video.index === 1)
      fail('not_applicable', '第1条没有白名单中的上一部，不能用片外内容准备下一部入口', false);
    const previous = this.videos[video.index - 2];
    await this.catalog(previous);
    await this.ui.waitPlaying(previous, this.ui.cfg.timing.startupSeconds);
    await this.ui.tap('下一部短剧');
  }

  async normalize(video) {
    await this.log('cleanup', { index: video.index });
    const rows = await this.ui.controls();
    await this.ui.assertVideo(video, rows);
    const progress = readProgress(rows);
    if (!progress) fail('locate', '清理阶段无法读取进度', false);
    await this.ui.seek(progress, 1);
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const latest = readProgress(await this.ui.snapshot());
      if (latest && latest.current >= 0 && latest.current <= 6) {
        await this.leave();
        return;
      }
      await sleep(750);
    }
    fail('cleanup', '回到片头后的进度未确认，未继续下一条');
  }
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
