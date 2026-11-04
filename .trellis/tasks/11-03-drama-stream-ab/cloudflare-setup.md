# 你需要准备什么：仅 TEST

## 现在先确认（不需要分享凭证）

1. 选择准备用于 TEST 的 Cloudflare 账户，确认有权限启用 Stream 点播和管理账单，记下 Account ID。无需先迁网站 DNS、购买域名、创建 R2 桶或部署 Workers。若账户已有生产视频，先确定测试权限边界；账号级管理 token 不会因为给视频加 TEST 标签而缩小权限。
2. 核对 30 个原片总时长（按归档约 105.75 分钟），确认可用存储分钟和测试交付预算；已开通的账户先看剩余容量。公开单价：每月每 1,000 分钟存储容量 $5，每 1,000 分钟实际交付 $1；转码档位不重复计存储，预加载/缓冲的媒体也可计交付。开通/购买前由账户负责人确认。
3. 按本地候选清单按竖屏 v2 清单为 30 部剧分别核对其首播原片及显示方向，匹配实际 TEST video_id（不可直接使用候选的生产归档 ID）。记录与目录来源的对应关系。使用原始质量；不需要自行制作低码率版本或上传业务表。TEST MiniApp 的实际网页域名供联调核对，不是 Telegram 的通用域名。

## 进入 TEST 对接时

- 在目标账户启用 Stream。在 Cloudflare 的 API Tokens 页面选择 Create Token → 自定义 token，权限只给 **Account / Stream / Edit（API 名 Stream Write）**，资源只限目标 TEST 账户，设置合适到期时间。少量资产可以手动上传；此方案使用管理 token 一次性创建签名密钥/导入和核验资产。不要使用 Global API Key，不将管理 token 部署为播放服务的长期运行凭证。
- 用管理 token 一次性调用 `POST /accounts/{account_id}/stream/keys` 生成 TEST Stream signing key，记录返回的 key ID；PEM 或 JWK 私钥只进受保护的 TEST 后端 secret。账户 API token 是管理凭证，signing key 用于签短时观看 token，两个用途不同。不要把它们贴进聊天、代码、任务文档、日志或前端变量。
- 使用本地原片或受控的 TEST 对象短时下载地址导入。按私有素材创建，开启 requireSignedURLs；如使用 Allowed Origins，仅批准实际 TEST MiniApp 网页来源，核验 iOS/Android 清单及片段访问。来源白名单不能代替签名。
- 从 Stream → Videos 查看每条视频的 UID、HLS 播放主机（customer-… 形式）。等 readyToStream 且 state=ready、pctComplete=100 后检查实际多档、音轨、时长、字幕清晰度；测试裸 UID 拒绝、合法短时签名可播、过期拒绝，并确认切到片中/片尾能恢复。授权后的 TEST 准入清单只记录 video_id、UID、就绪和验证结论，不存带 token 的 URL。
- 对接交付分两部分：**普通配置**为 TEST Account ID、Stream 播放主机、key ID 和30 条有序就绪映射；**受保护配置**为签名私钥，管理 token 仅一次性操作使用。播放端无需管理 token、Supabase 管理密钥或 Cloudflare 登录权限。实际映射和真实供应商凭证均不提交 Git。
- 准备 production 资产、正式配额和权限属于后续独立工作。TEST 的视频 ID、映射、账户权限和真机验收不能用作生产已就绪的凭据。

官方文档：[开始使用](https://developers.cloudflare.com/stream/get-started/) · [计费](https://developers.cloudflare.com/stream/pricing/) · [账户级 token 权限](https://developers.cloudflare.com/fundamentals/api/reference/permissions/) · [签名与来源限制](https://developers.cloudflare.com/stream/viewing-videos/securing-your-stream/) · [转码完成条件](https://developers.cloudflare.com/stream/manage-video-library/using-webhooks/) · [复用播放器](https://developers.cloudflare.com/stream/viewing-videos/using-own-player/)。
