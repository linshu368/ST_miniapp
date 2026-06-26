# 角色卡数据流梳理（基于 2026-06-26 代码现状）

> 结论口径：本文件以当前代码为唯一真相。`docs/ARCHITECTURE.md`、`docs/DECISIONS.md`、`docs/Schema划分设计.md`、`docs/DECISIONS_BUNDLE.md` 只作为参考；凡与运行时代码不一致，下面均单独标出。

## 1. 数据模型

### 1.1 数据库表（含字段表 + 语义说明）

#### `miniapp.characters`

这是角色卡元数据的主表，当前同时服务两条链路：

- 前端大厅：backend 通过 Prisma 读取它，返回卡片展示字段。
- provision：sync-engine 通过 Supabase JS 读取它，决定给 ST 文件系统下发哪些平台角色卡 PNG。

代码位置：

```243:273:packages/backend/prisma/schema.prisma
model Character {
  id                        String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  name                      String
  description               String   @default("")
  avatar_url                String   @default("")
  creator_notes             String   @default("")
  created_at                DateTime @default(now()) @db.Timestamptz(6)
  updated_at                DateTime @updatedAt
  alternate_greetings       Json     @default("[]")
  character_book            Json?
  character_version         String   @default("")
  creator                   String   @default("")
  extensions                Json     @default("{}")
  first_mes                 String   @default("")
  mes_example               String   @default("")
  personality               String   @default("")
  post_history_instructions String   @default("")
  scenario                  String   @default("")
  spec                      String   @default("chara_card_v2")
  spec_version              String   @default("2.0")
  system_prompt             String   @default("")
  tags                      Json     @default("[]")
  is_default                Boolean  @default(false)
  enabled                   Boolean  @default(true)
  sort_order                Int      @default(0)
  is_published              Boolean  @default(true)
  is_active                 Boolean  @default(true)

  @@map("characters")
  @@schema("miniapp")
}
```

关键字段语义：

| 字段           | 当前代码语义                                                                                                 | 代码位置                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `id`           | 平台角色卡 UUID；ST 文件名使用 `platform_<id>.png`。                                                         | `packages/sync-engine/src/lib/st-fs.ts:38-45`                                                                                  |
| `name`         | 大厅展示名；也来自 PNG 内嵌 chara 元数据。                                                                   | `packages/backend/src/routes/characters.ts:21-27`                                                                              |
| `description`  | 大厅卡片描述、详情页“作者说”的一部分。                                                                       | `packages/backend/src/routes/characters.ts:23,48`                                                                              |
| `avatar_url`   | 大厅图片 URL 原样返回给前端；代码不拼 Storage URL。seed 生成器当前写空字符串。                               | `packages/backend/src/routes/characters.ts:24,49`；`packages/shared/scripts/generate-seed-sql.ts:222-224`                      |
| `creator`      | 返回为 `author_name`。                                                                                       | `packages/backend/src/routes/characters.ts:26,51`                                                                              |
| `tags`         | 返回为 `personality_tags`，要求运行时是数组。                                                                | `packages/backend/src/routes/characters.ts:25,50`                                                                              |
| `first_mes`    | 详情接口返回为 `greeting`。                                                                                  | `packages/backend/src/routes/characters.ts:52`                                                                                 |
| `enabled`      | 当前前端大厅接口实际使用的上架过滤字段。                                                                     | `packages/backend/src/routes/characters.ts:14-16,37-39`                                                                        |
| `is_published` | 当前 provision 实际使用的下发过滤字段之一。                                                                  | `packages/sync-engine/src/provisioner/fetcher.ts:107-112`                                                                      |
| `is_active`    | 当前 provision 实际使用的下发过滤字段之一。                                                                  | `packages/sync-engine/src/provisioner/fetcher.ts:107-112`                                                                      |
| `is_default`   | provision merge settings 时，`active_character` 失效后的兜底卡。数据库层还有“最多一张默认卡”的部分唯一索引。 | `packages/sync-engine/src/provisioner/index.ts:142-151`；`packages/shared/migrations/004_characters_add_sync_fields.sql:41-45` |
| `sort_order`   | 大厅排序第一关键字；provision 下发排序唯一关键字。                                                           | `packages/backend/src/routes/characters.ts:14-17`；`packages/sync-engine/src/provisioner/fetcher.ts:107-112`                   |

字段约束：

```41:50:packages/shared/migrations/004_characters_add_sync_fields.sql
-- 业务约束：is_default = true 的卡全表最多 1 行（部分唯一索引）
CREATE UNIQUE INDEX IF NOT EXISTS idx_characters_one_default
  ON miniapp.characters((1))
  WHERE is_default = true;

-- 索引：大厅按 is_published + is_active + sort_order 列表查询
CREATE INDEX IF NOT EXISTS idx_characters_published_active_sort
  ON miniapp.characters(is_published, is_active, sort_order)
  WHERE is_published = true AND is_active = true;
```

注意：索引注释说大厅应按 `is_published/is_active/sort_order`，但当前 backend 大厅接口仍按 `enabled=true` 查询，见第 1.3 节。

#### `st_platform.platform_presets`

角色卡和预设没有直接外键关系，但它们在 provision 中作为同一批平台资产一起下发：角色卡 order=10，预设 order=20，settings order=100。

代码位置：

```12:29:packages/shared/migrations/006_platform_presets.sql
CREATE TABLE IF NOT EXISTS st_platform.platform_presets (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name        TEXT NOT NULL,
  preset_payload      JSONB NOT NULL,
  is_default          BOOLEAN NOT NULL DEFAULT false,
  sort_order          INTEGER NOT NULL DEFAULT 0,
  enabled             BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

约束：

```31:40:packages/shared/migrations/006_platform_presets.sql
-- is_default = true 全表唯一（阶段一只暴露一个默认预设）
CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_presets_one_default
  ON st_platform.platform_presets((1))
  WHERE is_default = true;

-- 大厅 / 同步引擎按 enabled + sort_order 列出
CREATE INDEX IF NOT EXISTS idx_platform_presets_enabled_sort
  ON st_platform.platform_presets(enabled, sort_order)
  WHERE enabled = true;
```

provision 读取：

```113:117:packages/sync-engine/src/provisioner/fetcher.ts
schemaClient('st_platform')
  .from('platform_presets')
  .select('id, display_name, preset_payload, is_default')
  .eq('enabled', true)
  .order('sort_order', { ascending: true }),
```

#### `st_platform.platform_settings`

不是角色卡表，但它持有 ST `settings.json` 的平台默认值，其中 `active_character` 会引用角色卡文件名。

代码位置：

```30:35:packages/shared/migrations/005_platform_settings.sql
-- 白名单（决策 2 + 决策 3）：[{path, transform}, ...]
-- 阶段一支持的 transform：
--   - "passthrough"：不变换，原样写入
--   - "character_ref"：值是 platform_<uuid>.png，下发时校验对应 miniapp.characters 是否存在；失效回退默认卡
writable_paths      JSONB NOT NULL DEFAULT '[]',
```

seed 生成器会把平台默认 `active_character` 写成第一张默认卡：

```330:339:packages/shared/scripts/generate-seed-sql.ts
// 1) active_character → platform_<uuid>.png
cleaned.active_character = `platform_${defaultCharUuid}.png`;

// 2) main_api → "openai"
cleaned.main_api = 'openai';

// 3) oai_settings.preset_settings_openai → platform_<uuid>
if (cleaned.oai_settings && typeof cleaned.oai_settings === 'object') {
```

#### `st_users.user_st_settings`

不是角色卡元数据表，但它会保存用户在 ST 中切换后的 `active_character`，下次 provision merge 时会校验这个角色引用是否仍然有效。

代码位置：

```161:168:packages/sync-engine/src/provisioner/fetcher.ts
const userSettingsResult = await schemaClient('st_users')
  .from('user_st_settings')
  .select('user_revision, settings_jsonb, based_on_platform_version')
  .eq('user_id', userId)
  .order('created_at', { ascending: false })
  .limit(1)
  .maybeSingle();
```

merge 校验：

```63:88:packages/sync-engine/src/provisioner/merger.ts
for (const { path, transform } of platformSettings.writable_paths) {
  if (transform !== 'character_ref') continue;

  const currentVal = lodashGet(merged, path) as string | undefined;
  if (!currentVal) continue;

  // currentVal 格式：platform_<uuid>.png
  // 从中提取 uuid 部分做校验
  const match = currentVal.match(/^platform_([0-9a-f-]+)\.png$/i);
  if (!match) {
    // 格式不符合 platform_<uuid>.png，视为失效
    hadInvalidRef = true;
    invalidRefValue = currentVal;
    const fallback = buildFallbackCharRef(defaultCharacter);
    if (fallback) lodashSet(merged, path, fallback);
    continue;
  }
```

#### `st_users.user_st_chats`

这是聊天镜像占位表，和平台角色卡有关联字段 `character_id`，但阶段一没有聊天回流实现。

代码位置：

```16:27:packages/shared/migrations/009_user_st_chats.sql
CREATE TABLE IF NOT EXISTS st_users.user_st_chats (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  user_id         UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,

  -- 跨 schema FK 到平台卡池。用户切换到 ST 私有卡时记 NULL（D007）
  character_id    UUID REFERENCES miniapp.characters(id) ON DELETE SET NULL,

  -- 聊天数据 jsonb（阶段二定义具体结构，阶段一只占位）
  chat_data       JSONB NOT NULL DEFAULT '[]',
```

### 1.2 Storage 存储约定

#### 当前代码现状：未发现 Supabase Storage SDK 读写

当前运行时代码没有 `storage.from(...)` / bucket 创建 / signed URL / upload 下载逻辑。角色卡 PNG 的 provision 真正来源是本地平台资产目录：

```38:45:packages/sync-engine/src/lib/st-fs.ts
/** 平台资产目录下某角色卡的源 PNG 路径：ST_PLATFORM_ASSETS_PATH/characters/platform_<id>.png */
export function platformCharacterSrc(characterId: string): string {
  return join(config.ST_PLATFORM_ASSETS_PATH, 'characters', `platform_${characterId}.png`);
}

/** data/<handle>/characters/platform_<id>.png */
export function characterDst(handle: string, characterId: string): string {
```

sync-engine 启动配置要求这个本地路径存在：

```32:34:packages/sync-engine/src/lib/config.ts
// ST 文件系统
ST_DATA_PATH: z.string().min(1, 'ST_DATA_PATH 不能为空'),
ST_PLATFORM_ASSETS_PATH: z.string().min(1, 'ST_PLATFORM_ASSETS_PATH 不能为空'),
```

writer 的实际行为是复制本地文件：

```36:44:packages/sync-engine/src/provisioner/writer.ts
// ─── 写角色卡 PNG ─────────────────────────────────────────────────────────────
/**
 * 从 platform-assets/characters/ 目录复制 PNG 到用户的 characters/ 目录。
 *
 * @param handle  - ST 用户 handle
 * @param characters - 已拉取的平台角色卡列表
 * @param force   - true = 总是覆盖；false = 目标文件已存在则跳过（增量补全）
 */
```

#### 文档/计划中的 Supabase Storage 约定：代码未实现

设计文档里提过未来 Storage 路径，但当前代码未接入：

```498:501:docs/DECISIONS.md
2. **阶段二（未来）**：迁移到 Supabase Storage
   - PNG 上传到 `st-platform-assets` bucket，路径 `characters/<id>.png`
   - 同步引擎从 Storage 签名 URL 下载到 ST 本地（保留 ST 文件系统依赖，不改 ST 源码）
   - chara_card_v3 元数据继续存 `miniapp.characters`，加一列 `storage_path` 指向 Storage 对象
```

当前 `miniapp.characters` 没有 `storage_path` 字段：

```243:270:packages/backend/prisma/schema.prisma
model Character {
  id                        String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  name                      String
  description               String   @default("")
  avatar_url                String   @default("")
  creator_notes             String   @default("")
  created_at                DateTime @default(now()) @db.Timestamptz(6)
  updated_at                DateTime @updatedAt
  alternate_greetings       Json     @default("[]")
  character_book            Json?
  character_version         String   @default("")
  creator                   String   @default("")
  extensions                Json     @default("{}")
  first_mes                 String   @default("")
  mes_example               String   @default("")
  personality               String   @default("")
  post_history_instructions String   @default("")
  scenario                  String   @default("")
  spec                      String   @default("chara_card_v2")
  spec_version              String   @default("2.0")
  system_prompt             String   @default("")
  tags                      Json     @default("[]")
  is_default                Boolean  @default(false)
  enabled                   Boolean  @default(true)
  sort_order                Int      @default(0)
  is_published              Boolean  @default(true)
  is_active                 Boolean  @default(true)
```

#### 本地 `platform-assets/` 引用

当前仓库里没有实际 `platform-assets/` 目录（glob 未找到），但代码和文档仍保留概念引用：

- `packages/sync-engine/src/provisioner/writer.ts:38`：注释写“从 platform-assets/characters/ 目录复制 PNG”。
- `packages/sync-engine/src/lib/config.ts:34`：`ST_PLATFORM_ASSETS_PATH` 仍是必填 env。
- `packages/sync-engine/src/lib/st-fs.ts:38-40`：实际拼 `ST_PLATFORM_ASSETS_PATH/characters/platform_<id>.png`。
- `packages/sync-engine/src/provisioner/index.ts:111-114`：缺 PNG 时日志提示检查 `ST_PLATFORM_ASSETS_PATH`。

### 1.3 字段语义现状与文档差异

当前字段实际情况：

- `schema.prisma` 里同时存在 `enabled`、`is_published`、`is_active`、`is_default`、`sort_order`。
- shared migration `004` 的意图是新增 `is_published/is_active`。
- backend Prisma migration `20260623113000` 的意图是“如果存在 `enabled` 且不存在 `is_published`，把 `enabled` 重命名为 `is_published`”。
- 但当前 Prisma schema 仍保留两套字段，且运行时代码两边使用不同字段。

迁移意图：

```20:24:packages/shared/migrations/004_characters_add_sync_fields.sql
ALTER TABLE miniapp.characters
  ADD COLUMN IF NOT EXISTS is_default   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_published BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS is_active    BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS sort_order   INTEGER NOT NULL DEFAULT 0;
```

```11:35:packages/backend/prisma/migrations/20260623113000_phase0_drop_sessions_character_flags/migration.sql
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'miniapp'
      AND table_name = 'characters'
      AND column_name = 'enabled'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'miniapp'
      AND table_name = 'characters'
      AND column_name = 'is_published'
  ) THEN
    ALTER TABLE miniapp.characters RENAME COLUMN enabled TO is_published;
```

大厅实际使用 `enabled`：

```13:17:packages/backend/src/routes/characters.ts
app.get('/api/characters', async (request, reply) => {
  const characters = await prisma.character.findMany({
    where: { enabled: true },
    orderBy: [{ sort_order: 'asc' }, { created_at: 'desc' }],
  });
```

provision 实际使用 `is_published + is_active`：

```107:112:packages/sync-engine/src/provisioner/fetcher.ts
schemaClient('miniapp')
  .from('characters')
  .select('*')
  .eq('is_published', true)
  .eq('is_active', true)
  .order('sort_order', { ascending: true }),
```

文档差异：

- `docs/ARCHITECTURE.md §12.1` 写 `enabled` 控制大厅展示 + 新用户 provision，但当前 provision 代码不用 `enabled`。

```368:372:docs/ARCHITECTURE.md
### 12.1 角色卡字段语义

- `enabled`：是否上架（控制大厅展示 + 新用户 provision）
- `is_default`：新用户初始化时是否自动激活（也是 `character_ref` 失效兜底卡）
- `sort_order`：大厅展示顺序
```

- `packages/shared/migrations/004_characters_add_sync_fields.sql` 注释写“大厅与同步引擎只下发 `is_published=true` 且 `is_active=true`”，但大厅代码仍用 `enabled`。

```32:39:packages/shared/migrations/004_characters_add_sync_fields.sql
COMMENT ON COLUMN miniapp.characters.is_default IS
  '新用户初始化时是否自动激活此卡（user_st_settings.settings_jsonb.active_character 取此卡的 platform_<id>）';
COMMENT ON COLUMN miniapp.characters.is_published IS
  '是否上架。大厅与同步引擎只下发 is_published=true 且 is_active=true 的卡';
COMMENT ON COLUMN miniapp.characters.is_active IS
  '是否可用。停用后老用户已物化卡不可继续使用';
COMMENT ON COLUMN miniapp.characters.sort_order IS
  '大厅展示顺序，数字越小越靠前。同 sort_order 时按 created_at 兜底';
```

- `packages/sync-engine/registry.yaml` 注释仍写 `is_enabled=true`，但实际字段是 `is_published/is_active`。

```31:34:packages/sync-engine/registry.yaml
# 种子数据：011_seed_data.sql 中 3 张卡（第七开发部 / 莫池来 / 贺商寒）
#   - is_enabled=true 的卡才下发
#   - is_default=true 的卡（第七开发部）是 character_ref 失效时的兜底卡（决策 8）
# 落盘命名：platform_<uuid>.png（决策 4 稳定命名，让 settings 指针跨设备语义一致）
```

## 2. 写入路径

### 2.1 当前实际写入方式

当前代码中没有“运营上传角色卡”的 backend API。

backend 注册的角色卡路由只有两个 GET：

```11:18:packages/backend/src/routes/characters.ts
export default async function characterRoutes(app: FastifyInstance) {
  // @frontend-ready: true
  app.get('/api/characters', async (request, reply) => {
    const characters = await prisma.character.findMany({
      where: { enabled: true },
      orderBy: [{ sort_order: 'asc' }, { created_at: 'desc' }],
    });
```

```33:39:packages/backend/src/routes/characters.ts
// @frontend-ready: true
app.get('/api/characters/:id', async (request, reply) => {
  const { id } = request.params as { id: string };

  const character = await prisma.character.findFirst({
    where: { id, enabled: true },
  });
```

应用只注册这个 characters 路由，没有额外 upload/multipart handler 给角色卡：

```60:67:packages/backend/src/app.ts
// ── 路由挂载 ──
await app.register(characterRoutes);
await app.register(bridgeRoutes);
await app.register(paymentRoutes);
await app.register(walletRoutes);
await app.register(settingsRoutes);
await app.register(llmProxyRoutes);
await app.register(chatsRoutes);
```

当前可见的写入方式只有种子 SQL 生成器，它从固定 ST default-user 目录读取 PNG，解析 PNG 内嵌 chara 元数据，生成 `011_seed_data.sql`：

```3:10:packages/shared/scripts/generate-seed-sql.ts
/**
 * generate-seed-sql.ts
 *
 * 用途：
 *   - 从 SillyTavern-latest/data/default-user 真实数据生成种子 SQL
 *   - 输出文件：packages/shared/migrations/011_seed_data.sql
 *
 * 输入：
 *   - 角色卡：3 张 PNG（chara_card_v3 嵌入），来自 /SillyTavern-latest/data/default-user/characters/
```

```373:391:packages/shared/scripts/generate-seed-sql.ts
function main() {
  // 角色卡顺序：第七开发部（默认）→ 莫池来 → 贺商寒
  const characterOrder = [
    { name: '第七开发部', file: '第七开发部.png' },
    { name: '莫池来', file: '莫池来.png' },
    { name: '贺商寒', file: '贺商寒.png' },
  ];

  const characterInserts: string[] = [];
  characterOrder.forEach(({ name, file }, idx) => {
    const pngPath = path.join(ST_ROOT, 'characters', file);
    const card = extractCharaCardFromPng(pngPath);
    const uuid = SEED_CHARACTER_UUIDS[name];
```

这不是运行时上传接口，也不是运营后台。按当前代码判断，运营若要新增角色卡，需要同时完成两件事，但没有代码保证二者同步：

1. 写 `miniapp.characters` 表记录（可能通过 Supabase 控制台、SQL、迁移脚本或自写脚本；仓库里未找到运行时入口）。
2. 把 PNG 放到 `ST_PLATFORM_ASSETS_PATH/characters/platform_<id>.png`，其中 `<id>` 必须等于 `miniapp.characters.id`。

### 2.2 涉及代码位置（文件:行号）

#### PNG 和表记录同步：无人自动保证

provision 复制前会检查源 PNG 是否存在；不存在时记录 missing 并继续流程，不会回滚 DB，也不会阻断 settings 写入。

```55:74:packages/sync-engine/src/provisioner/writer.ts
for (const char of characters) {
  const src = platformCharacterSrc(char.id);
  const dst = characterDst(handle, char.id);

  if (!existsSync(src)) {
    // 平台资产目录缺失这张卡的 PNG
    missing.push(char.id);
    continue;
  }

  if (!force && existsSync(dst)) {
    skipped.push(char.id);
    continue;
  }

  copyFileSync(src, dst);
  written.push(char.id);
}
```

```111:114:packages/sync-engine/src/provisioner/index.ts
if (charResult.missing.length > 0) {
  log(`[provision]   ⚠️  缺失的角色卡 id：${charResult.missing.join(', ')}`);
  log(`[provision]      请确认 ST_PLATFORM_ASSETS_PATH 目录中包含对应的 platform_<id>.png 文件`);
}
```

测试也确认“全部缺失时不抛错，流程继续”：

```204:213:packages/sync-engine/src/provisioner/__tests__/provisioner.test.ts
// ── 场景 4：角色卡全部缺失（missing） ────────────────────────────────────
it('角色卡 PNG 全部缺失时：charactersMissing > 0，但不抛错（流程继续）', async () => {
  mockedWriteChars.mockReturnValue({ written: [], skipped: [], missing: [CHAR_UUID] });

  const result = await provision(USER_ID, { log: () => {} });

  expect(result.charactersMissing).toBe(1);
  expect(result.charactersWritten).toBe(0);
  // settings.json 仍然写入（流程不中断）
  expect(mockedWriteSettings).toHaveBeenCalledOnce();
```

## 3. 读取路径 A：前端大厅

完整调用链：

```text
frontend app/(main)/page.tsx
  -> CharacterGallery
  -> useCharactersQuery()
  -> apiClient('/api/characters')
  -> backend GET /api/characters
  -> Prisma miniapp.characters where enabled=true
  -> 返回 CharacterSummary[]
  -> CharacterCard 用 avatar_url 作为 <img src>
```

页面入口：

```1:8:packages/frontend/src/app/(main)/page.tsx
import { CharacterGallery } from '@/components/characters/character-gallery';

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col pt-[env(safe-area-inset-top)]">
      <CharacterGallery />
    </main>
  );
}
```

组件发起查询：

```35:49:packages/frontend/src/components/characters/character-gallery.tsx
export function CharacterGallery() {
  const router = useRouter();
  const { data, isLoading, isError } = useCharactersQuery();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const characters = useMemo(() => data?.characters ?? [], [data?.characters]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return characters;
    return characters
      .map((c) => ({ c, s: scoreMatch(c, q) }))
      .filter(({ s }) => s > 0)
      .sort((a, b) => b.s - a.s)
```

React Query hook：

```8:32:packages/frontend/src/lib/api/characters.ts
// ==== 纯 fetch 函数（私有，不导出给业务）====
async function fetchCharacters(): Promise<GetCharactersData> {
  return apiClient<GetCharactersData>('/api/characters');
}

async function fetchCharacterById(id: string): Promise<GetCharacterByIdData> {
  return apiClient<GetCharacterByIdData>(`/api/characters/${id}`);
}

// ==== Query Keys ====
export const characterKeys = {
  all: ['characters'] as const,
  lists: () => [...characterKeys.all, 'list'] as const,
  detail: (id: string) => [...characterKeys.all, 'detail', id] as const,
};

// ==== React Query hooks（业务层唯一入口）====

export function useCharactersQuery() {
  return useQuery<GetCharactersData>({
```

HTTP client 的 backend base URL：

```4:9:packages/frontend/src/lib/api/client.ts
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

/** 统一的 HTTP 客户端。仅在 lib/api/ 内部使用；业务层必须走 React Query hook 包装。 */
export async function apiClient<T>(path: string, options?: RequestInit): Promise<T> {
  const url = `${API_URL}${path}`;
```

backend 查询、过滤、排序、返回字段：

```13:30:packages/backend/src/routes/characters.ts
app.get('/api/characters', async (request, reply) => {
  const characters = await prisma.character.findMany({
    where: { enabled: true },
    orderBy: [{ sort_order: 'asc' }, { created_at: 'desc' }],
  });

  const charactersSummary: CharacterSummary[] = characters.map(
    (c: (typeof characters)[number]) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      avatar_url: c.avatar_url,
      personality_tags: Array.isArray(c.tags) ? (c.tags as string[]) : [],
      author_name: c.creator,
    })
  );

  return reply.send(ok<GetCharactersData>({ characters: charactersSummary }));
});
```

前端图片渲染：前端直接使用后端返回的 `avatar_url`，没有 backend 图片代理，也没有前端拼 Storage URL。

```31:38:packages/frontend/src/components/characters/character-card.tsx
<div className="relative aspect-[3/4] w-full overflow-hidden">
  {hasAvatar ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={character.avatar_url}
      alt={character.name}
      className="absolute inset-0 h-full w-full object-cover object-top"
```

当前种子数据生成器把 `avatar_url` 写成空字符串，因此种子卡在大厅会走渐变 fallback，而不是 PNG：

```221:225:packages/shared/scripts/generate-seed-sql.ts
  ${sqlString(d.character_version ?? '')},
  ${sqlString(card.spec ?? 'chara_card_v3')},
  ${sqlString(card.spec_version ?? '3.0')},
  '',
  ${isDefault ? 'TRUE' : 'FALSE'},
```

点击角色卡后的路径：

```147:152:packages/frontend/src/components/characters/character-gallery.tsx
<div className="grid grid-cols-2 gap-3 px-4 pb-10 pt-2">
  {filtered.map((c) => (
    <CharacterCard key={c.id} character={c} onSelect={() => {
      // 按照当前架构要求，不需要详情页，直接跳转到对话页
      router.push(`/tavern/${c.id}`);
    }} />
```

`/tavern/[characterId]` 根据 URL 里的 UUID 拼 ST avatar 文件名，再通过 bridge 让 ST 切换角色：

```13:19:packages/frontend/src/app/tavern/[characterId]/page.tsx
useEffect(() => {
  if (!characterId || bridgeStatus !== 'ready') return;
  const avatar = `platform_${characterId}.png`;
  platformAction('selectCharacter', { avatar }).catch((err) => {
    console.error('[TavernChatPage] selectCharacter failed:', err);
  });
}, [bridgeStatus, characterId]);
```

ST 端 handler 按 avatar 文件名查 ST 内部角色列表：

```8:19:packages/st-extension/src/handlers/select-character.ts
export async function handleSelectCharacter(payload: Payload): Promise<Result> {
  const ctx = SillyTavern.getContext();
  const index = ctx.characters.findIndex((c) => c.avatar === payload.avatar);
  if (index < 0) {
    throw new BridgeError(
      'BRIDGE_EXEC_PRECONDITION_FAILED',
      `Character not found: ${payload.avatar}`
    );
  }

  await ctx.selectCharacterById(index, { switchMenu: false });
```

## 4. 读取路径 B：provision 下发

完整调用链：

```text
frontend STIframe mount
  -> POST /api/init-st-session
  -> backend POST /api/bridge/st-session
  -> sync-engine POST /provision/:userId/sync[?force=true]
  -> provision(userId, { force })
  -> fetchProvisionData()
  -> Supabase miniapp.characters where is_published=true and is_active=true
  -> writeCharacters()
  -> copy ST_PLATFORM_ASSETS_PATH/characters/platform_<id>.png
     to ST_DATA_PATH/<handle>/characters/platform_<id>.png
  -> mergeSettings() 校验 active_character
  -> write settings.json
  -> ST iframe ready 后 selectCharacter(platform_<id>.png)
```

前端初始化 ST session：

```17:27:packages/frontend/src/components/bridge/st-iframe.tsx
async function initSession() {
  try {
    const headers: Record<string, string> = {};
    const initData = getRawInitData();
    if (initData) headers[INIT_DATA_HEADER] = initData;

    const res = await fetch('/api/init-st-session', {
      method: 'POST',
      headers,
      credentials: 'same-origin',
    });
```

Next route 转发到 backend：

```18:26:packages/frontend/src/app/api/init-st-session/route.ts
export async function POST(request: NextRequest) {
  const initData = request.headers.get('X-Init-Data') ?? '';

  const backendRes = await fetch(`${BACKEND_URL}/api/bridge/st-session`, {
    method: 'POST',
    headers: {
      ...(initData ? { 'X-Init-Data': initData } : {}),
    },
  });
```

backend 首登三阶段 provision；老用户当前也同步 force=true：

```187:213:packages/backend/src/routes/bridge.ts
// ── 3. 新用户：两阶段 provision（先让 ST 初始化完整目录，再覆盖平台文件）
//    再次登录：异步 provision（不阻塞登录流程）
//
// 新用户两阶段说明（修复 ST content initialization 覆盖问题）：
//   阶段 1：force=false provision → 仅创建 ST 账号（ensureStUser），
//           写入最小文件让 ST 能成功登录
//   阶段 2：loginToSt → 触发 ST 原生 content initialization，
//           ST 会建出 NovelAI Settings / TextGen Settings 等完整目录结构
//   阶段 3：force=true provision → 在 ST 完整目录上覆盖写平台文件
//           （settings.json / characters / presets / secrets.json）
if (isNewUser) {
  log(`[bridge] 新用户首次登录（handle=${stHandle}）`);

  // 阶段 1：创建 ST 账号 + 写最小平台文件
  log(`[bridge]   阶段 1/3：创建 ST 账号 + 初始下发`);
  await triggerProvisionSync(dbUser.id, log);
```

```224:227:packages/backend/src/routes/bridge.ts
} else {
  log(`[bridge] 已初始化用户再次登录（handle=${stHandle}）`);
  await triggerProvisionSync(dbUser.id, log, true);
}
```

sync-engine provision API 支持异步和同步，但 backend 当前使用同步路径：

```65:80:packages/sync-engine/src/provision-api/server.ts
// POST /provision/:userId — 异步（立即返回 202，后台跑）
const provisionMatch = url.match(/^\/provision\/([^/]+)$/);
if (method === 'POST' && provisionMatch) {
  const userId = provisionMatch[1] ?? '';
  if (!userId) {
    jsonResponse(res, 400, { error: 'missing_user_id' });
    return;
  }

  // 立即返回 202，后台异步跑 provision
  jsonResponse(res, 202, { status: 'accepted', userId });

  // 异步触发，不 await
  provision(userId, {
```

```101:120:packages/sync-engine/src/provision-api/server.ts
// POST /provision/:userId/sync — 同步（等待 provision 完成后返回 200）
// 供 Bridge 新用户首次登录时使用：确保 ST 用户账号创建完毕后再尝试 ST 登录
// 支持 ?force=true 查询参数：新用户流程第二阶段（ST 初始化后覆盖写平台文件）
const provisionSyncMatch = url.match(/^\/provision\/([^/]+)\/sync(\?.*)?$/);
if (method === 'POST' && provisionSyncMatch) {
  const userId = provisionSyncMatch[1] ?? '';
  if (!userId) {
    jsonResponse(res, 400, { error: 'missing_user_id' });
    return;
  }

  // 解析 ?force=true 参数
  const queryStr = provisionSyncMatch[2] ?? '';
  const forceParam = new URLSearchParams(queryStr.replace(/^\?/, '')).get('force');
  const force = forceParam === 'true';

  try {
    const result = await provision(userId, {
```

provision 编排顺序：

```100:124:packages/sync-engine/src/provisioner/index.ts
// ── 3. order=10：写角色卡 PNG（资产层）─────────────────────────────────────
log('[provision] 步骤 3/5：下发角色卡 PNG（order=10）...');
let charResult;
try {
  charResult = writeCharacters(stHandle, characters, force);
} catch (err) {
  throw new ProvisionError(`写入角色卡失败：${err}`, err);
}
log(
  `[provision]   写入=${charResult.written.length}, 跳过=${charResult.skipped.length}, 缺失=${charResult.missing.length}`
);
if (charResult.missing.length > 0) {
  log(`[provision]   ⚠️  缺失的角色卡 id：${charResult.missing.join(', ')}`);
  log(`[provision]      请确认 ST_PLATFORM_ASSETS_PATH 目录中包含对应的 platform_<id>.png 文件`);
}

// ── 4. order=20：写预设 JSON（资产层）─────────────────────────────────────
log('[provision] 步骤 4/5：下发预设文件（order=20）...');
```

筛选逻辑：只下发 `is_published=true` 且 `is_active=true` 的角色卡，按 `sort_order asc`。

```102:112:packages/sync-engine/src/provisioner/fetcher.ts
// 并行拉取所有数据（users 查询需要先拿到 handle 再查 user_st_settings）
const [userResult, charactersResult, presetsResult, platformSettingsResult, apiConfigResult] =
  await Promise.all([
    db.from('users').select('st_handle').eq('id', userId).single(),
    // ⚠️ .schema() 必须在链首（Supabase JS v2 要求）
    schemaClient('miniapp')
      .from('characters')
      .select('*')
      .eq('is_published', true)
      .eq('is_active', true)
      .order('sort_order', { ascending: true }),
```

文件名规则：源和目标都是 `platform_<id>.png`。

```38:45:packages/sync-engine/src/lib/st-fs.ts
/** 平台资产目录下某角色卡的源 PNG 路径：ST_PLATFORM_ASSETS_PATH/characters/platform_<id>.png */
export function platformCharacterSrc(characterId: string): string {
  return join(config.ST_PLATFORM_ASSETS_PATH, 'characters', `platform_${characterId}.png`);
}

/** data/<handle>/characters/platform_<id>.png */
export function characterDst(handle: string, characterId: string): string {
```

增量 vs 全量：

- `force=false`：目标文件已存在则跳过，缺失则复制。
- `force=true`：只要源 PNG 存在，就覆盖复制。
- `settings.json` 和 `secrets.json` 总是覆盖写，不走 `writeCharacters` 的 skip 逻辑。

```55:71:packages/sync-engine/src/provisioner/writer.ts
for (const char of characters) {
  const src = platformCharacterSrc(char.id);
  const dst = characterDst(handle, char.id);

  if (!existsSync(src)) {
    // 平台资产目录缺失这张卡的 PNG
    missing.push(char.id);
    continue;
  }

  if (!force && existsSync(dst)) {
    skipped.push(char.id);
    continue;
  }

  copyFileSync(src, dst);
  written.push(char.id);
```

```110:117:packages/sync-engine/src/provisioner/writer.ts
// ─── 写 settings.json ─────────────────────────────────────────────────────────
/**
 * 将 merge 后的 settings 对象写入 data/<handle>/settings.json。
 * settings.json 总是覆盖写（merge 结果本身已经融合了用户偏好）。
 */
export function writeSettings(handle: string, mergedSettings: MergedSettings): void {
  const dst = settingsPath(handle);
```

默认卡和失效兜底：

```142:151:packages/sync-engine/src/provisioner/index.ts
// 已下发的角色卡 id 列表（用于 character_ref 有效性校验）
const availableCharIds = [
  ...charResult.written,
  ...charResult.skipped, // 跳过的文件已存在，也视为可用
];
const defaultChar = characters.find((c) => c.is_default);

let merged;
try {
  merged = mergeSettings(platformSettings, userSettings, availableCharIds, defaultChar);
```

```98:102:packages/sync-engine/src/provisioner/merger.ts
/** 构造兜底的 character_ref 值（platform_<default_uuid>.png） */
function buildFallbackCharRef(defaultCharacter: CharacterRow | undefined): string | undefined {
  if (!defaultCharacter) return undefined;
  return `platform_${defaultCharacter.id}.png`;
}
```

如果没有默认卡，测试显示不会崩溃，但失效值会保留：

```174:187:packages/sync-engine/src/provisioner/__tests__/merger.test.ts
// ── 场景 6：character_ref 失效 + 无默认卡 ───────────────────────────────
it('character_ref 失效且无默认卡时不崩溃，hadInvalidRef=true，字段保持失效值', () => {
  const MISSING_UUID = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
  const platform = makePlatformSettings();
  const userSettings = makeUserSettings({
    settings_jsonb: { active_character: `platform_${MISSING_UUID}.png` },
  });

  // 不传默认卡
  const result = mergeSettings(platform, userSettings, [], undefined);

  expect(result.hadInvalidRef).toBe(true);
  // 没有兜底卡，字段仍为失效值（ST 可能会自行处理）
  expect(result.settings['active_character']).toBe(`platform_${MISSING_UUID}.png`);
```

## 5. 数据流全景图

```mermaid
flowchart LR
  subgraph Supabase
    C[miniapp.characters<br/>角色卡元数据]
    P[st_platform.platform_presets<br/>预设]
    S[st_platform.platform_settings<br/>active_character 默认/白名单]
    U[st_users.user_st_settings<br/>用户 active_character 镜像]
  end

  subgraph Backend
    B1[GET /api/characters<br/>where enabled=true]
    B2[POST /api/bridge/st-session<br/>触发 provision]
  end

  subgraph Frontend
    F1[CharacterGallery<br/>大厅列表]
    F2[CharacterCard img<br/>src=avatar_url]
    F3[/tavern/:characterId<br/>selectCharacter platform_id.png]
  end

  subgraph SyncEngine
    SE1[fetchProvisionData<br/>where is_published=true and is_active=true]
    SE2[writeCharacters order=10]
    SE3[mergeSettings order=100<br/>校验 character_ref]
  end

  subgraph STFileSystem
    A[ST_PLATFORM_ASSETS_PATH/characters/platform_id.png]
    D[ST_DATA_PATH/handle/characters/platform_id.png]
    SET[ST_DATA_PATH/handle/settings.json]
  end

  C --> B1 --> F1 --> F2
  F1 --> F3
  B2 --> SE1
  C --> SE1
  P --> SE1
  S --> SE1
  U --> SE1
  A --> SE2 --> D
  SE1 --> SE3 --> SET
  F3 -. bridge .-> D
```

## 6. 发现的问题与风险

- 大厅和 provision 的上架字段不一致。大厅实际用 `enabled=true`，provision 实际用 `is_published=true AND is_active=true`。结果是：一张卡可能出现在大厅但没有下发到用户 ST 文件系统，用户点击后 ST handler 找不到 `platform_<id>.png` 并报 `Character not found`。

```13:17:packages/backend/src/routes/characters.ts
app.get('/api/characters', async (request, reply) => {
  const characters = await prisma.character.findMany({
    where: { enabled: true },
    orderBy: [{ sort_order: 'asc' }, { created_at: 'desc' }],
  });
```

```107:112:packages/sync-engine/src/provisioner/fetcher.ts
schemaClient('miniapp')
  .from('characters')
  .select('*')
  .eq('is_published', true)
  .eq('is_active', true)
  .order('sort_order', { ascending: true }),
```

- `schema.prisma` 和 Phase 0 迁移意图不一致。迁移意图是 rename `enabled -> is_published`，但 Prisma schema 当前同时有 `enabled` 和 `is_published`。这需要在阶段 5 明确以哪个字段为最终真相。

```26:34:packages/backend/prisma/migrations/20260623113000_phase0_drop_sessions_character_flags/migration.sql
ALTER TABLE miniapp.characters RENAME COLUMN enabled TO is_published;
  ELSIF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'miniapp'
      AND table_name = 'characters'
      AND column_name = 'is_published'
  ) THEN
    ALTER TABLE miniapp.characters ADD COLUMN is_published BOOLEAN;
```

```265:269:packages/backend/prisma/schema.prisma
is_default                Boolean  @default(false)
enabled                   Boolean  @default(true)
sort_order                Int      @default(0)
is_published              Boolean  @default(true)
is_active                 Boolean  @default(true)
```

- Supabase Storage 在当前代码中未落地。`ARCHITECTURE.md` 写“Supabase Storage / 平台资产目录”，但 provision 实际只从 `ST_PLATFORM_ASSETS_PATH` 复制本地 PNG。阶段 5 若要迁 Storage，需要新增表字段、下载逻辑、同步校验和 SOP。

```38:45:packages/sync-engine/src/lib/st-fs.ts
/** 平台资产目录下某角色卡的源 PNG 路径：ST_PLATFORM_ASSETS_PATH/characters/platform_<id>.png */
export function platformCharacterSrc(characterId: string): string {
  return join(config.ST_PLATFORM_ASSETS_PATH, 'characters', `platform_${characterId}.png`);
}

/** data/<handle>/characters/platform_<id>.png */
export function characterDst(handle: string, characterId: string): string {
```

- PNG 缺失不是 fatal。provision 会继续写 settings，可能导致 `active_character` 指向没有实际 PNG 的文件。虽然 merge 会用 `written + skipped` 做有效性校验，但如果没有默认卡，失效值会保留；如果大厅仍展示这张卡，用户点击仍会失败。

```142:147:packages/sync-engine/src/provisioner/index.ts
// 已下发的角色卡 id 列表（用于 character_ref 有效性校验）
const availableCharIds = [
  ...charResult.written,
  ...charResult.skipped, // 跳过的文件已存在，也视为可用
];
const defaultChar = characters.find((c) => c.is_default);
```

- `avatar_url` 与 ST 可用 PNG 是两套路径。大厅卡片图片用 `avatar_url`，ST 对话实际用 `platform_<id>.png`。一张卡即使大厅有封面图，也不代表 ST 文件系统里有角色卡 PNG。

```21:27:packages/backend/src/routes/characters.ts
id: c.id,
name: c.name,
description: c.description,
avatar_url: c.avatar_url,
personality_tags: Array.isArray(c.tags) ? (c.tags as string[]) : [],
author_name: c.creator,
```

```15:16:packages/frontend/src/app/tavern/[characterId]/page.tsx
const avatar = `platform_${characterId}.png`;
platformAction('selectCharacter', { avatar }).catch((err) => {
```

- backend 大厅排序有 `created_at desc` 兜底，provision 只按 `sort_order`。同 sort_order 时，前端展示顺序和下发/默认选择相关顺序不一定一致。

```16:16:packages/backend/src/routes/characters.ts
orderBy: [{ sort_order: 'asc' }, { created_at: 'desc' }],
```

```112:112:packages/sync-engine/src/provisioner/fetcher.ts
.order('sort_order', { ascending: true }),
```

- 删除语义不完整。当前没有角色卡删除 API。`st_users.user_st_chats.character_id` 对 `miniapp.characters` 是 `ON DELETE SET NULL`，但 ST 文件系统中的 `platform_<id>.png` 不会自动删除，用户目录中的已物化 PNG 也不会随 DB 删除清理。

```21:23:packages/shared/migrations/009_user_st_chats.sql
-- 跨 schema FK 到平台卡池。用户切换到 ST 私有卡时记 NULL（D007）
character_id    UUID REFERENCES miniapp.characters(id) ON DELETE SET NULL,
```

## 7. 给运营写 SOP 时需要注意的关键点

- 不要只在 Supabase 表里加一行。当前代码要求 PNG 也必须存在于 `ST_PLATFORM_ASSETS_PATH/characters/platform_<id>.png`，且 `<id>` 必须等于 `miniapp.characters.id`。

- 不要把大厅封面图和 ST 角色卡 PNG 混为一谈。`avatar_url` 只影响大厅 `<img src>`；ST 对话使用的是用户目录下的 `characters/platform_<id>.png`。

- 上架字段目前有分叉。若只改 `enabled=true`，卡可能出现在大厅；若没同时满足 `is_published=true AND is_active=true`，provision 不会下发。SOP 在阶段 5 前必须明确要求三者同步，或先修代码统一字段。

- 默认卡只能有一张。数据库有 `idx_characters_one_default` 部分唯一索引；新增默认卡前必须先取消旧默认卡，否则写入会失败。

- PNG 缺失不会让 provision 失败。运营不能只看接口是否返回成功；需要检查 provision 日志中的 `charactersMissing`，或在阶段 5 补一个明确的发布前校验。

- 旧用户目录已经物化的 PNG 不会因 DB 下架/删除自动清理。当前 `force=true` 会覆盖存在的同名文件，但不会删除“已不在查询结果中的旧文件”。下架策略需要区分“不再给新用户下发”和“老用户是否继续保留”。

- 当前没有上传接口、没有后台校验、没有 Storage 下载链路。阶段 5 如果要写“运营上传 SOP”，工程上应优先补：上传入口、PNG 元数据解析、DB+PNG 原子性校验、Storage path 字段、发布前检查、回滚策略。
