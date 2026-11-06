import { fail } from './config.mjs';

export const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(stoppedError());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(stoppedError());
    };
    signal?.addEventListener('abort', abort, { once: true });
  });

function stoppedError() {
  return Object.assign(new Error('收到停止请求，未继续发送触摸'), { code: 'stopped', fatal: true });
}

export class Device {
  constructor(cfg) {
    this.cfg = cfg;
    this.session = null;
    this.rect = null;
    this.abort = new AbortController();
  }

  stop() {
    this.abort.abort();
  }
  assertRunning() {
    if (this.abort.signal.aborted) throw stoppedError();
  }

  async request(method, path, body, timeout = 25000) {
    let response;
    try {
      response = await fetch(`${this.cfg.server.replace(/\/$/, '')}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
    } catch {
      fail('transport', 'Appium 连接失败或命令超时；不确定的触摸不会自动重发');
    }
    const result = await response.json().catch(() => null);
    if (!response.ok || result?.value?.error)
      fail('webdriver', `Appium 返回 ${result?.value?.error || response.status}`);
    return result.value;
  }

  async open() {
    await this.request('GET', '/status');
    const value = await this.request(
      'POST',
      '/session',
      {
        capabilities: {
          alwaysMatch: {
            platformName: 'iOS',
            'appium:automationName': 'XCUITest',
            'appium:udid': this.cfg.udid,
            'appium:bundleId': this.cfg.bundleId,
            'appium:updatedWDABundleId': this.cfg.wdaBundleId,
            'appium:noReset': true,
            'appium:fullReset': false,
            'appium:autoLaunch': false,
            'appium:forceAppLaunch': false,
            'appium:shouldTerminateApp': false,
            'appium:useNewWDA': false,
            'appium:newCommandTimeout': 180,
            'appium:wdaLaunchTimeout': 60000,
            'appium:wdaConnectionTimeout': 25000,
          },
        },
      },
      90000
    );
    this.session = value.sessionId;
    if (!this.session) fail('session', 'Appium 未返回 sessionId');
    try {
      this.assertRunning();
      await this.request('POST', this.path('/context'), { name: 'NATIVE_APP' });
      this.rect = await this.request('GET', this.path('/window/rect'));
    } catch (error) {
      await this.close();
      throw error;
    }
    return this;
  }

  path(suffix) {
    return `/session/${this.session}${suffix}`;
  }
  execute(script, args = {}) {
    this.assertRunning();
    return this.request('POST', this.path('/execute/sync'), { script, args: [args] });
  }

  async foreground() {
    const info = await this.execute('mobile: activeAppInfo');
    if (info.bundleId !== this.cfg.bundleId)
      fail('foreground', 'Telegram 不在前台，已停止。请手动打开 Mini App 后恢复');
    const alert = await this.request('POST', this.path('/elements'), {
      using: 'class name',
      value: 'XCUIElementTypeAlert',
    });
    if (alert.length) fail('alert', '检测到系统弹窗，请人工处理后恢复');
  }

  source() {
    return this.request('GET', this.path('/source'));
  }
  screenshot() {
    return this.request('GET', this.path('/screenshot'));
  }

  async tap(x, y) {
    this.assertRunning();
    await this.foreground();
    await this.execute('mobile: tap', { x: Math.round(x), y: Math.round(y) });
    await sleep(550, this.abort.signal);
  }

  async drag(from, to, seconds = 0.6) {
    this.assertRunning();
    await this.foreground();
    await this.execute('mobile: dragFromToForDuration', {
      duration: seconds,
      fromX: Math.round(from.x),
      fromY: Math.round(from.y),
      toX: Math.round(to.x),
      toY: Math.round(to.y),
    });
    await sleep(550, this.abort.signal);
  }

  async type(text) {
    this.assertRunning();
    await this.foreground();
    await this.request('POST', this.path('/keys'), { value: [...text] });
    await sleep(700, this.abort.signal);
  }

  async close() {
    if (this.session) await this.request('DELETE', this.path(''), undefined, 10000).catch(() => {});
    this.session = null;
  }
}
