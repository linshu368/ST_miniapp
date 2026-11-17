import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { configPath, fail, fingerprint, validateRun } from './config.mjs';
import { Device, sleep } from './webdriver.mjs';
import { UI, readProgress } from './ui.mjs';
import { Scenes } from './scenes.mjs';

export function plan(cfg, manifest, { limit = 30, selectedEntries = cfg.entries } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 30) fail('args', '--limit 必须为 1–30');
  const actions = [];
  for (let round = 1; round <= cfg.rounds; round += 1) {
    for (const entry of selectedEntries) {
      for (const video of manifest.videos.slice(0, limit))
        actions.push({ round, entry, index: video.index });
    }
  }
  return actions;
}

async function checkpoint(path, data) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export async function lockDevice(cfg) {
  const name = createHash('sha256').update(cfg.udid).digest('hex').slice(0, 16);
  const directory = resolve(dirname(configPath), 'locks');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = resolve(directory, `device-${name}.lock`);
  let file;
  try {
    file = await open(path, 'wx', 0o600);
  } catch {
    fail('lock', '此设备存在采样锁。确认原进程退出后手动移除本地锁文件');
  }
  await file.writeFile(String(process.pid));
  await file.close();
  return () => unlink(path);
}

async function sample(ui, scenes, cfg, video, log) {
  await log('startup_wait', {});
  await ui.waitPlaying(video, cfg.timing.startupSeconds);
  const controls = await ui.controls();
  const speed = controls.find((row) => /播放速度\s*[\d.]+\s*倍/.test(row.text));
  if (speed && !/播放速度\s*1\s*倍/.test(speed.text)) {
    await ui.tap(/播放速度\s*[\d.]+\s*倍/);
    await ui.tap('1 倍');
    await log('speed_normalized', { speed: 1 });
  }
  await sleep(cfg.timing.beforeSeekSeconds * 1000, ui.device.abort.signal);
  const rows = await ui.controls();
  await ui.assertVideo(video, rows);
  const progress = readProgress(rows);
  if (!progress) fail('locate', '快进前无法读取进度', false);
  const target = progress.duration * cfg.seekFraction;
  if (target <= progress.current + 2 || progress.duration - target < 10)
    fail('seek_space', '没有满足约束的向前快进空间', false);
  // Prove playback is still advancing immediately before pointer-down, not merely after entry.
  const latest = await ui.waitPlaying(video, 12);
  if (latest.current >= target - 2) fail('seek_space', '等待期间已越过快进目标', false);
  await log('seek_submit', {
    fromSeconds: latest.current,
    targetSeconds: target,
    buffered: 'unobservable',
  });
  await ui.seek(latest, target);
  await ui.waitPlaying(video, cfg.timing.seekSeconds, target);
  await log('seek_ui_resumed', { metricOwner: 'existing_telemetry', buffered: 'unobservable' });
  await sleep(cfg.timing.afterSeekSeconds * 1000, ui.device.abort.signal);
  await scenes.normalize(video);
}

async function runActions(device, cfg, manifest, actions, state, stateFile, log, stopping) {
  const ui = new UI(device, cfg),
    scenes = new Scenes(ui, manifest, log);
  let locateFailures = 0;
  let captures = 0;
  const started = Date.now();
  for (let cursor = state.cursor; cursor < actions.length; cursor += 1) {
    if (stopping() || Date.now() - started >= cfg.maxHours * 3600000) break;
    const action = actions[cursor],
      video = manifest.videos[action.index - 1];
    state.active = action;
    await checkpoint(stateFile, state);
    const record = async (event, extra) => {
      state.active = { ...action, stage: event };
      await checkpoint(stateFile, state);
      await log(event, { ...action, ...extra });
    };
    try {
      await device.foreground();
      await scenes.enter(action.entry, video);
      await record('sample_begin', {});
      await sample(ui, scenes, cfg, video, record);
      locateFailures = 0;
      await record('ui_completed', {});
    } catch (error) {
      const failedStage = state.active.stage;
      if (['seek_submit', 'seek_ui_resumed'].includes(failedStage)) state.requiresReset = true;
      await record('failed', { code: error.code || 'unexpected', message: safeMessage(error) });
      if (error.fatal !== false) throw error;
      if (['locate', 'identity', 'play_timeout'].includes(error.code)) locateFailures += 1;
      if (locateFailures >= 3) fail('consecutive', '连续3项未能确认定位/播放，保存断点后停止');
      if (error.code !== 'not_applicable') {
        if (captures++ < 20) {
          const capture = resolve(cfg.output, state.runId, `failure-${cursor}`);
          await ui.snapshot({ saveTo: capture }).catch(() => {});
        }
        // Reset only when the player is known to be playing (seek_space). A timed-out seek
        // may still be in flight: leave it untouched and require an operator reset before resume.
        try {
          if (error.code === 'seek_space') await scenes.normalize(video);
          else await scenes.leave();
        } catch (recoveryError) {
          await record('recovery_failed', { code: recoveryError.code || 'unexpected' });
          throw recoveryError;
        }
        if (['seek_submit', 'seek_ui_resumed'].includes(failedStage)) {
          state.requiresReset = true;
          await record('manual_reset_required', {
            reason: '快进流程中断，需人工将目标集回到片头并重新校准进度',
          });
          fail('reset_required', '未确认快进后的复位；已离开播放页，人工复位后再恢复');
        }
      }
    }
    state.cursor = cursor + 1;
    state.active = null;
    await checkpoint(stateFile, state);
    await sleep(cfg.timing.gapSeconds * 1000, device.abort.signal);
    const next = actions[cursor + 1];
    if (next && (next.entry !== action.entry || next.round !== action.round)) {
      await scenes.leave();
      await log('batch_rest', { seconds: cfg.timing.batchRestSeconds });
      await sleep(cfg.timing.batchRestSeconds * 1000, device.abort.signal);
    }
  }
}

export async function run(cfg, manifest, options) {
  validateRun(cfg);
  const actions = plan(cfg, manifest, options);
  const digest = fingerprint(cfg, { manifest, actions });
  await mkdir(cfg.output, { recursive: true, mode: 0o700 });
  const unlock = await lockDevice(cfg);
  const stateFile = resolve(cfg.output, `${cfg.account.alias}.checkpoint.json`);
  const device = new Device(cfg);
  let stop = false;
  const onStop = () => {
    stop = true;
    device.stop();
  };
  process.on('SIGINT', onStop);
  process.on('SIGTERM', onStop);
  try {
    let state = {
      runId: `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`,
      fingerprint: digest,
      cursor: 0,
      active: null,
    };
    if (options.resume) {
      state = JSON.parse(await readFile(stateFile, 'utf8'));
      if (state.fingerprint !== digest) fail('resume', '参数、账号或片单改变，不能恢复旧断点');
      if (
        (state.requiresReset || ['seek_submit', 'seek_ui_resumed'].includes(state.active?.stage)) &&
        !options.ackReset
      )
        fail('reset_required', '上次在快进阶段中断，先人工复位再用 --resume --ack-reset');
      state.requiresReset = false;
      if (state.active) state.interrupted = state.active;
    }
    const directory = resolve(cfg.output, state.runId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const logFile = await open(resolve(directory, 'actions.jsonl'), 'a', 0o600);
    try {
      let logBytes = (await logFile.stat()).size;
      const log = async (event, fields) => {
        const line = `${JSON.stringify({ at: new Date().toISOString(), runId: state.runId, environment: cfg.environment, experimentId: cfg.experimentId, release: cfg.release, account: cfg.account.alias, group: cfg.account.group, event, ...fields })}\n`;
        logBytes += Buffer.byteLength(line);
        if (logBytes > 64 * 1024 * 1024) fail('log_limit', '本轮日志已达64MiB上限，停止以保留断点');
        await logFile.write(line);
        console.log(JSON.stringify({ event, ...fields }));
      };
      await log('run_begin', {
        resume: options.resume || false,
        interrupted: state.interrupted || null,
        planned: actions.length,
      });
      await device.open();
      if (
        device.rect.width !== cfg.calibration.screen.width ||
        device.rect.height !== cfg.calibration.screen.height
      )
        fail('calibration', '设备尺寸变化，请重新校准');
      await runActions(device, cfg, manifest, actions, state, stateFile, log, () => stop);
      await log(state.cursor === actions.length ? 'run_complete' : 'run_stopped', {
        cursor: state.cursor,
        planned: actions.length,
      });
      return { cursor: state.cursor, planned: actions.length, directory };
    } finally {
      await logFile.close();
    }
  } finally {
    await device.close();
    await unlock();
    process.removeListener('SIGINT', onStop);
    process.removeListener('SIGTERM', onStop);
  }
}

function safeMessage(error) {
  return error.code ? error.message.slice(0, 180) : '未预期错误，详细信息未写入采样日志';
}
