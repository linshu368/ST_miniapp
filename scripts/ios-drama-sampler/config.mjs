import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

export const configPath = resolve(homedir(), '.config/miniapp-ios-sampler/config.json');
export const entries = [
  'catalog',
  'latest',
  'category',
  'search',
  'feed',
  'full',
  'detail-next',
  'feed-episode',
];
export const defaults = {
  environment: 'production',
  experimentId: '',
  release: '',
  server: 'http://127.0.0.1:4723',
  bundleId: 'ph.telegra.Telegraph',
  udid: '',
  wdaBundleId: '',
  account: { alias: '', group: '', verified: false, verifiedExperimentId: '' },
  manifestFile: './production-manifest.json',
  output: './runs',
  entries: [
    'catalog',
    'feed',
    'full',
    'search',
    'detail-next',
    'feed-episode',
    'latest',
    'category',
  ],
  rounds: 1,
  timing: {
    startupSeconds: 60,
    seekSeconds: 65,
    beforeSeekSeconds: 2,
    afterSeekSeconds: 3,
    gapSeconds: 5,
    batchRestSeconds: 60,
  },
  seekFraction: 0.7,
  maxHours: 4,
  maxScrolls: 45,
  calibration: {
    verified: false,
    screen: null,
    blankPoint: null,
    progress: null,
    layout: null,
    progressByLayout: {},
  },
  ocr: true,
};

export function fail(code, message, fatal = true) {
  const error = new Error(message);
  error.code = code;
  error.fatal = fatal;
  throw error;
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export async function loadConfig(path) {
  const location = resolve(path);
  const raw = JSON.parse(await readFile(location, 'utf8'));
  const cfg = {
    ...structuredClone(defaults),
    ...raw,
    timing: { ...defaults.timing, ...raw.timing },
    calibration: { ...defaults.calibration, ...raw.calibration },
  };
  for (const field of ['manifestFile', 'output'])
    cfg[field] = resolve(dirname(location), cfg[field]);
  const url = new URL(cfg.server);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.protocol !== 'http:')
    fail('config', 'Appium 必须使用本机 HTTP 地址');
  if (cfg.environment !== 'production') fail('config', '此工具配置只接受本轮 production 采样');
  if (!cfg.entries.length || cfg.entries.some((name) => !entries.includes(name)))
    fail('config', `entries 只支持 ${entries.join(', ')}`);
  if (!Number.isInteger(cfg.rounds) || cfg.rounds < 1 || cfg.rounds > 100)
    fail('config', 'rounds 必须为 1–100');
  if (!(cfg.seekFraction >= 0.5 && cfg.seekFraction <= 0.85))
    fail('config', 'seekFraction 必须为 0.5–0.85');
  if (!(cfg.maxHours > 0 && cfg.maxHours <= 24)) fail('config', 'maxHours 必须为 0–24 小时');
  if (!Number.isInteger(cfg.maxScrolls) || cfg.maxScrolls < 1 || cfg.maxScrolls > 100)
    fail('config', 'maxScrolls 必须为 1–100');
  for (const [name, value] of Object.entries(cfg.timing))
    if (!Number.isFinite(value) || value < 0 || value > 300)
      fail('config', `timing.${name} 超出范围`);
  if (cfg.timing.startupSeconds < 60 || cfg.timing.seekSeconds < 65)
    fail('config', '起播/快进超时至少 60/65 秒，避免截掉长尾');
  return cfg;
}

export async function loadManifest(cfg, { allowUnverified = false } = {}) {
  const manifest = JSON.parse(await readFile(cfg.manifestFile, 'utf8'));
  if (
    manifest.environment !== cfg.environment ||
    (cfg.experimentId && manifest.experimentId !== cfg.experimentId) ||
    (!allowUnverified && manifest.verified !== true)
  )
    fail('manifest', '片单必须已核验，且 environment/experimentId 与配置一致');
  if (!Array.isArray(manifest.videos) || manifest.videos.length !== 30)
    fail('manifest', '需要完整 30 条实验片单；--limit 不绕过此校验');
  const ids = new Set(),
    dramas = new Set(),
    titles = new Set();
  for (const [index, video] of manifest.videos.entries()) {
    const episodeValid = Number.isInteger(video.episode) && video.episode >= 1;
    if (
      video.index !== index + 1 ||
      !video.title ||
      !video.dramaId ||
      !video.videoId ||
      (!allowUnverified && !episodeValid) ||
      !(video.duration > 20)
    )
      fail('manifest', `第 ${index + 1} 条缺少序号、名称、ID、集号或合理时长`);
    if (ids.has(video.videoId) || dramas.has(video.dramaId))
      fail('manifest', '30 条的 videoId 和 dramaId 必须各自唯一');
    const uiTitle = video.uiTitle || video.title;
    if (titles.has(uiTitle)) fail('manifest', '标题有歧义，请为条目提供唯一的 uiTitle');
    ids.add(video.videoId);
    dramas.add(video.dramaId);
    titles.add(uiTitle);
    if (video.category && typeof video.category !== 'string')
      fail('manifest', 'category 应为一个实际可点击的分类名称');
  }
  return manifest;
}

export function validateLive(cfg) {
  if (!cfg.udid || !cfg.wdaBundleId) fail('device', '先 configure 填写 udid 和 wdaBundleId');
}

export function validateRun(cfg) {
  validateLive(cfg);
  if (
    !cfg.release ||
    !cfg.experimentId ||
    !/^[a-zA-Z0-9_-]{1,48}$/.test(cfg.account.alias) ||
    !['supabase', 'stream'].includes(cfg.account.group) ||
    !cfg.account.verified ||
    cfg.account.verifiedExperimentId !== cfg.experimentId
  )
    fail(
      'account',
      '需要核验当前账号、实验、版本与实际分组；账号别名限48位字母数字短横线下划线；客户端不能强制服务端 A/B'
    );
  const c = cfg.calibration;
  if (!c.verified || !c.screen || !c.blankPoint || !c.progress)
    fail('calibration', '先完成 calibrate 并确认屏幕/空白点/进度条坐标');
  for (const point of [
    c.blankPoint,
    { x: c.progress.left, y: c.progress.y },
    { x: c.progress.right, y: c.progress.y },
  ]) {
    if (!(point.x >= 0 && point.x < c.screen.width && point.y >= 0 && point.y < c.screen.height))
      fail('calibration', '校准坐标超出设备屏幕');
  }
  if (c.progress.right - c.progress.left < c.screen.width / 2)
    fail('calibration', '进度条宽度不足，请使用完整水平轨道');
}

export function fingerprint(cfg, manifest) {
  const { output, ...settings } = cfg;
  return createHash('sha256').update(JSON.stringify({ settings, manifest })).digest('hex');
}
