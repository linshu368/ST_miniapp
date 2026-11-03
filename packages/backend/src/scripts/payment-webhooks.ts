/**
 * Vexutopia Webhook 端点管理（运维一次性操作）。
 *
 *   pnpm --filter @miniapp/backend payment:webhooks list
 *   pnpm --filter @miniapp/backend payment:webhooks register https://<backend>/api/payment/webhook/vexutopia
 *   pnpm --filter @miniapp/backend payment:webhooks delete we_xxx
 *
 * 每个环境（production / development）各注册一个端点、各持一个 secret。
 * secret 只在注册时返回一次：这里直接打印到当前终端，不经过 pino、不落盘，
 * 操作者必须立刻把它写进该环境 Railway 的 VEXUTOPIA_WEBHOOK_SECRET。轮换 secret = 删掉重建。
 */
import '../platform/config.js';
import { VexutopiaPaymentGateway } from '../infrastructure/payment/VexutopiaPaymentGateway.js';

/** 只订阅会改变本地状态或需要人工处理的事件；其余状态由对账任务批量查单拿到。 */
const EVENTS = ['payment.completed', 'payment.refunded'];

const [command, argument] = process.argv.slice(2);
const gateway = new VexutopiaPaymentGateway();

try {
  if (command === 'list') {
    const endpoints = await gateway.listWebhooks();
    if (endpoints.length === 0) console.log('（没有已注册的端点）');
    for (const endpoint of endpoints) {
      console.log(
        `${endpoint.id}  ${endpoint.url}  events=${endpoint.events.join(',')}  ` +
          `mode=${endpoint.mode}  enabled=${endpoint.is_enabled ?? 'unknown'}`
      );
    }
  } else if (command === 'register' && argument) {
    const url = new URL(argument);
    if (url.protocol !== 'https:' || !url.pathname.endsWith('/api/payment/webhook/vexutopia')) {
      throw new Error('URL 必须是 https://<backend>/api/payment/webhook/vexutopia');
    }
    const endpoint = await gateway.registerWebhook(url.toString(), EVENTS);
    console.log(`已注册 ${endpoint.id} → ${endpoint.url}`);
    console.log('');
    console.log('下面的 secret 只显示这一次，请立刻写入该环境的 VEXUTOPIA_WEBHOOK_SECRET：');
    console.log(endpoint.secret);
  } else if (command === 'delete' && argument) {
    await gateway.deleteWebhook(argument);
    console.log(`已删除 ${argument}`);
  } else {
    console.log('用法：payment:webhooks list | register <https url> | delete <we_id>');
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
