import { mkdir, writeFile, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fail } from './config.mjs';
import { sleep } from './webdriver.mjs';

const exec = promisify(execFile);
const root = dirname(fileURLToPath(import.meta.url));
const normalize = (s) => s.replace(/\s+/g, '').replace(/[，,]/g, '').trim();
const decode = (s) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

export function parseSource(xml) {
  const rows = [];
  for (const tag of xml.match(/<XCUIElementType[^>]+>/g) || []) {
    const attrs = Object.fromEntries(
      [...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], decode(m[2])])
    );
    if (attrs.visible === 'false' || attrs.enabled === 'false') continue;
    const box = Object.fromEntries(
      ['x', 'y', 'width', 'height'].map((key) => [key, Number(attrs[key])])
    );
    if (!(box.width > 0 && box.height > 0)) continue;
    const texts = [...new Set([attrs.label, attrs.name, attrs.value].filter(Boolean))];
    for (const text of texts) rows.push({ text, ...box, native: true });
  }
  return rows;
}

export function readProgress(rows) {
  const seconds = (minutes, remainder) => Number(minutes) * 60 + Number(remainder);
  for (const row of rows) {
    const match = row.text.match(/(\d{1,3})[:：](\d{2})\s*[/／]\s*(\d{1,3})[:：](\d{2})/);
    if (!match) continue;
    if (Number(match[2]) >= 60 || Number(match[4]) >= 60) continue;
    const current = seconds(match[1], match[2]),
      duration = seconds(match[3], match[4]);
    if (duration > 0 && current <= duration) return { current, duration, row };
  }
  return null;
}

export function identity(rows, video) {
  const title = normalize(video.uiTitle || video.title);
  // A shorter drama name must not match a different drama with that name as a prefix.
  const named = rows.filter((row) => {
    const text = normalize(row.text);
    return text === title || (text.startsWith(title) && /^第\d+集$/.test(text.slice(title.length)));
  });
  const episodeRows = [...named, ...rows.filter((row) => /当前播放|正在播放/.test(row.text))];
  const correctEpisode = episodeRows.some((row) =>
    [...row.text.matchAll(/第\s*(\d+)\s*集/g)].some((match) => Number(match[1]) === video.episode)
  );
  return { title: named.length > 0, episode: correctEpisode };
}

export async function compileVision() {
  const binary = resolve(root, '.local/vision');
  await mkdir(dirname(binary), { recursive: true, mode: 0o700 });
  await exec('xcrun', ['swiftc', resolve(root, 'vision.swift'), '-o', binary], {
    timeout: 60000,
    maxBuffer: 1024 * 1024,
  });
  return binary;
}

export class UI {
  constructor(device, cfg) {
    this.device = device;
    this.cfg = cfg;
    this.captureIndex = 0;
  }

  async snapshot({ saveTo, forceOCR = false } = {}) {
    await this.device.foreground();
    const xml = await this.device.source();
    let rows = parseSource(xml);
    if (saveTo) await writeFile(`${saveTo}.xml`, xml, { mode: 0o600 });
    if (saveTo || forceOCR || this.cfg.ocr) {
      const image = Buffer.from(await this.device.screenshot(), 'base64');
      const file = saveTo ? `${saveTo}.png` : resolve(root, '.local/ocr-current.png');
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(file, image, { mode: 0o600 });
      if (this.cfg.ocr || forceOCR) {
        const binary = resolve(root, '.local/vision');
        try {
          await access(binary);
        } catch {
          await compileVision();
        }
        const result = await exec(binary, [file], { timeout: 10000, maxBuffer: 1024 * 1024 });
        const box = this.device.rect;
        const ocr = JSON.parse(result.stdout).map((row) => ({
          ...row,
          native: false,
          x: row.x * box.width,
          y: row.y * box.height,
          width: row.width * box.width,
          height: row.height * box.height,
        }));
        rows = [...rows, ...ocr];
      }
    }
    return rows;
  }

  find(rows, pattern) {
    const matches = rows.filter((row) =>
      typeof pattern === 'string'
        ? normalize(row.text) === normalize(pattern)
        : pattern.test(row.text)
    );
    return matches.sort((a, b) => a.width * a.height - b.width * b.height)[0];
  }

  async tap(pattern, { optional = false, rows } = {}) {
    const snapshot = rows || (await this.snapshot());
    let found = this.find(snapshot, pattern);
    if (!found && this.cfg.ocr && !snapshot.some((row) => !row.native))
      found = this.find(await this.snapshot({ forceOCR: true }), pattern);
    if (!found) {
      if (optional) return false;
      fail('locate', '找不到目标控件，需检查 inspect/capture；未执行猜测点击', false);
    }
    await this.device.tap(found.x + found.width / 2, found.y + found.height / 2);
    return true;
  }

  async controls() {
    let rows = await this.snapshot();
    if (readProgress(rows)) return rows;
    if (!rows.some((row) => /短剧播放画面|播放控件|短剧播放器|返回放映|返回短剧/.test(row.text)))
      return rows;
    const blank = this.cfg.calibration.blankPoint;
    if (!blank) fail('calibration', '缺少经过确认的画面空白点');
    await this.device.tap(blank.x, blank.y);
    rows = await this.snapshot();
    return rows;
  }

  async assertVideo(video, rows) {
    const found = identity(rows || (await this.controls()), video);
    if (!found.title || !found.episode)
      fail('identity', `第 ${video.index} 条剧名或目标集号未确认，停止此项`, false);
  }

  async waitPlaying(video, seconds, target = null, { revealControls = true } = {}) {
    const deadline = Date.now() + seconds * 1000;
    let previous = null,
      advances = 0;
    let rows = revealControls ? await this.controls() : await this.snapshot();
    while (Date.now() < deadline) {
      this.device.assertRunning();
      const info = identity(rows, video),
        progress = readProgress(rows);
      if (
        info.title &&
        progress &&
        Math.abs(progress.duration - video.duration) > Math.max(5, video.duration * 0.03)
      )
        fail('identity', '当前视频时长与冻结片单不符', false);
      if (
        info.title &&
        info.episode &&
        progress &&
        (target === null || Math.abs(progress.current - target) < 7)
      ) {
        if (previous !== null && progress.current > previous && progress.current - previous <= 5)
          advances += 1;
        else if (previous !== null && progress.current < previous) advances = 0;
        previous = progress.current;
        if (advances >= 2) return progress;
      } else advances = 0;
      if (rows.some((row) => /播放暂时中断|重新播放|播放失败/.test(row.text)))
        fail('media', '播放器显示播放失败', false);
      await sleep(1000, this.device.abort.signal);
      rows = await this.snapshot();
    }
    fail('play_timeout', target === null ? 'UI 起播观察超时' : 'UI 快进恢复观察超时', false);
  }

  async seek(progress, target) {
    const rows = await this.snapshot();
    const native = rows.find(
      (row) =>
        row.native &&
        row.text === '播放进度' &&
        row.width > this.device.rect.width / 2 &&
        row.height <= 80
    );
    const calibration = this.cfg.calibration;
    // Feed and detail have different footer/safe-area layouts. Never reuse a track from the other page.
    const box = native
      ? { left: native.x, right: native.x + native.width, y: native.y + native.height / 2 }
      : calibration.progressByLayout?.[this.expectedLayout] ||
        (calibration.layout === this.expectedLayout ? calibration.progress : null);
    if (!box) fail('calibration', '当前播放布局没有原生进度轨道或对应校准，请分别校准 feed/detail');
    const width = box.right - box.left;
    if (
      !(
        box.left >= 0 &&
        box.right < this.device.rect.width &&
        width >= this.device.rect.width / 2 &&
        box.y >= 0 &&
        box.y < this.device.rect.height
      )
    )
      fail('calibration', '当前进度轨道边界无效');
    await this.device.drag(
      { x: box.left + (width * progress.current) / progress.duration, y: box.y },
      { x: box.left + (width * target) / progress.duration, y: box.y }
    );
  }

  async scroll(direction, region = 'list') {
    const { width, height } = this.device.rect;
    const x = width * 0.48;
    // Avoid Telegram top chrome, the progress control and bottom navigation.
    const high = height * 0.3,
      low = height * (region === 'feed' ? 0.62 : 0.75);
    await this.device.drag(
      { x, y: direction === 'up' ? low : high },
      { x, y: direction === 'up' ? high : low },
      0.35
    );
  }
}
