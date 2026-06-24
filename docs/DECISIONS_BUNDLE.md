# 已决议内容汇总

## 主题 1:ST 代码引入方式

**决议: Vendoring\(将 ST 源码直接拷贝进主仓库\)**

- 路径: `vendor/sillytavern/`

- 锁定一个 ST commit,**真·永不升级**

- ST 源码视为只读,任何定制通过外挂方式实现:
  - 行为定制 → `packages/st-extension`\(走 ST 官方扩展机制\)

  - 视觉定制 → 外挂 user\.css

  - 配置定制 → ST 自身的 config\.yaml / 环境变量

- 引入时一次性操作: 删除 \.git、写 NOTICE\.md 标明出处和版本

- ST 自身的 package\.json 和 lockfile 保留并 commit

- 文档: `docs/VENDOR_ST.md`\(替代之前的 ST_SUBMODULE\.md\)

- ADR\-0001 改为"ST 作为 vendored 代码"

**废弃方案**: submodule\(永不升级前提下纯增加复杂度\)、独立仓库\(跨仓库协调成本高\)、预构建镜像\(无法注入定制\)

---

## 主题 2:包结构与模块边界

### 2\.1 目录结构

```Markdown
ST_miniAPP/
├── .github/workflows/             ← CI(无 submodules 配置)
├── .husky/
├── docs/
│   ├── ARCHITECTURE.md
│   ├── BRIDGE_PROTOCOL.md
│   ├── VENDOR_ST.md
│   ├── SAAS_CHANGES.md
│   └── decisions/                 ← ADR
├── ops/
│   ├── nginx/
│   ├── docker/
│   └── seed/                      ← 初次部署种子脚本
├── packages/
│   ├── bridge-protocol/           ← 仅 ESM,被三方导入
│   ├── st-extension/              ← TS + tsup 产 IIFE,注入 ST
│   ├── frontend/                  ← 平台前端
│   ├── backend/                   ← 平台后端(内含 sync-engine HTTP client)
│   ├── sync-engine/               ← 阶段一已交付,阶段二扩展
│   └── shared/                    ← 平台业务共享类型
├── vendor/
│   └── sillytavern/               ← Vendoring,只读
└── (root configs)
```

**砍掉**: `platform-assets/` 目录、Git LFS 配置\(角色卡 PNG 直接进 Supabase Storage\)

### 2\.2 st\-extension 包\(原 st\-injection 重命名\)

- TypeScript 写,通过 monorepo 共享 `bridge-protocol` 类型

- 用 tsup 构建,产物 IIFE 格式 \+ browser platform \+ 全部依赖打入产物

- Docker 镜像构建时拷贝到 `vendor/sillytavern/public/scripts/extensions/miniapp-bridge/`

- CI 加冒烟测试

### 2\.3 sync\-engine\(阶段一已交付,阶段二扩展\)

**重要更正**: sync\-engine 已经包含双向同步\(下行 bridge\-api \+ 上行 watch\),**不存在 provisioning 独立模块**。backend 只通过 HTTP client 调用 sync\-engine 的 bridge\-api。

### 2\.4 bridge\-protocol 包

- 纯协议契约,无运行时副作用

- **仅产 ESM**\(不需要 IIFE,st\-extension 自己打包时会把它打入\)

### 2\.5 进程拓扑\(Railway 5 个独立部署单元\)

| 进程                     | 包                    | 入口         | 职责                                                           |
| ------------------------ | --------------------- | ------------ | -------------------------------------------------------------- |
| miniapp 后端             | packages/backend      | start        | 平台业务 \+ 鉴权桥 \+ sync\-engine HTTP client \+ LLM 代理网关 |
| ST 服务                  | vendor/sillytavern    | server\.js   | ST 前后端，加载 st\-extension                                  |
| sync\-engine bridge\-api | packages/sync\-engine | start:bridge | HTTP 服务，响应物化触发                                        |
| sync\-engine watch       | packages/sync\-engine | start:watch  | 监听 ST 文件系统，回流到 Supabase                              |
| nginx                    | ops/nginx             | 标准启动     | 反向代理统一入口                                               |

## 主题 3:数据流与权威源

### 3\.1 用户身份

阶段二不动,完全复用阶段一交付物。

### 3\.2 订阅与计费

阶段二跳过。但 LLM 代理网关需预留扩展位。

### 3\.3 角色卡库

**权威源**: Supabase\(Storage 存 PNG \+ 数据库存元数据\)

**双层标志**:

- `is_published`: 控制大厅展示和新用户下发

- `is_active`: 控制是否可继续使用

**状态组合**:

| is_published | is_active | 大厅展示 | 新用户 provision | 老用户继续使用 |
| ------------ | --------- | -------- | ---------------- | -------------- |
| true         | true      | ✓        | ✓                | ✓              |
| false        | true      | ✗        | ✗                | ✓（已物化的）  |
| false        | false     | ✗        | ✗                | ✗              |

**用户编辑权限**: 阶段二完全禁止;角色卡全平台共享,无私有概念。

### 3\.4 预设\(运营内容\)

**权威源**: Supabase

**用户权限方向**: 用户可切换预设\(整套切换\),也可修改预设内部某些配置。用户的修改属于"用户私有运行时真相",需回流到 Supabase。

### 3\.5 用户私有聊天记录

**权威源**: ST 文件系统\(原生写入\)
**镜像源**: Supabase\(sync\-engine watch 异步回流\)

**回流要求**: 分钟级延迟,最终一致,完整不丢失

### 3\.6 用户私有运行时真相\(广义\)

| 内容                   | 回流策略                                              |
| ---------------------- | ----------------------------------------------------- |
| 聊天记录               | 实时回流（分钟级最终一致）                            |
| settings\.json 用户段  | 实时回流                                              |
| 用户修改的预设         | 实时回流                                              |
| 当前选中角色等瞬时状态 | 节流回流（3\-5 分钟一次）\+ 进程结束/登出前强制 flush |

### 3\.7 ST settings\.json 分段

每个用户工作目录下 settings\.json 分两段:

- **平台管控段**: LLM endpoint、instruct templates、context templates、默认采样参数等。provision 时从 Supabase 全平台统一下发。

- **用户可修改段**: UI 偏好、用户对预设的微调等。watch 时回流到 Supabase 用户私有镜像;provision 时从用户私有镜像恢复。

settings\.json 的"分段"由 sync\-engine 维护字段清单\(ST 原生不分段\)。

### 3\.8 平台运营内容\(banner、活动配置\)

阶段二跳过。

### 3\.9 LLM 代理网关\(关键决议\)

**形态**: backend 提供 OpenAI 兼容代理接口

**ST 配置**\(在 settings\.json 平台管控段\):

- LLM endpoint = `https://your-domain.com/api/platform/llm-proxy/v1/`

- API key = 平台签发的内部 token

**backend 代理网关职责\(阶段二最简版\)**:

- 验证 JWT / 内部 token

- 识别用户\(从 token 解 userId\)

- 持有平台真实 API key

- 转发请求到真实 LLM endpoint\(支持流式 SSE 透传\)

- **预留扩展位**\(阶段三\): 配额检查、扣减、审计日志、限流、风控、缓存

**预期工作量**: 300\-500 行代码

### 3\.10 sync\-engine 阶段二改造范围\(完整版\)

| \#  | 改造项                                                                                               | 优先级 |
| --- | ---------------------------------------------------------------------------------------------------- | ------ |
| 1   | 角色卡 provision 改为增量                                                                            | P0     |
| 2   | 预设 provision 保持全量覆盖                                                                          | P0     |
| 3   | 实时广播能力（Supabase Realtime \+ is_published 翻转）                                               | P0     |
| 4   | provision 状态查询接口（供前端检查角色卡是否已物化）                                                 | P0     |
| 5   | 失败重试 \+ 死信队列                                                                                 | P1     |
| 6   | provision 扩展：下发用户私有运行时真相镜像（用户上次的 settings 用户段、用户修改的预设、聊天记录等） | P0     |
| 7   | watch 扩展：回流 settings\.json 用户段、用户修改的预设                                               | P0     |
| 8   | watch 节流回流：当前选中角色等瞬时状态（3\-5 分钟节流）                                              | P1     |
| 9   | flush 接口：进程结束/登出前强制回流                                                                  | P0     |
| 10  | settings\.json 分段管理：维护字段清单，provision 与 watch 分别处理                                   | P0     |
| 11  | 下架卡（is_published=false）对新用户不再下发                                                         | P0     |

### 3\.12 Provision 触发与 UI 时序

**首次登录**:

```Markdown
登录成功 → JWT 签发 → 跳大厅(立即,不阻塞)
            ↓
        backend 异步调 sync-engine
            ↓
        后台物化(角色卡 + 预设 + 用户运行时真相镜像)
```

**用户进入聊天前检查**:

```Markdown
用户点击角色卡
    ↓
前端调 backend 检查 → backend 调 sync-engine 状态查询
    ↓
├── 已物化(99%) → 直接进
└── 未物化 → UI 显示"准备中" + 进度,完成后自动进入
```

**运营上新角色卡**:

```Markdown
运营在 Supabase 上传角色卡(is_published=false)
    ↓
sync-engine Realtime 订阅感知
    ↓
对 users 表所有注册用户进行物化(失败入死信队列)
    ↓
≥99% 用户成功 → 翻转 is_published=true
    ↓
用户刷新大厅时,backend 返回新卡
```

## 当前阶段架构的核心决议

1. 构建工具链
   turborepo 编排 monorepo,声明式 turbo.json,与 Vercel/Railway 部署天然集成,支持增量构建与远程缓存。

2. 本地开发环境
   混合模式:

基础设施(nginx + vendor ST + Supabase)走 docker-compose
应用代码(frontend / backend / sync-engine / st-extension)走裸进程,由 turbo dev 编排
Supabase 本地用 supabase-cli 起本地实例
nginx 本地端口 8443 3. 环境变量治理
命名前缀(按消费者分区)
前缀 用途
PUBLIC* 暴露给浏览器
BACKEND* miniapp 后端私有
SYNC* sync-engine 私有
ST* ST 进程相关
SUPABASE* Supabase 连接
LLM* LLM 上游配置
BRIDGE\_ Bridge Protocol 常量
三层管理
.env.local(gitignore,本地开发)
.env.example(commit,模板)
Railway / Vercel dashboard(staging / prod secrets)
强制校验
每个进程入口用 zod 校验 env,缺失或类型错误立即 throw,启动失败优于运行时报错。

4. 共享类型四包细分
   包 职责 消费者
   bridge-protocol postMessage 协议契约 frontend, st-extension
   api-contract REST API Zod schema frontend, backend
   db-types Supabase schema 镜像(机器生成) backend, sync-engine
   shared 领域常量、纯工具 所有包
   核心纪律:

frontend 禁止 import db-types(防止 DB schema 泄露到客户端)
api-contract 禁止 import db-types(强制 DB 与对外 API 解耦)
ESLint 跨包 import 规则强制约束 5. db-types 生成流程(渐进方案)
当前阶段:

schema 变更:Supabase Dashboard 手敲 SQL(保留现有工作流)
类型生成:开发者本地手动 pnpm db:gen + commit 生成产物
CI 加 drift check:对比仓库 db-types 与远程 schema,不一致则 fail
未来阶段:阶段二完结前择机切换到 supabase migrations 工作流。
