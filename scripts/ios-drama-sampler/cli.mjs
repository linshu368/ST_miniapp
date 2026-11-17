#!/usr/bin/env node
import { readFile, mkdir, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import {
  defaults,
  configPath,
  loadConfig,
  loadManifest,
  writeJson,
  fail,
  validateLive,
  validateRun,
  entries,
} from './config.mjs';
import { Device } from './webdriver.mjs';
import { UI, readProgress, compileVision } from './ui.mjs';
import { lockDevice, plan, run } from './runner.mjs';

function argumentsOf(argv) {
  const [command = 'help', ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    const key = rest[i];
    if (!/^--[a-z-]+$/.test(key)) fail('args', '参数格式为 --name value');
    options[key.slice(2)] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true;
  }
  return { command, options };
}

async function init(path, options) {
  try {
    await access(path);
    fail('exists', '配置已存在，请使用 configure 或编辑本机 JSON');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const cfg = structuredClone(defaults);
  try {
    const device = JSON.parse(await readFile(resolve(dirname(path), 'device.json'), 'utf8'));
    cfg.udid = device.udid || '';
    cfg.wdaBundleId = device.updatedWDABundleId || '';
  } catch {
    /* Optional private device discovery, never required for offline plan. */
  }
  cfg.udid = options.udid || cfg.udid;
  cfg.wdaBundleId = options.wda || cfg.wdaBundleId;
  await writeJson(path, cfg);
  console.log(`配置已创建：${path}`);
}

async function configure(path, options) {
  const cfg = JSON.parse(await readFile(path, 'utf8'));
  if (
    (options.account && options.account !== cfg.account.alias) ||
    (options.group && options.group !== cfg.account.group) ||
    (options.experiment && options.experiment !== cfg.experimentId)
  ) {
    cfg.account.verified = false;
    cfg.account.verifiedExperimentId = '';
  }
  const keys = {
    udid: 'udid',
    wda: 'wdaBundleId',
    experiment: 'experimentId',
    release: 'release',
    manifest: 'manifestFile',
  };
  for (const [flag, key] of Object.entries(keys)) if (options[flag]) cfg[key] = options[flag];
  if (options.account) cfg.account.alias = options.account;
  if (options.group) cfg.account.group = options.group;
  if (options['verified-experiment']) {
    if (!['supabase', 'stream'].includes(cfg.account.group)) fail('account', '先填写已确认的组别');
    cfg.account.verified = true;
    cfg.account.verifiedExperimentId = options['verified-experiment'];
  }
  await writeJson(path, cfg);
  console.log('本机配置已更新；未修改服务器分桶');
}

async function importManifest(path, options) {
  if (!options.file) fail('args', 'import-manifest 需要 --file');
  const cfg = await loadConfig(path);
  const incoming = JSON.parse(await readFile(resolve(options.file), 'utf8'));
  const episode = options.episode ? Number(options.episode) : null;
  const videos = incoming.videos?.map((video, index) => ({
    ...video,
    index: index + 1,
    sourceEpisode: video.sourceEpisode ?? video.episode,
    episode: episode ?? video.episode,
  }));
  const manifest = {
    ...incoming,
    environment: incoming.environment || cfg.environment,
    verified: options.verified === true,
    uiEpisodeStatus: episode ? 'operator_configured_pending_ui_check' : 'from_manifest',
    videos,
  };
  const target = resolve(dirname(path), options.output || 'production-manifest.json');
  await writeJson(target, manifest);
  const original = JSON.parse(await readFile(path, 'utf8'));
  original.manifestFile = target;
  original.experimentId = incoming.experimentId || original.experimentId;
  await writeJson(path, original);
  console.log(
    `已导入 ${videos?.length || 0} 条；verified=${manifest.verified}，运行仍逐条核对 UI 集号。${target}`
  );
}

function coordinates(value, length) {
  if (typeof value !== 'string') return null;
  const numbers = value.split(',').map(Number);
  if (numbers.length !== length || numbers.some((n) => !Number.isFinite(n)))
    fail('args', '坐标格式错误');
  return numbers;
}

async function calibrate(cfg, path, options, ui, device) {
  const manifest = await loadManifest(cfg);
  const video = manifest.videos[Number(options.video || 1) - 1];
  if (!video) fail('args', '校准视频序号不存在');
  const layout = options.layout;
  if (!['feed', 'detail'].includes(layout))
    fail('calibration', '校准需要 --layout feed 或 --layout detail，避免混用两种进度条位置');
  const blank = coordinates(options.blank, 2);
  if (blank) cfg.calibration.blankPoint = { x: blank[0], y: blank[1] };
  const rows = await ui.snapshot({ forceOCR: true });
  const progress = coordinates(options.progress, 3);
  const native = rows.find(
    (row) =>
      row.native && row.text === '播放进度' && row.width > device.rect.width / 2 && row.height <= 80
  );
  if (progress)
    cfg.calibration.progress = { left: progress[0], y: progress[1], right: progress[2] };
  else if (native)
    cfg.calibration.progress = {
      left: native.x,
      y: native.y + native.height / 2,
      right: native.x + native.width,
    };
  if (!cfg.calibration.blankPoint || !cfg.calibration.progress)
    fail(
      'calibration',
      '按 inspect 图片填写 --blank x,y 和 --progress left,y,right（XCTest点坐标）'
    );
  if (!readProgress(rows)) fail('calibration', '校准为只读，请先手动显示播放控件');
  const playing = await ui.waitPlaying(video, cfg.timing.startupSeconds, null, {
    revealControls: false,
  });
  const calibration = {
    ...cfg.calibration,
    screen: { width: device.rect.width, height: device.rect.height },
    layout,
    progressByLayout: { ...cfg.calibration.progressByLayout, [layout]: cfg.calibration.progress },
    verified: true,
    checkedAt: new Date().toISOString(),
  };
  console.log(
    JSON.stringify(
      {
        calibration,
        observed: { current: playing.current, duration: playing.duration },
        saved: options.confirm === true,
      },
      null,
      2
    )
  );
  if (options.confirm === true) {
    const raw = JSON.parse(await readFile(path, 'utf8'));
    raw.calibration = calibration;
    await writeJson(path, raw);
  }
}

async function live(command, cfg, path, options) {
  validateLive(cfg);
  const unlock = await lockDevice(cfg);
  const device = new Device(cfg);
  try {
    await device.open();
    const ui = new UI(device, cfg);
    if (command === 'calibrate') return await calibrate(cfg, path, options, ui, device);
    const directory = resolve(
      cfg.output,
      `inspect-${new Date().toISOString().replace(/[:.]/g, '-')}`
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const rows = await ui.snapshot({ saveTo: resolve(directory, 'screen'), forceOCR: true });
    await writeJson(resolve(directory, 'rows.json'), rows);
    console.log(
      JSON.stringify(
        {
          directory,
          screenPoints: device.rect,
          readableProgress: readProgress(rows),
          rows: rows.length,
        },
        null,
        2
      )
    );
  } finally {
    await device.close();
    await unlock();
  }
}

async function main() {
  const { command, options } = argumentsOf(process.argv.slice(2));
  const path = resolve(options.config || configPath);
  if (command === 'help')
    return console.log(
      '命令：init | configure | import-manifest | check | plan | compile-ocr | inspect | capture | calibrate | run。完整用法见同目录 README.md'
    );
  if (command === 'init') return init(path, options);
  if (command === 'configure') return configure(path, options);
  if (command === 'import-manifest') return importManifest(path, options);
  if (command === 'compile-ocr') return console.log(await compileVision());
  const cfg = await loadConfig(path);
  if (['inspect', 'capture', 'calibrate'].includes(command))
    return live(command, cfg, path, options);
  const manifest = await loadManifest(cfg, { allowUnverified: command === 'plan' });
  const selectedEntries = options.entries ? String(options.entries).split(',') : cfg.entries;
  if (!selectedEntries.length || selectedEntries.some((entry) => !entries.includes(entry)))
    fail('args', '入口名称无效');
  if (options.rounds) cfg.rounds = Number(options.rounds);
  if (!Number.isInteger(cfg.rounds) || cfg.rounds < 1 || cfg.rounds > 100)
    fail('args', '--rounds 必须为 1–100');
  const params = {
    limit: Number(options.limit || 30),
    selectedEntries,
    resume: options.resume === true,
    ackReset: options['ack-reset'] === true,
  };
  if (command === 'plan')
    return console.log(
      JSON.stringify(
        {
          touches: false,
          manifestVerified: manifest.verified === true,
          account: cfg.account.alias || 'unverified',
          group: cfg.account.group || 'unverified',
          groupVerified:
            cfg.account.verified === true && cfg.account.verifiedExperimentId === cfg.experimentId,
          calibrationVerified: cfg.calibration.verified === true,
          deployedReleaseRecorded: Boolean(cfg.release),
          environment: cfg.environment,
          experimentId: cfg.experimentId,
          actions: plan(cfg, manifest, params),
        },
        null,
        2
      )
    );
  if (command === 'check') {
    validateRun(cfg);
    return console.log('静态配置检查通过；未连接手机、未发送触摸，不代表真机通过');
  }
  if (command === 'run')
    return console.log(JSON.stringify(await run(cfg, manifest, params), null, 2));
  fail('args', '未知命令，请运行 help');
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      error: error.code || 'unexpected',
      message: error.code ? error.message : '执行失败，请检查本机配置及运行条件',
    })
  );
  process.exitCode = 1;
});
