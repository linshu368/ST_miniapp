import { createServer, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import {
  CreateDramaCommentSchema,
  SetDramaLikeSchema,
  type DramaComment,
  type GetDramaSocialData,
  type GetDramaCommentsData,
  type CreateDramaCommentData,
  ImagePlazaConversationSchema,
  ImagePlazaQuoteRequestSchema,
  PatchGenerationConfigRequestSchema,
  PatchUserSettingsRequestSchema,
  SelectModelRequestSchema,
  SubmitImagePlazaAttemptRequestSchema,
  type ChatMessage,
  type ConversationStreamEvent,
  type ImagePlazaAttempt,
  type GetDramasData,
  type GetDramaByIdData,
  type GetDramaPlaybackData,
  type GetSupportConversationData,
} from '@miniapp/shared';
import {
  IDS,
  isScenario,
  later,
  makeData,
  scenarios,
  stamp,
  voiceConfig,
  chatImageConfig,
  type Scenario,
} from './data.js';

const HOST = '127.0.0.1';
const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString();
export const PREVIEW_PROTOCOL = 'st-miniapp-ui-v1';

/** One state per local environment; the runner is deliberately serial. No production proxy. */
export function createPreviewServer(apiPort: number, appPort: number) {
  const api = `http://${HOST}:${apiPort}`;
  const app = `http://${HOST}:${appPort}`;
  let data = makeData(api);
  let scenario: Scenario = 'standard';
  let claimed = false;
  let epoch = 0;
  let favoriteIds = new Set<string>();
  const dramaLikes = new Set<string>();
  const dramaComments = new Map<string, DramaComment[]>();
  let commentFailureDelivered = false;
  function commentsFor(id: string) {
    if (!dramaComments.has(id)) {
      const samples = [
        '这个开头留了悬念，想看后面怎么解释。',
        '喜欢这种不拖沓的节奏。',
        '刚看到第二集，细节终于连起来了。',
      ];
      dramaComments.set(
        id,
        Array.from({ length: 23 }, (_, i) => ({
          id: `80000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
          author: `剧友 ${String(i + 1).padStart(6, '0')}`,
          is_mine: false,
          body: i < 3 ? samples[i]! : `这是第 ${i + 1} 位演示观众的追剧感受。`,
          created_at: new Date(Date.now() - (i + 1) * 3600_000).toISOString(),
        }))
      );
    }
    return dramaComments.get(id)!;
  }
  const socialFor = (id: string) => ({
    liked: dramaLikes.has(id),
    like_count: 127 + Number(dramaLikes.has(id)),
    comment_count: commentsFor(id).length,
  });
  let pendingImages = new Map<
    string,
    { readyAt: number; failed: boolean; attempt: ImagePlazaAttempt }
  >();
  const imageKeys = new Map<string, ImagePlazaAttempt>();
  const quotes = new Map<string, { credits: number; expiresAt: number }>();
  const streams = new Set<ServerResponse>();
  const requests: { method: string; path: string; thinking_enabled?: boolean }[] = [];
  const unhandled: string[] = [];

  function reset(next: Scenario) {
    epoch += 1;
    for (const stream of streams) stream.end();
    streams.clear();
    data = makeData(api);
    scenario = next;
    claimed = next === 'checked';
    favoriteIds = new Set();
    pendingImages = new Map();
    dramaLikes.clear();
    dramaComments.clear();
    commentFailureDelivered = false;
    imageKeys.clear();
    quotes.clear();
    requests.length = 0;
    unhandled.length = 0;
    if (next === 'recharge' || next === 'recharge-unavailable') {
      const basePlan = data.plans.plans[0]!;
      data.plans.plans = [
        { ...basePlan, variant: 'entry', badge_text: null, highlight_text: null },
        {
          ...basePlan,
          id: 'preview-credits-30',
          price_cents: 3000,
          original_price_cents: 3600,
          credits_amount: 18000,
          bonus_credits: 3600,
          badge_text: '推荐',
          highlight_text: null,
        },
        {
          ...basePlan,
          id: 'preview-credits-68',
          variant: 'standard',
          price_cents: 6800,
          original_price_cents: 8800,
          credits_amount: 40800,
          bonus_credits: 10200,
          badge_text: null,
          highlight_text: null,
        },
        {
          ...basePlan,
          id: 'preview-credits-128',
          variant: 'premium',
          price_cents: 12800,
          original_price_cents: 16800,
          credits_amount: 76800,
          bonus_credits: 27200,
          badge_text: null,
          highlight_text: null,
        },
      ];
    }
    if (next === 'recharge-empty') data.plans.plans = [];
    if (next === 'recharge-unavailable')
      data.plans.payment_channels = {
        alipay_enabled: false,
        wxpay_enabled: false,
        default_payment_type: 'alipay',
      };
    if (next === 'vip')
      Object.assign(data.vip, {
        active: true,
        remaining_days: 31,
        valid_from: stamp(),
        valid_until: later(),
        last_plan_id: 'month',
        entry_badge_visible: false,
      });
    if (next === 'empty') {
      data.dramas = [];
      data.characters = [];
      data.sessions = [];
      data.works = [];
    }
    if (next === 'no-balance')
      Object.assign(data.wallet, {
        credits: 0,
        total_credits: 0,
        main_credits: 0,
        bonus_credits: 0,
      });
  }

  function creditBonus(amount: number) {
    data.wallet.bonus_credits += amount;
    data.wallet.credits += amount;
    data.wallet.total_credits += amount;
  }

  function reconcileImages() {
    for (const [id, pending] of pendingImages) {
      if (Date.now() < pending.readyAt || scenario === 'image-pending') continue;
      const attempt = pending.attempt;
      attempt.status = pending.failed ? 'failed' : 'ready';
      attempt.updated_at = stamp();
      attempt.error_code = pending.failed ? 'provider_error' : null;
      if (!pending.failed) {
        attempt.artifacts = [
          { id: randomUUID(), image_url: `${api}/assets/scene.svg`, width: 768, height: 1024 },
        ];
        data.wallet.main_credits -= attempt.quote_credits;
        data.wallet.credits -= attempt.quote_credits;
        data.wallet.total_credits -= attempt.quote_credits;
      }
      pendingImages.delete(id);
    }
  }

  function json(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }
  const ok = (res: ServerResponse, value: unknown) =>
    json(res, 200, { success: true, data: value });
  const fail = (res: ServerResponse, status: number, code: string, message: string) =>
    json(res, status, { success: false, error: { code, message } });

  const server = createServer(async (req, res) => {
    // Host and Origin checks keep the state-changing controls local, including DNS rebinding.
    if (req.headers.host !== `${HOST}:${apiPort}`) {
      fail(res, 403, 'local_only', '仅限本地预览');
      return;
    }
    const origin = req.headers.origin;
    if (origin && origin !== app && origin !== api) {
      fail(res, 403, 'local_only', '不接受外部来源');
      return;
    }
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Request-Id, X-Init-Data');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    const url = new URL(req.url ?? '/', api);
    const path = url.pathname;
    const method = req.method ?? 'GET';
    try {
      let raw = '';
      for await (const chunk of req) {
        raw += chunk.toString();
        if (raw.length > 65_536) {
          fail(res, 413, 'body_too_large', '预览请求过大');
          return;
        }
      }
      const body: unknown = raw ? JSON.parse(raw) : {};
      if (path === '/__preview/health' && method === 'GET') {
        json(res, 200, { protocol: PREVIEW_PROTOCOL, root: process.cwd(), app, api });
        return;
      }
      if (path === '/__preview/state' && method === 'GET') {
        reconcileImages();
        json(res, 200, { scenario, claimed, wallet: data.wallet, requests, unhandled });
        return;
      }
      if (path === '/__preview/reset' && method === 'POST') {
        const requested =
          typeof body === 'object' && body !== null && 'scenario' in body
            ? body.scenario
            : undefined;
        if (!isScenario(requested)) {
          fail(res, 400, 'invalid_scenario', '请选择已定义场景');
          return;
        }
        reset(requested);
        json(res, 200, { scenario });
        return;
      }
      if (path === '/' && method === 'GET') {
        const html = await readFile(new URL('./hub.html', import.meta.url), 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          html.replace('__BOOTSTRAP__', JSON.stringify({ app, scenarios, current: scenario }))
        );
        return;
      }
      if (path === '/assets/scene.svg' && method === 'GET') {
        const tone = Number(url.searchParams.get('tone') ?? 0) % 3;
        const colors = ['#afa9ef', '#93c8b6', '#debda3'];
        res.writeHead(200, {
          'Content-Type': 'image/svg+xml',
          'Cache-Control': 'public, max-age=3600',
        });
        res.end(
          `<svg xmlns="http://www.w3.org/2000/svg" width="768" height="1024" viewBox="0 0 768 1024"><defs><linearGradient id="g" x2="0" y2="1"><stop stop-color="${colors[tone] ?? colors[0]}"/><stop offset="1" stop-color="#20243a"/></linearGradient></defs><path fill="url(#g)" d="M0 0h768v1024H0z"/><circle fill="#f9eaca" opacity=".8" cx="540" cy="240" r="72"/><path fill="#484e6d" d="M0 640 240 330 480 670 650 470 768 580V1024H0"/><path fill="#27394b" d="M0 790 200 580 430 850 600 700 768 810V1024H0"/><path fill="#b3cbd4" opacity=".5" d="M320 1024 400 810 430 850 460 1024z"/></svg>`
        );
        return;
      }

      if (path === '/assets/drama-preview.mp4' && (method === 'GET' || method === 'HEAD')) {
        const video = await readFile(new URL('./assets/drama-preview.mp4', import.meta.url));
        const range = req.headers.range;
        const match = range?.match(/^bytes=(\d*)-(\d*)$/);
        const suffix = match && !match[1] ? Number(match[2]) : null;
        const start =
          suffix !== null ? Math.max(0, video.length - suffix) : Number(match?.[1] || 0);
        const end =
          match?.[2] && suffix === null
            ? Math.min(Number(match[2]), video.length - 1)
            : video.length - 1;
        if (
          range &&
          (!match ||
            (!match[1] && !match[2]) ||
            suffix === 0 ||
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(end) ||
            start > end ||
            start >= video.length)
        ) {
          res.writeHead(416, { 'Content-Range': `bytes */${video.length}` }).end();
          return;
        }
        res.writeHead(range ? 206 : 200, {
          'Content-Type': 'video/mp4',
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1,
          'Cache-Control': 'public, max-age=3600',
          ...(range ? { 'Content-Range': `bytes ${start}-${end}/${video.length}` } : {}),
        });
        res.end(method === 'HEAD' ? undefined : video.subarray(start, end + 1));
        return;
      }

      const request = {
        method,
        path,
        ...(typeof body === 'object' &&
        body !== null &&
        'thinking_enabled' in body &&
        typeof body.thinking_enabled === 'boolean'
          ? { thinking_enabled: body.thinking_enabled }
          : {}),
      };
      requests.push(request);
      if (requests.length > 500) requests.shift();
      reconcileImages();
      if (method === 'POST' && /^\/api\/telemetry\/(page|action|drama|request)/.test(path)) {
        ok(res, { recorded: true });
        return;
      }
      if (path === '/api/dramas' && method === 'GET') {
        if (scenario === 'drama-list-error') {
          fail(res, 503, 'preview_unavailable', '目录暂不可用');
          return;
        }
        const dramas = data.dramas.map(({ videos, ...drama }) => ({
          ...drama,
          episode_count: videos.length,
        }));
        ok(res, { dramas } satisfies GetDramasData);
        return;
      }
      const interaction = path.match(
        /^\/api\/dramas\/([^/]+)\/(social|like|comments)(?:\/([^/]+))?$/
      );
      if (interaction) {
        const [, id, action, commentId] = interaction;
        if (!id || !data.dramas.some((item) => item.id === id)) {
          fail(res, 404, 'NOT_FOUND', '短剧不存在');
          return;
        }
        if (action === 'social' && method === 'GET') {
          ok(res, { social: socialFor(id) } satisfies GetDramaSocialData);
          return;
        }
        if (action === 'like' && method === 'PUT') {
          if (scenario === 'drama-interaction-error') {
            fail(res, 503, 'SERVICE_UNAVAILABLE', '点赞暂时不可用');
            return;
          }
          const input = SetDramaLikeSchema.parse(body);
          if (input.liked) dramaLikes.add(id);
          else dramaLikes.delete(id);
          ok(res, { social: socialFor(id) } satisfies GetDramaSocialData);
          return;
        }
        if (action === 'comments') {
          const comments = commentsFor(id);
          if (method === 'GET') {
            const offset = Number(url.searchParams.get('cursor') || 0);
            ok(res, {
              comments: comments.slice(offset, offset + 20),
              next_cursor: comments.length > offset + 20 ? String(offset + 20) : null,
            } satisfies GetDramaCommentsData);
            return;
          }
          if (method === 'POST') {
            const input = CreateDramaCommentSchema.parse(body);
            let comment = comments.find((item) => item.id === input.id);
            if (!comment) {
              comment = { ...input, author: '剧友 演示', is_mine: true, created_at: stamp() };
              comments.unshift(comment);
            }
            // Simulate a committed request with a lost response; retry must keep its UUID.
            if (scenario === 'drama-interaction-error' && !commentFailureDelivered) {
              commentFailureDelivered = true;
              fail(res, 503, 'SERVICE_UNAVAILABLE', '响应暂不可达');
              return;
            }
            ok(res, { comment } satisfies CreateDramaCommentData);
            return;
          }
          if (method === 'DELETE' && commentId) {
            const index = comments.findIndex((item) => item.id === commentId && item.is_mine);
            if (index >= 0) comments.splice(index, 1);
            ok(res, { deleted: true });
            return;
          }
        }
        fail(res, 405, 'METHOD_NOT_ALLOWED', '方法不支持');
        return;
      }
      const dramaRoute = path.match(/^\/api\/dramas\/([^/]+)(\/play)?$/);
      if (dramaRoute && method === 'GET') {
        const drama = data.dramas.find((item) => item.id === dramaRoute[1]);
        if (!drama) {
          fail(res, 404, 'NOT_FOUND', '短剧不存在');
          return;
        }
        if (!dramaRoute[2]) {
          ok(res, { drama } satisfies GetDramaByIdData);
          return;
        }
        if (scenario === 'drama-play-error') {
          fail(res, 503, 'preview_unavailable', '播放暂不可用');
          return;
        }
        const videoId = url.searchParams.get('video_id');
        const video = videoId ? drama.videos.find((item) => item.id === videoId) : drama.videos[0];
        if (!video) {
          fail(res, 404, 'NOT_FOUND', '视频不存在');
          return;
        }
        ok(res, {
          playback: {
            video_id: video.id,
            playable: true,
            play_url: `${api}/assets/drama-preview.mp4?episode=${video.id}`,
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          },
        } satisfies GetDramaPlaybackData);
        return;
      }
      if (path === '/api/users/settings') {
        if (method === 'PATCH')
          Object.assign(data.settings, PatchUserSettingsRequestSchema.parse(body));
        else if (method !== 'GET') {
          fail(res, 405, 'method_not_allowed', '方法不支持');
          return;
        }
        ok(res, { settings: data.settings });
        return;
      }
      if (path === '/api/wallet/balance' && method === 'GET') {
        ok(res, data.wallet);
        return;
      }
      if (path === '/api/wallet/checkin' && method === 'GET') {
        ok(res, {
          checkin: {
            can_claim: !claimed,
            last_claimed_at: claimed ? stamp() : null,
            next_claim_at: claimed ? tomorrow() : null,
            reward_credits: data.vip.active ? 150 : 30,
            base_reward_credits: 30,
            vip_reward_credits: 150,
          },
        });
        return;
      }
      if (path === '/api/wallet/checkin' && method === 'POST') {
        if (scenario === 'checkin-error') {
          fail(res, 503, 'preview_unavailable', '签到暂时未成功，请重试');
          return;
        }
        if (claimed) {
          fail(res, 409, 'already_claimed', '今日已签到');
          return;
        }
        claimed = true;
        const reward = data.vip.active ? 150 : 30;
        creditBonus(reward);
        ok(res, {
          wallet: data.wallet,
          checkin: {
            claimed_at: stamp(),
            next_claim_at: tomorrow(),
            reward_credits: reward,
            base_reward_credits: 30,
            vip_reward_credits: 150,
          },
        });
        return;
      }
      if (path === '/api/wallet/spending' && method === 'GET') {
        ok(res, { items: [] });
        return;
      }
      if (path.startsWith('/api/wallet/free-quota/') && method === 'GET') {
        ok(res, {
          character_id: path.split('/').pop(),
          quota_limit: 40,
          used_rounds: scenario === 'no-balance' ? 40 : 2,
          remaining_rounds: scenario === 'no-balance' ? 0 : 38,
          exhausted: scenario === 'no-balance',
          exhausted_dialog: { text: '免费体验已用完，补充星尘后继续。' },
        });
        return;
      }
      if (path === '/api/vip/status' && method === 'GET') {
        if (scenario === 'vip-error') fail(res, 503, 'preview_unavailable', '权益暂不可用');
        else ok(res, data.vip);
        return;
      }
      if (path === '/api/vip/entry-viewed' && method === 'POST') {
        data.vip.entry_badge_visible = false;
        ok(res, data.vip);
        return;
      }
      if (path === '/api/payment/plans' && method === 'GET') {
        if (scenario === 'recharge-error') {
          fail(res, 503, 'preview_unavailable', '充值套餐暂不可用');
          return;
        }
        ok(res, data.plans);
        return;
      }
      if (path === '/api/payment/orders' && method === 'GET') {
        ok(res, { items: [], next_cursor: null });
        return;
      }
      if (path === '/api/payment/orders' && method === 'POST') {
        fail(res, 409, 'preview_payment_disabled', '本地预览不创建真实支付订单');
        return;
      }
      if (path === '/api/community/entry' && method === 'GET') {
        ok(res, {
          enabled: true,
          title: '官方社群',
          description: '交流灵感，领取奖励',
          reward_credits: 100,
          telegram_url: 'https://t.me/preview_community',
          fallback_handle: '@preview_community',
          claim_status: scenario === 'community-joined' ? 'rewarded' : 'unclaimed',
          rewarded_at: null,
        });
        return;
      }
      if (path === '/api/notifications/unread-count' && method === 'GET') {
        ok(res, { official: 0, personal: 0, total: 0 });
        return;
      }
      if (path === '/api/support/unread' && method === 'GET') {
        ok(res, { has_unread: false });
        return;
      }
      if (path === '/api/support/conversation' && method === 'GET') {
        ok(res, { conversation: null } satisfies GetSupportConversationData);
        return;
      }
      if (path === '/api/invite/entry-status' && method === 'GET') {
        ok(res, { entry_enabled: false, center_entered: true });
        return;
      }
      if (path === '/api/notifications' && method === 'GET') {
        ok(res, { notifications: [], next_cursor: null });
        return;
      }
      if (path === '/api/characters/latest-badge' || path === '/api/characters/latest-seen') {
        ok(res, { has_new: false });
        return;
      }
      if (path === '/api/characters' && method === 'GET') {
        ok(res, {
          characters:
            url.searchParams.get('sort') === 'latest'
              ? [...data.characters].reverse()
              : data.characters,
        });
        return;
      }
      if (path.startsWith('/api/characters/') && method === 'GET') {
        const character = data.characters.find((item) => item.id === path.split('/').pop());
        if (character) ok(res, { character });
        else fail(res, 404, 'character_not_found', '角色不存在');
        return;
      }
      if (path === '/api/favorites/ids' && method === 'GET') {
        ok(res, { character_ids: [...favoriteIds] });
        return;
      }
      if (path === '/api/favorites' && method === 'GET') {
        ok(res, { characters: data.characters.filter((item) => favoriteIds.has(item.id)) });
        return;
      }
      if (path.startsWith('/api/favorites/') && ['PUT', 'DELETE'].includes(method)) {
        const id = path.split('/').pop()!;
        if (method === 'PUT') favoriteIds.add(id);
        else favoriteIds.delete(id);
        ok(res, { favorite: { character_id: id, favorited: favoriteIds.has(id) } });
        return;
      }
      if (path === '/api/v1/generation-config') {
        if (method === 'PATCH') {
          const patch = PatchGenerationConfigRequestSchema.parse(body);
          const styles = {
            ...data.generation.config.pref_reply_styles,
            ...patch.pref_reply_styles,
          };
          Object.assign(data.generation.config, patch, { pref_reply_styles: styles });
        } else if (method !== 'GET') {
          fail(res, 405, 'method_not_allowed', '方法不支持');
          return;
        }
        ok(res, data.generation);
        return;
      }
      if (path === '/api/v1/models/config' && method === 'GET') {
        ok(res, data.models);
        return;
      }
      if (path === '/api/v1/models/select' && method === 'POST') {
        const { model_id } = SelectModelRequestSchema.parse(body);
        if (model_id !== 'preview-light') {
          fail(res, 400, 'unknown_model', '预览模型不存在');
          return;
        }
        ok(res, { model_id, openrouter_model_id: 'preview/model' });
        return;
      }
      if (path === '/api/v1/conversations') {
        if (method === 'POST') {
          if (typeof body !== 'object' || body === null || !('character_id' in body))
            throw new Error('invalid character');
          const character = data.characters.find((item) => item.id === body.character_id);
          if (!character) {
            fail(res, 404, 'character_not_found', '角色不存在');
            return;
          }
          const session = {
            ...makeData(api).sessions[0]!,
            id: randomUUID(),
            character_id: character.id,
            title: character.name,
            message_count: 0,
            last_message_preview: null,
          };
          data.sessions.push(session);
          const greeting: ChatMessage = {
            ...makeData(api).messages[0]!,
            id: randomUUID(),
            session_id: session.id,
            content: character.greeting,
          };
          data.messages.push(greeting);
          ok(res, { session, messages: [greeting] });
          return;
        }
        if (method === 'GET') {
          const sessions = data.sessions.filter(
            (item) =>
              item.message_count > 0 &&
              (!url.searchParams.get('character_id') ||
                item.character_id === url.searchParams.get('character_id'))
          );
          ok(res, { sessions, total: sessions.length });
          return;
        }
      }
      if (path === '/api/v1/voice/config' && method === 'GET') {
        ok(res, voiceConfig);
        return;
      }
      if (path === '/api/v1/images/config' && method === 'GET') {
        ok(res, chatImageConfig);
        return;
      }
      if (/^\/api\/v1\/conversations\/[^/]+\/voice$/.test(path) && method === 'GET') {
        ok(res, { audio: [] });
        return;
      }
      if (/^\/api\/v1\/conversations\/[^/]+\/images$/.test(path) && method === 'GET') {
        ok(res, { images: [] });
        return;
      }
      const conversationMatch = path.match(
        /^\/api\/v1\/conversations\/([^/]+)(?:\/(messages|regenerate|cancel|first-token))?$/
      );
      if (conversationMatch) {
        const [, id, action] = conversationMatch;
        const session = data.sessions.find((item) => item.id === id);
        if (!session) {
          fail(res, 404, 'session_not_found', '对话不存在');
          return;
        }
        if (!action && method === 'GET') {
          ok(res, {
            session,
            messages: data.messages.filter((item) => item.session_id === id),
            has_more: false,
          });
          return;
        }
        if (action === 'first-token' && method === 'POST') {
          ok(res, { recorded: true });
          return;
        }
        if (action === 'cancel' && method === 'POST') {
          const message = [...data.messages]
            .reverse()
            .find((item) => item.session_id === id && item.role === 'assistant');
          if (message?.status === 'streaming') {
            message.status = 'interrupted';
            message.finish_reason = 'user_cancelled';
          }
          ok(res, { message });
          return;
        }
        if (method === 'POST' && (action === 'messages' || action === 'regenerate')) {
          if (scenario === 'no-balance') {
            fail(res, 402, 'insufficient_balance', '星尘余额不足');
            return;
          }
          const parsed =
            typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
          if (
            action === 'messages' &&
            (typeof parsed.content !== 'string' || !parsed.content.trim())
          )
            throw new Error('empty message');
          const turn =
            Math.max(
              0,
              ...data.messages
                .filter((item) => item.session_id === id)
                .map((item) => item.turn_index)
            ) + (action === 'messages' ? 1 : 0);
          const userId = action === 'messages' ? randomUUID() : null;
          if (userId)
            data.messages.push({
              ...makeData(api).messages[1]!,
              id: userId,
              session_id: session.id,
              turn_index: turn,
              content: String(parsed.content),
            });
          const message: ChatMessage = {
            ...makeData(api).messages[2]!,
            id: randomUUID(),
            session_id: session.id,
            turn_index: turn,
            revision: action === 'regenerate' ? 2 : 1,
            content: '',
            status: 'streaming',
            finish_reason: null,
          };
          data.messages.push(message);
          const currentEpoch = epoch;
          const write = (event: ConversationStreamEvent) => {
            if (!res.destroyed && !res.writableEnded)
              res.write(`data: ${JSON.stringify(event)}\n\n`);
          };
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          });
          streams.add(res);
          res.on('close', () => streams.delete(res));
          write({
            type: 'start',
            turn_index: turn,
            revision: message.revision,
            user_message_id: userId,
            assistant_message_id: message.id,
            thinking_enabled: parsed.thinking_enabled !== false,
          });
          await delay(150);
          if (parsed.thinking_enabled !== false)
            write({ type: 'reasoning', text: '沿着当前故事线，准备一个自然的回应。' });
          await delay(scenario === 'chat-slow' ? 2200 : 700);
          if (
            currentEpoch !== epoch ||
            res.destroyed ||
            res.writableEnded ||
            message.status !== 'streaming'
          ) {
            if (!res.writableEnded) res.end();
            return;
          }
          if (scenario === 'chat-error' || scenario === 'chat-partial-error') {
            if (scenario === 'chat-partial-error') {
              message.content = '旅人已经说出口的话会留在这里。';
              write({ type: 'delta', text: message.content });
            }
            message.status = scenario === 'chat-partial-error' ? 'interrupted' : 'failed';
            message.error_code = 'upstream_error';
            write({ type: 'error', code: 'upstream_error', message: '本次回复暂未完成，请重试' });
          } else {
            for (const text of [
              '「那就出发吧。」',
              '旅人轻轻合上地图，',
              '把下一步的选择留给你。',
            ]) {
              if (res.destroyed || currentEpoch !== epoch || message.status !== 'streaming') break;
              message.content += text;
              write({ type: 'delta', text });
              await delay(170);
            }
            if (message.status === 'streaming') {
              message.status = 'complete';
              message.finish_reason = 'stop';
            }
            session.message_count += 2;
            session.last_message_preview = message.content;
            write({
              type: 'done',
              assistant_message_id: message.id,
              status: message.status,
              finish_reason: message.finish_reason,
            });
          }
          res.end();
          streams.delete(res);
          return;
        }
      }
      if (path === '/api/image-plaza/config' && method === 'GET') {
        ok(res, data.imageConfig);
        return;
      }
      if (path === '/api/image-plaza/feed' && method === 'GET') {
        const search = url.searchParams.get('search')?.toLowerCase() ?? '';
        ok(res, {
          items: data.works.filter((item) => item.title.toLowerCase().includes(search)),
          next_cursor: null,
          tags: data.imageConfig.tags,
        });
        return;
      }
      if (path === '/api/image-plaza/feed/tag-counts' && method === 'GET') {
        ok(res, {
          counts: Object.fromEntries(
            data.imageConfig.tags.map((tag, index) => [tag.id, Math.max(1, 12 - index)])
          ),
        });
        return;
      }
      if (path.startsWith('/api/image-plaza/works/') && method === 'GET') {
        const work = data.works.find((item) => item.id === path.split('/').pop());
        if (work) ok(res, { work });
        else fail(res, 404, 'work_not_found', '作品不存在');
        return;
      }
      if (path === '/api/image-plaza/conversations') {
        if (method === 'GET') {
          ok(res, { conversations: data.studios });
          return;
        }
        if (method === 'POST') {
          const studio = ImagePlazaConversationSchema.parse({
            ...makeData(api).studios[0],
            id: randomUUID(),
          });
          data.studios.push(studio);
          ok(res, { conversation: studio });
          return;
        }
      }
      if (path === '/api/image-plaza/quotes' && method === 'POST') {
        const quote = ImagePlazaQuoteRequestSchema.parse(body);
        const credits = quote.resolution === '2K' ? 40 : 20;
        const quote_id = randomUUID();
        quotes.set(quote_id, { credits, expiresAt: Date.now() + 60_000 });
        ok(res, {
          ...quote,
          quote_id,
          credits,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        });
        return;
      }
      const studioMatch = path.match(
        /^\/api\/image-plaza\/conversations\/([^/]+)(?:\/(attempts))?$/
      );
      if (studioMatch) {
        const studio = data.studios.find((item) => item.id === studioMatch[1]);
        if (!studio) {
          fail(res, 404, 'conversation_not_found', '创作不存在');
          return;
        }
        if (method === 'GET' && !studioMatch[2]) {
          ok(res, { conversation: studio });
          return;
        }
        if (method === 'POST' && studioMatch[2] === 'attempts') {
          const input = SubmitImagePlazaAttemptRequestSchema.parse(body);
          const previous = imageKeys.get(input.idempotency_key);
          if (previous) {
            ok(res, { attempt: previous });
            return;
          }
          const quote = quotes.get(input.quote_id);
          if (!quote || quote.expiresAt < Date.now()) {
            fail(res, 409, 'quote_expired', '请重新报价');
            return;
          }
          if (data.wallet.main_credits < quote.credits) {
            fail(res, 402, 'insufficient_balance', '星尘余额不足');
            return;
          }
          const attempt: ImagePlazaAttempt = {
            id: randomUUID(),
            conversation_id: studio.id,
            status: 'generating',
            quote_credits: quote.credits,
            error_code: null,
            artifacts: [],
            created_at: stamp(),
            updated_at: stamp(),
          };
          studio.messages.push(
            {
              id: randomUUID(),
              role: 'user',
              content: input.prompt,
              media_type: 'image',
              attempt: null,
              video_attempt: null,
              created_at: stamp(),
            },
            {
              id: randomUUID(),
              role: 'assistant',
              content: '',
              media_type: 'image',
              attempt,
              video_attempt: null,
              created_at: stamp(),
            }
          );
          studio.snapshot = {
            ...input,
            reference_artifact_id: input.reference_artifact_id ?? null,
            style: 'None',
          };
          pendingImages.set(attempt.id, {
            readyAt: Date.now() + 650,
            failed: scenario === 'image-error',
            attempt,
          });
          imageKeys.set(input.idempotency_key, attempt);
          ok(res, { attempt });
          return;
        }
      }
      if (unhandled.length < 100) unhandled.push(`${method} ${path}`);
      fail(res, 501, 'preview_route_missing', `预览尚未实现 ${method} ${path}`);
    } catch {
      if (!res.headersSent)
        fail(res, 400, 'invalid_preview_request', '请求不符合共享契约，请更新 fixture');
      else res.end();
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return { server, reset };
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/fixtures/server.ts')) {
  const apiPort = Number(process.env.ST_UI_API_PORT ?? 3121);
  const appPort = Number(process.env.ST_UI_APP_PORT ?? 3120);
  const { server } = createPreviewServer(apiPort, appPort);
  server.listen(apiPort, HOST, () => console.log(`UI fixtures: http://${HOST}:${apiPort}`));
}
