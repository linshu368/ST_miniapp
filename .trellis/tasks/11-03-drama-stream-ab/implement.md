# 执行顺序（用户已批准实施）

粗估 4 个工程步骤，涉及 shared、Backend、Frontend 及既有工程观测，外加 1 次 TEST 真机验收。预计新增两个小模块（Stream 播放签名、HLS 装载），一个浏览器依赖；无新增 API 路由、数据库对象、服务或后台。实际耗时受 TEST 凭证、真机与现有观测版本影响。

1. 已对照 dev 06be3000：起播诊断已移除旧持久化处理器；复用现有 telemetry 路由、前端指标和日志。实施时从最新 dev 建隔离工作区，核对当前 shared/route/播放器/计时/旧端兼容和本地规范版本。先按已选 30 条逐一核对目标环境的默认首播、竖屏方向、封面和对应同源原片，再准备 TEST 映射与关闭默认。Cloudflare 操作在 TEST 接入获得授权后做，参见 cloudflare-setup.md。
2. 扩展 shared /play 请求能力、可选播放格式和 delivery 有限枚举，继而实现 runtime-config、已鉴权固定分组、白名单和仅后端本地签名。保留旧 Supabase/Bunny 契约，不把旧客户端计为新实验组。同一有序清单驱动默认推荐的前 30 位和服务端单集准入；两臂列表顺序一致，片外原顺序不变。区分关流、未入组、片外与因故回退；所有恢复仍过同一权限校验。
3. 扩展播放器的源装载与释放，维护一个 video 元素；兼容原生 HLS 及动态 hls.js，保留 seek、暂停/恢复、换集和重试状态。适配 blob 源与观察代际，不依赖清单 URL 等于 currentSrc；验证失败只恢复一次、超时、过期和快速切源/意图取消。
4. 贯通新实验分组到既有全量起播和 seek 的耗时/终态，给出按组可复现的 3 秒查询；旧 5 秒面板保持原义。检查共享契约、旧 consumer、日志/网络追踪的路径 token 脱敏；仅用本地模拟或 TEST 查询验证，生产看板发布另批。

验证命令（届时最新 dev）：

- pnpm --filter @miniapp/shared test；pnpm --filter @miniapp/backend test；pnpm --filter @miniapp/frontend test；
- pnpm -r typecheck；pnpm -r --if-present lint；pnpm -r --if-present build；
- pnpm test:ui --grep @drama：扩展既有 fixture/用例验证前 30 位两臂一致、余片无重漏、搜索/最新/续看及显式选集保留语义；再验证两源、换集、未缓冲拖动、错误与一次恢复、关闭后新意图回 MP4。没有真实 HLS 能力的模拟器不能用作 Stream 真机验收。
- TEST 先兼容后端且保持关流，部署新版前端，确认私有链接与负例、旧版本 MP4、模拟和真机两平台、两臂及两个指标可读后再谈生产。若首轮安卓 blob 归属不成立，不得拿仅 iOS 的通过宣布跨平台通过。
- 新片上线或改动片单时必须复核源文件身份、就绪状态与环境；无需重传 Supabase/历史数据。同步相关 README/架构/spec 的实际变化，不修改历史 migration。建议用既有剧场 UI 验收长期保留兼容和回退场景，真机及供应商性能独立验收。

实际新增 Stream 配置/签名模块、HLS 装载模块、两项回归检查与只读复算脚本。状态与验证见 verification.md。
