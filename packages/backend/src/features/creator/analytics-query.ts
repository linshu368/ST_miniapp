import { Prisma } from '@prisma/client';
import type { CreatorAnalyticsQuery } from '@miniapp/shared';

/** Reporting days are Beijing calendar days, not rolling 24-hour windows. */
export function analyticsWindow(query: CreatorAnalyticsQuery, now = new Date()) {
  const requested = query.as_of ? new Date(query.as_of) : now;
  const end = new Date(Math.min(requested.getTime(), now.getTime()));
  const day = 86_400_000;
  const today = new Date(Math.floor((end.getTime() + 8 * 3_600_000) / day) * day - 8 * 3_600_000);
  const start =
    query.period === 'all'
      ? null
      : new Date(today.getTime() - (Number.parseInt(query.period) - 1) * day);
  return { start, end, today };
}

/** Owned facts only. Never count copied branch context or a regeneration as a new logical turn. */
export function buildCreatorAnalyticsQuery(
  ownerId: string,
  query: CreatorAnalyticsQuery,
  now = new Date()
) {
  const { start, end, today } = analyticsWindow(query, now);
  const selected = query.character_id ?? null;
  const order =
    query.sort === 'newest'
      ? Prisma.sql`created_at DESC, id DESC`
      : query.sort === 'earned'
        ? Prisma.sql`earned DESC, created_at DESC, id DESC`
        : Prisma.sql`players DESC, created_at DESC, id DESC`;
  const page = query.section === 'overview' ? 1 : query.page;
  const size = query.section === 'overview' ? 3 : query.page_size;
  const offset = (page - 1) * size;
  const works = Prisma.sql`SELECT jsonb_build_object('players', players, 'rounds', rounds, 'earned', earned) AS stats,
    id, name, cover_asset_id, NULL::text AS cover_url, visibility, state, created_at FROM work_stats ORDER BY ${order} LIMIT ${size} OFFSET ${offset}`;
  const rewards = Prisma.sql`SELECT id, character_id, name, amount, occurred_at, kind FROM period_rewards ORDER BY occurred_at DESC, id DESC LIMIT ${size} OFFSET ${offset}`;
  const feedback = Prisma.sql`SELECT id, character_id, name, user_id, body, created_at FROM feedback_rows ORDER BY created_at DESC, id DESC LIMIT ${size} OFFSET ${offset}`;
  const characters = Prisma.sql`SELECT * FROM owned ORDER BY created_at DESC, id DESC LIMIT ${size} OFFSET ${offset}`;
  const arrays = (sql: Prisma.Sql) =>
    Prisma.sql`COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM (${sql}) x), '[]'::jsonb)`;
  let result: Prisma.Sql;
  if (query.section === 'overview') {
    result = Prisma.sql`jsonb_build_object(
      'section', 'overview', 'as_of', ${end.toISOString()}::text,
      'card_count', (SELECT count(*) FROM owned),
      'selected', (SELECT to_jsonb(o) FROM owned o WHERE o.id=${selected}::uuid),
      'summary', jsonb_build_object(
        'players', (SELECT count(DISTINCT user_id) FROM player_card),
        'rounds', (SELECT count(*) FROM period_turns),
        'deepPlayers', (SELECT count(DISTINCT user_id) FROM player_card WHERE rounds>=10),
        'returningPlayers', (SELECT count(DISTINCT user_id) FROM player_card WHERE days>=2),
        'earned', COALESCE((SELECT sum(amount) FROM period_rewards),0),
        'todayEarned', COALESCE((SELECT sum(amount) FROM reward_events WHERE occurred_at>=${today} AND occurred_at<${end}),0),
        'likes', (SELECT count(*) FROM miniapp_features.character_likes l JOIN scoped o ON o.id=l.character_id WHERE l.user_id<>${ownerId}::uuid)
          +(SELECT count(*) FROM experience.chat_message_likes l JOIN experience.chat_sessions s ON s.id=l.session_id JOIN scoped o ON o.id=s.character_id WHERE s.user_id<>${ownerId}::uuid),
        'favorites', (SELECT count(*) FROM miniapp_features.character_favorites f JOIN scoped o ON o.id=f.character_id WHERE f.user_id<>${ownerId}::uuid),
        'comments', (SELECT count(*) FROM feedback_rows)
      ),
      'works', ${arrays(works)}, 'works_total', (SELECT count(*) FROM scoped),
      'rewards', ${arrays(rewards)}, 'rewards_total', (SELECT count(*) FROM period_rewards),
      'feedback', ${arrays(feedback)}, 'feedback_total', (SELECT count(*) FROM feedback_rows)
    )`;
  } else {
    const source =
      query.section === 'works'
        ? works
        : query.section === 'rewards'
          ? rewards
          : query.section === 'feedback'
            ? feedback
            : characters;
    const total =
      query.section === 'works'
        ? Prisma.sql`SELECT count(*) FROM scoped`
        : query.section === 'rewards'
          ? Prisma.sql`SELECT count(*) FROM period_rewards`
          : query.section === 'feedback'
            ? Prisma.sql`SELECT count(*) FROM feedback_rows`
            : Prisma.sql`SELECT count(*) FROM owned`;
    result = Prisma.sql`jsonb_build_object('section', ${query.section}::text, 'as_of', ${end.toISOString()}::text,
      'page', ${page}::integer, 'page_size', ${size}::integer, 'total', (${total}), 'items', ${arrays(source)})`;
  }
  return Prisma.sql`WITH owned AS MATERIALIZED (
    SELECT cr.character_id AS id, COALESCE(NULLIF(c.name,''),NULLIF(cr.draft->>'name',''),'未命名角色') AS name,
      cr.cover_asset_id, NULL::text AS cover_url, cr.visibility, cr.state, cr.created_at
    FROM app_core.character_creations cr JOIN app_core.characters c ON c.id=cr.character_id
    WHERE cr.owner_user_id=${ownerId}::uuid AND cr.created_at<${end}
  ), scoped AS (
    SELECT * FROM owned WHERE (${selected}::uuid IS NULL OR id=${selected}::uuid)
  ), logical_turns AS (
    SELECT h.character_id, h.user_id, h.session_id, h.turn_index, min(h.created_at) AS occurred_at
    FROM experience.chat_history h JOIN scoped o ON o.id=h.character_id
    JOIN experience.chat_sessions s ON s.id=h.session_id
    WHERE h.user_id<>${ownerId}::uuid AND h.status='success' AND h.session_id IS NOT NULL
      AND h.turn_index>COALESCE(s.branch_inherited_turns,0) AND h.revision IS NOT NULL
    GROUP BY h.character_id,h.user_id,h.session_id,h.turn_index
  ), period_turns AS (
    SELECT * FROM logical_turns WHERE (${start}::timestamptz IS NULL OR occurred_at>=${start}::timestamptz) AND occurred_at<${end}
  ), player_card AS (
    SELECT character_id,user_id,count(*) AS rounds,count(DISTINCT (occurred_at AT TIME ZONE 'Asia/Shanghai')::date) AS days
    FROM period_turns GROUP BY character_id,user_id
  ), reward_events AS (
    SELECT r.charge_key::text||':credit' AS id,r.character_id,COALESCE(o.name,'已删除角色') AS name,
      r.credited_amount AS amount,r.created_at AS occurred_at,'credit'::text AS kind
    FROM billing.character_creator_rewards r LEFT JOIN owned o ON o.id=r.character_id
    WHERE r.creator_user_id=${ownerId}::uuid AND r.payer_user_id<>${ownerId}::uuid AND r.credited_amount>0
      AND (${selected}::uuid IS NULL OR r.character_id=${selected}::uuid)
    UNION ALL
    SELECT r.charge_key::text||':reversal',r.character_id,COALESCE(o.name,'已删除角色'),
      -r.reversal_recovered_amount,r.reversed_at,'reversal'::text
    FROM billing.character_creator_rewards r LEFT JOIN owned o ON o.id=r.character_id
    WHERE r.creator_user_id=${ownerId}::uuid AND r.payer_user_id<>${ownerId}::uuid AND r.reversal_recovered_amount>0 AND r.reversed_at IS NOT NULL
      AND (${selected}::uuid IS NULL OR r.character_id=${selected}::uuid)
  ), period_rewards AS (
    SELECT * FROM reward_events WHERE (${start}::timestamptz IS NULL OR occurred_at>=${start}::timestamptz) AND occurred_at<${end}
  ), work_stats AS (
    SELECT o.*,COALESCE(u.players,0) AS players,COALESCE(u.rounds,0) AS rounds,COALESCE(r.earned,0) AS earned
    FROM scoped o
    LEFT JOIN (SELECT character_id,count(*) AS players,sum(rounds) AS rounds FROM player_card GROUP BY character_id) u ON u.character_id=o.id
    LEFT JOIN (SELECT character_id,sum(amount) AS earned FROM period_rewards GROUP BY character_id) r ON r.character_id=o.id
  ), feedback_rows AS (
    SELECT f.id,f.character_id,o.name,f.user_id,f.body,f.created_at
    FROM miniapp_features.character_comments f JOIN scoped o ON o.id=f.character_id
    WHERE f.deleted_at IS NULL AND f.user_id<>${ownerId}::uuid
      AND (${start}::timestamptz IS NULL OR f.created_at>=${start}::timestamptz) AND f.created_at<${end}
  ) SELECT (${selected}::uuid IS NULL OR EXISTS(SELECT 1 FROM owned WHERE id=${selected}::uuid)) AS allowed, ${result} AS data`;
}
