# 技术设计

## 复用调研

- 组件：保留VideoPlazaConfigEditor受控value/onChange/disabled；参照ImagePlazaConfigEditors与ImagePlazaPricingEditor补视频交互，不添加请求逻辑。
- helpers：复用admin/lib/imagePlazaPricing.ts的BigInt四位小数精确乘积及向上补整十；视频增加最终1,000,000上限检查。
- contracts：复用shared/api/image-plaza.ts的参数schema/默认规则；在video-plaza.ts兼容增加可选pricing_factors，不扩展公开用户模型。
- hooks/状态：已有Admin父层拥有草稿，纯计算无需新增hooks/store或第二状态源。
- admin-client：复用configSchemas.ts注册、videoPlazaConfig.ts选项规范化及adminApi.ts草稿/发布/历史调用；核验CLI通用config命令保留新字段，不新建专用命令。
- features/repositories：无新实体，不新增repository；Backend仍由platform/runtime-config.ts读取目录并按price_matrix报价。
- 数据库函数：仓库内20261118_media_plaza_video_production_config.sql及旧video_config的validator校验模型/矩阵，不拒绝目录附加参考属性；本次无需新函数或migration，不修改历史SQL。不据此推断生产实况。

## 最小充分方案与数据流

视频编辑器→VideoPlazaModelCatalog→既有managed config解析/draft RPC→release/runtime_config；用户仅消费原price_matrix。

视频目录独立pricing_factors={exchange,markup,ratio}。缺省展示图片初始规则7.3/2/100并提示未保存；截图2.5为可配置示例，不硬编码覆盖。有效编辑或重算时保存参数。

standard_prices沿用已有可选字典，key=JSON.stringify([modelId,matrixKey])，matrixKey保留原分辨率大小写及音频位。无标准价不反推。单档只改目标；批量先完整验证再一次onChange，含下架模型。输入及参数仅影响预览；重算显式覆盖手工草稿价。

新增视频定价helper及独立组件，复用图片计算核心；只抽有真实双消费者的纯职责，不引入依赖、通用定价框架、API、数据库对象或自动报价任务。遵守500行/120行预算。

实现核验：image-plaza.ts 已依赖 video-plaza.ts，因此将现有定价参数schema与默认值原样移入无依赖业务模块的 `api/plaza-pricing.ts`，图片原出口继续重导出，视频直接导入，避免循环初始化。公开名称不变。

## 可靠性

- 空、非正、非有限、超过四位小数、输入超界、结果超界拒绝；参数无效不写入父目录，避免safeParse回退丢草稿。批量全有或全无。
- 并发/事务/幂等：本地计算无副作用；写入复用原草稿/发布及冲突反馈，不增加提交或重试。
- 超时/有限重试/退避/限流：无新增外部请求；沿用既有管理transport及代理30秒超时，禁止写入盲重试。
- 降级/补偿：旧目录可读且不自动改价；保存失败保留输入，未知结果读取权威值后再处理。
- 容量：最多30模型及既有档位约束下同步计算，不逐档请求、不加数据库写次数。
- 观测：本地非法输入以UI提示；保存/发布复用既有HTTP/observed fetch终态与admin审计，不记录配置正文或token；完整声明见task.json。

## 数据落位与兼容

复用image_plaza_video_model_catalog对象，不新增散装key。参考标准价/因子为C配置，由admin发布RPC写admin.config_drafts/config_releases及app_core.runtime_config，与目录同生命周期、沿用既有历史保留；不进入用户扣费输入，不复制业务价格快照、不新增跨域引用。已读CONTRACT及registry相关active条目；无新表/列/JSON列、无需迁移。

发布顺序：兼容shared/admin-client/CLI→Admin。TEST先验证保存重开，生产发布仍需AGENTS规定的单次diff授权。旧Admin保存可能剥离新可选字段，避免新旧版本交错编辑。发生字段丢失、默认回退或错误价则停止发布，回退UI或用现有目录历史恢复/forward-fix；不回改历史账单。

## Android/iOS性能

仅Admin本地计算及可选运营参考字段，不改移动页面、请求次数、生成/报价算法。Android/iOS页面和接口P95均不适用，无基线样本不填零；所有消费者检查和构建验证兼容，上线后核对Admin交互及原矩阵读取语义。
