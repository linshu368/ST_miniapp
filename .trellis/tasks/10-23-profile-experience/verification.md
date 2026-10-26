# 本地验收记录（2026-10-23）

## 实现与范围

独立工作区`feat/profile-experience`，基于origin/dev 03ee7b6e。原工作区其他开发未切换或提交。本轮只改Frontend及规范记录，未commit/push/发布，无真实交易、奖励、入群或账户修改。

## 自动检查

- Frontend typecheck通过。
- Frontend Vitest：48文件、339测试通过（包括已确认奖励缓存与商品隔离/中文折数）。
- Frontend lint通过，只有5条既存影像img警告；本轮文件无新增错误。
- root lint:imports、lint:legacy、git diff --check通过。
- 完整生产构建通过，14静态页面及所有动态路由生成成功。构建在全新临时目录独立安装锁定依赖，workspace symlink均位于该目录；865份输入与交付源码逐一sha256相同。未修改正式环境构建配置或环境变量。

## 实际浏览器（CUA，虚拟手机尺寸）

- 375×812：我的页签到/充值靠前、机器人客服、次级服务，头像菜单和长昵称不溢出。签到确认后立即更新，失败可重试。社区rewarded才隐藏，到账弹窗仍存在。
- 320×568：充值和月卡页document宽度320，无横溢。底部主按钮top508/bottom556完整可点，支付宝与主按钮分行。
- 390×844：已开通会员中心显示金色身份卡、31天、有效期和已生效权益；续费¥28.88的按钮top784/bottom832完整可点。
- 未开通以3,000专项为主视觉，签到加成/折扣/模型为第二层；已开通在我的页显示金环与VIP标记，入口切为会员中心，会员页身份优先。
- VIP只显示month；月卡缺失时禁用购买，不回退历史周卡。历史有效会员身份仍正确保留。
- 虚拟下单失败显示明确错误，按钮恢复可重试；重试成功打开原支付宝指引，取消关闭可继续操作。没有点击打开支付宝付款。
- 本机fixture捕获两笔独立pending订单：vip/month/alipay/2888分，credits/plan-entry-6/alipay/1580分。钱包保持1280未变化。未调用真实网关，不以此声称实际扣费/入账验收。
- 充值带聊天returnTo进入VIP后，安全回流为`/profile/recharge?returnTo=%2Fchat%2Fpreview%3Ffrom%3Ddiscover`，没有丢失原聊天去向或重复余额不足参数。
- 线上公开配置只读核对仅支付宝，预览一致；支付组件、VPN指引、外链打开、订单轮询/服务端入账均沿用既有实现。既有订单成功分支会invalidate wallet、vip status与model catalog，使新会员状态重新读取。

## 构建环境问题与恢复

首次隔离构建复用了外部node_modules symlink，Next standalone追踪出界失败；在该失败目录重建时，Next清理追踪链接误及本任务Frontend工作区。立即停止使用该目录，从构建前sha256清单恢复209个缺失文件，所有备份校验一致、无不同的现存文件被覆盖，并保存第二份源码备份。独立依赖重装、预览重启后，typecheck/339测试/lint/完整构建再次通过。最终865份构建输入与源码一致，无未恢复删除，原主工作区与正式环境未受影响。之后构建必须复制源码并在隔离根安装依赖，不复用指向工作区的依赖/源码symlink，也不重跑该失败目录的Next清理。

## 剩余边界

这是桌面浏览器虚拟手机尺寸与本地API场景，未宣称真实WebView、第三方收银台、支付回调、真实扣费或相册验收。用户随后已明确授权上线，且要求不带其他人的dev；按下述正式版隔离发布记录执行。保留已开通会员态供查看。页面中账户、余额、有效期来自fixture，不是真实用户状态。

## 证据截图

- profile-vip-active-mobile.png：已开通我的页
- vip-active-benefits-mobile.png：已开通会员中心
- vip-monthly-benefits-mobile.png：未开通首屏，早期预览截图；价格/渠道曾为fixture，不作为最终线上配置证据

## 正式版隔离发布（用户追加授权）

- 基线为production main `ac48ab6a61cc67fb0b84ee36ccd720d4c855a4dc`，独立分支`release/profile-vip-experience`。
- dev `03ee7b6ec874d20f4d76e7113e903a34e4693b4b`中的性能提交不在发布分支祖先中；其后端、全局样式、Providers、消息/客服hooks、性能监控等均不带入。
- 仅将本任务dirty差异三方迁入main，自动保留main原有通知/客服hook调用；社区前台刷新以本任务内回调兼容main既有单参数hook，不修改其他hook接口。
- 按用户授权提交本次页面/API缓存/专项测试及相关规范文档，保持dev和其他开发分支不变。迁移后的检查结果另补。

- main基线迁移后：前端48文件336测试通过（原dev基线339含3条未发布性能测试，已随其提交一起排除）、typecheck/lint/build通过；5条既存img警告未扩大。
- 最终补充VIP订单完成时invalidate签到query，避免开通后短时间继续显示旧的签到加成；既有订单/支付实现不变。
