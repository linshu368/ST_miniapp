/**
 * Surplus 账单明细（GET /buyer/usage/export?format=csv&from&to）：每次调用一行，带请求号、
 * 模型、token 与实际扣费。接口 302 到一个临时下载地址，跟过去时不带我们的密钥。
 * 时间列是调用结束（结算）的时间，不是发出时间。
 */
import { clientFetch } from '../../platform/observability/fetch.js';
import { getLlmProviderRuntimeConfig } from '../../platform/runtime-config.js';

const fetch = clientFetch('free_zone.usage_export', 'surplus');
const MAX_BYTES = 32 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

export interface SurplusUsageRow {
  requestId: string;
  /** 结算时间（毫秒） */
  createdAt: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** 原样保留十进制字符串，避免浮点误差 */
  costUsd: string;
}

/** RFC 4180 的一行：逗号分隔，双引号包裹，"" 表示引号本身 */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        field += '"';
        index++;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      fields.push(field);
      field = '';
    } else field += char;
  }
  fields.push(field);
  return fields;
}

const DECIMAL = /^\d+(\.\d+)?$/;

export function parseSurplusUsageCsv(text: string): SurplusUsageRow[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  const header = splitCsvLine(lines[0] ?? '');
  const column = (name: string) => header.indexOf(name);
  const at = {
    id: column('request_id'),
    created: column('created_at'),
    model: column('model'),
    input: column('input_tokens'),
    output: column('output_tokens'),
    cost: column('buyer_cost_usd'),
  };
  if (Object.values(at).some((index) => index < 0)) throw new Error('Surplus 账单明细缺少必需列');
  const rows: SurplusUsageRow[] = [];
  for (const line of lines.slice(1)) {
    const fields = splitCsvLine(line);
    const requestId = fields[at.id] ?? '';
    const createdAt = Date.parse(fields[at.created] ?? '');
    const cost = fields[at.cost] ?? '';
    if (!/^[a-zA-Z0-9_.:-]{1,512}$/.test(requestId) || !Number.isFinite(createdAt)) continue;
    if (!DECIMAL.test(cost)) continue;
    rows.push({
      requestId,
      createdAt,
      model: fields[at.model] ?? '',
      inputTokens: Number(fields[at.input]) || 0,
      outputTokens: Number(fields[at.output]) || 0,
      costUsd: cost,
    });
  }
  return rows;
}

async function readBounded(response: Response): Promise<string> {
  if (!response.body) throw new Error('Surplus 账单明细没有内容');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_BYTES) throw new Error('Surplus 账单明细超过容量');
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks, bytes).toString('utf8');
}

/** 拉 [from, to] 之间结算的全部调用。拿不到抛错，由调用方本轮跳过。 */
export async function fetchSurplusUsage(from: Date, to: Date): Promise<SurplusUsageRow[]> {
  const { apiKey, baseUrl } = getLlmProviderRuntimeConfig('surplus');
  if (!apiKey) throw new Error('缺少 Surplus 密钥');
  const query = new URLSearchParams({
    format: 'csv',
    from: from.toISOString(),
    to: to.toISOString(),
  });
  const first = await fetch(`${baseUrl.replace(/\/+$/, '')}/buyer/usage/export?${query}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'text/csv' },
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let response = first;
  if (first.status >= 300 && first.status < 400) {
    await first.body?.cancel().catch(() => undefined);
    const location = first.headers.get('location');
    if (!location?.startsWith('https://')) throw new Error('Surplus 账单明细跳转地址异常');
    // 临时下载地址自带签名，不能把密钥带过去
    response = await fetch(location, {
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Surplus 账单明细 HTTP ${response.status}`);
  }
  return parseSurplusUsageCsv(await readBounded(response));
}
