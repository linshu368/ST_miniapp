import { test as base, expect, type Page } from '@playwright/test';
import { IDS, type Scenario } from '../fixtures/data.js';
import { PREVIEW_PROTOCOL } from '../fixtures/server.js';

export { expect, IDS };
const api = 'http://127.0.0.1:3131';
type PreviewState = {
  scenario: Scenario;
  claimed: boolean;
  wallet: { credits: number; main_credits: number; bonus_credits: number };
  requests: { method: string; path: string; thinking_enabled?: boolean }[];
  unhandled: string[];
};
type Preview = {
  scenario: (name: Scenario) => Promise<void>;
  state: () => Promise<PreviewState>;
  screenshot: (name: string, options?: { fullPage?: boolean }) => Promise<void>;
};

export const test = base.extend<{ preview: Preview }>({
  preview: [
    async ({ page, context, request }, use, testInfo) => {
      const health = await request.get(`${api}/__preview/health`);
      const identity = await health.json();
      expect(identity.protocol).toBe(PREVIEW_PROTOCOL);
      expect(identity.root).toBe(process.cwd());
      const errors: string[] = [];
      const blocked: string[] = [];
      const failedResponses: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('response', (response) => {
        if (response.url().includes('/api/') && response.status() >= 400)
          failedResponses.push(
            `${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`
          );
      });
      // Prevent a stale API setting or a new external dependency from silently hitting production.
      await context.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (['data:', 'blob:'].includes(url.protocol)) {
          await route.continue();
          return;
        }
        if (url.hostname === '127.0.0.1' && ['3130', '3131'].includes(url.port)) {
          await route.continue();
          return;
        }
        blocked.push(`${url.protocol}//${url.host}${url.pathname}`);
        await route.abort('blockedbyclient');
      });
      const preview: Preview = {
        scenario: async (name) => {
          // Close the previous document first, so its polling cannot mutate the next scenario.
          await page.goto('about:blank');
          const response = await request.post(`${api}/__preview/reset`, {
            data: { scenario: name },
          });
          expect(response.ok()).toBeTruthy();
        },
        state: async () => (await request.get(`${api}/__preview/state`)).json(),
        screenshot: async (name, options) => {
          await testInfo.attach(name, {
            body: await page.screenshot({
              fullPage: options?.fullPage ?? true,
              path: testInfo.outputPath(`${name}.png`),
            }),
            contentType: 'image/png',
          });
        },
      };
      await preview.scenario('standard');
      await use(preview);
      const state = await preview.state();
      await testInfo.attach('diagnostics.json', {
        body: JSON.stringify({ errors, blocked, failedResponses, ...state }, null, 2),
        contentType: 'application/json',
      });
      expect(errors, '页面不应出现未处理异常').toEqual([]);
      expect(blocked, '页面不应连接外部服务；新增依赖需显式准备本地 fixture').toEqual([]);
      expect(state.unhandled, '新增 API 必须补充固定 fixture，不能静默通过').toEqual([]);
    },
    { auto: true },
  ],
});

export const chatPath = `/chat/${IDS.character}?session=${IDS.session}&from=discover`;
export const studioPath = `/create/studio/${IDS.studio}`;

export async function expectMobileLayout(page: Page) {
  const size = await page.evaluate(() => ({
    width: innerWidth,
    content: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
  }));
  expect(size.content, '页面不应横向溢出').toBeLessThanOrEqual(size.width + 1);
}

export async function sendChat(page: Page, content = '我们继续沿着小径走吧。') {
  await page.getByRole('textbox', { name: '输入消息' }).fill(content);
  await page.getByRole('button', { name: '发送', exact: true }).click();
}
