# 最小设计与五项门禁

## 复用调研

复用 useVisualViewportHeight、ChatComposer/composer-layout、ChatReplyPreferences已有展开区、studio现有flex/滚动结构。优先把同一可视高度传入聊天输入和偏好；键盘尺寸变化重算textarea，不引入新状态管理。studio以现有底部输入区为边界约束高度并保留内部滚动与操作条。
复用 image-plaza.ts 查询hooks和images.ts既有queryFn缓存比较模式，在服务器新出现ready attempt时失效paymentKeys.wallet前缀；覆盖余额和消费子键。分享onSuccess同样失效。无额外全局集合。
复用 MiniappWalletRepository.listSpending 的图片账本查询，同时筛选image_generation/image_plaza_generation，继续按user_id过滤，沿用金额映射和排序。结算RPC不改，无数据库对象、迁移或补账。
复用现有composer-layout.test、image-plaza/media-cache.test、hooks.test和MiniappWalletRepository.test；计费回归应调用真实repository方法，内存query fixture验证过滤而非只测试手写映射。

## 可靠性

不改变外部调用、重试或支付写路径；生成请求不自动重发，保留原幂等及事务。pending/失败不触发成功余额刷新；缓存比较避免ready轮询重复刷新，页面卸载回来依旧比对缓存。已有失败提示和原图保存兜底保留。键盘预算同时约束偏好与输入，避免两者各占半屏；极低高度允许受限区域内部滚动。无新容量/限流/补偿机制，现有日志不变，未连接真实数据库。

## 最小充分方案

不新增依赖、公开API、数据库结构、通用键盘框架。不修未经实测确认的offsetTop/Portal问题，不扩大到PC或重写计费。只在可复现边界补纯helper/现有测试。

## 演进与恢复

当前main 3da99aed为基线，本地fix/mobile-virtual-qa分支。后端读取兼容旧流水；前端独立兼容现有DTO。无需迁移和发布顺序。每个领域可独立还原；若出现缓存风暴/输入裁切，停止交付，修正后复验。新增修复的上线在后续具体review完成后进行。

## 可验证性

执行受影响包typecheck、frontend tests/lint/build、backend钱包/影像相关tests、导入guard；测试中文组合输入、长文后只缩小可视高度、偏好滚动、参考图低高度、最长模型名/提交状态。虚拟账本含别的用户/无关类型/两种图片及语音并核金额排序；query fixtures验证pending→ready仅一次、失败不刷新、离页回来和分享。
CUA仅使用标准输入/点击/viewport，evaluate只读DOM；桌面缩窗结果只称压缩空间验收。真实visualViewport≠innerHeight边界用测试桩/纯计算验证，不谎称物理键盘。保存成功/不支持/拒绝以SDK mock验证，真实落盘待后续自然使用观察。

## 结算异常最小增补（虚拟验收发现）

实际repository/worker虚拟运行已确认：任意RPC error都会删刚存图片，未区分结算已提交但响应丢失；明确余额不足被当作正常返回并记录ready日志。最小扩展只在repository定义内部结算错误(code/outcomeUnknown)，worker识别并沿用既有markFailed状态守卫。RPC返回error、抛错或不能确认status时保留图片并标记unknown，不重试Provider/RPC；只有明确insufficient_balance删除新图并抛明确失败。markFailed只更新leased/generating/storing，无法覆盖事务已提交的ready。结算RPC/原子扣费/行锁不变，未知孤立图暂保留，避免误删已扣成果，不新增清理任务或readback框架。
基于计费与成果不可逆损失风险，允许新增必要repo/worker专项回归文件（若现有文件承载不合理），必须直接调用真实方法，以mock控制故障点；验证存图失败无结算、成功仅一次、响应未知保图、余额不足清理且非ready、已ready不被markFailed覆盖的现有状态守卫。无需真实DB/新API/迁移；独立规划复核后实施。
