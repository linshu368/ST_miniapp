# 本地实现与 TEST 素材验证

工作区为 `codex/drama-stream-ab`，已同步 dev `6ef2b2d3`，与用户主工作区隔离。

## 已验证的实现

- 30 项有序环境清单同时驱动默认推荐置顶和单集准入。独立 HMAC 入组与固定 50:50 分组。互斥 Bunny，关闭或坏配置恢复原路径，迟到观测仍可核对原实验身份。
- 旧客户端 MP4、新端 A/B、后端本地私有签名、签名失败、一次 Supabase 回退，回退保留 B 组及计时根。签名 15 分钟，支持 PEM 与 base64 PEM。
- 同一 video 元素原生 HLS/动态 hls.js，销毁和取消异步装载，blob 来源观测，签名媒体路径脱敏。
- 两项 3 秒读数复用既有观察。只读复算按重试根、原分组、可测成功 P95、终态与人数输出。合成数据验证：原 B 失败后累计 3500ms 恢复仍为 B，单意图只算一次；向前未缓冲快进单独计数。

## 本地检查

- shared：17 文件、197 项通过。
- Frontend：61 文件、697 项通过，后续计时相关既有用例复核通过。
- Backend：同步上游后 119 文件、1322 项通过。
- 全工作区 typecheck、适用 lint 和全包 build 通过。最后变更后受影响包 typecheck/build 已复核。lint/build 留有仓库现有 img、依赖与 chunk 体积提示。
- `pnpm test:ui --grep @drama`：43 项首轮通过。1 项测试因仍清理 v1 目录缓存而失败，按新缓存键更新既有用例后单项复跑通过。覆盖换集、恢复、退出后迟到请求、空状态等原有流程；同步上游 `/watch` 入口后，Android 重点播放/重试/迟到恢复的 4 项再次通过。真实 Stream 真机验证另计。
- `git diff --check` 通过。

## TEST 素材和剩余验收

2026-11-04 用户交付 Cloudflare TEST 配置后，确认该片单 TEST 仅有 2 条同源视频。用户随后授权补齐 28 条。仅从生产读取原片和剧目元数据，写入目标固定的 TEST 项目，原片/封面上传拒绝覆盖且完整 SHA-256 回读一致后才登记可播状态。源文件经 ffprobe 核对时长、显示方向和音轨。

准备脚本和逐条回执在本机私有目录 `telegram-video-archive/.private/experiments/stream-ab-30/`。Stream 创建时启用 requireSignedURLs，回执及时保存 UID，超时状态先查现有资产再决定重试。秘钥、原始媒体路径、带播放凭证的 URL 和真实映射均留在受保护目录。

首批私有播放检查已通过。Python 默认请求特征曾收到 Cloudflare 1010，采用手机浏览器请求特征后，有效签名正常、多档清单可读，裸 UID/过期签名受拒。该检查验证协议和访问权限，真实 Telegram 首帧、画质及未缓冲快进仍待 TEST 部署后进行。

最终 v3 片单 30/30 原片及封面可用、默认单集一致；105.768 分钟，30/30 竖屏并有原音轨，30/30 requireSignedURLs=true、readyToStream=true、state=ready、pctComplete=100。每条均有 2–5 档实际视频清单，合法签名和媒体清单可读取，裸 UID/过期签名拒绝。

用户要求将第10、18条单档原片替换为可产出多档的高分辨率候选。其余28个位置保留，现用 stream-ab-30-portrait-abr-v3。两份退役TEST资产和历史回执保留，共32份Cloudflare素材。仅有效30条进入运行清单。

TEST 后端环境文件已生成在私有目录 backend-env.json，权限600，默认保持关流；使用实际签名配置和30条清单通过后端runtime-config预检。敏感配置、UID映射和源对象路径不进入Git。

同步上游采用本窗口专属暂存备份和fast-forward，仅播放器错误回调有一处冲突，已同时保留Stream恢复和上游/watch视觉观测。同步后全工作区typecheck、197项shared、697项frontend、1322项backend测试及前端build通过。

接下来需提交/推送代码并准备独立TEST预览，之后由Telegram iOS/Android真机验收。生产部署、生产分流及正式P95结论待独立验收和授权。

最后以本次实际 Backend signStreamPlayback 和实际 TEST runtime-config 对真实资产签名，请求 HLS 返回200、清单有效。没有使用管理 API 参与播放取址。用户已确认提交、推送并创建面向dev的PR。提交前补齐mobile_performance声明并验证通过，复杂度门禁通过；Stream查询和一次恢复已抽到独立hook，主播放器较抽取前缩短43行。现有大文件仍有非阻断的体积增长提示，未放宽基线。
