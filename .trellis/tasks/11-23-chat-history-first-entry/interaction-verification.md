# 交互补齐验证记录（2026-11-23）

用户确认“模型和设置正常用户还没保存使用旧的配置是没有问题的”。本次据此只保护实际在途的保存请求，未提交草稿、未就绪目录、偏好GET均不阻塞普通对话。不新增聚合接口或修改Backend/SQL/共享HTTP DTO。

## 自动化结果

| 检查                             | 结果                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------- |
| Frontend全量Vitest，maxWorkers=2 | 81文件、963项通过；在4个既有文件扩展21项，无新测试文件                                      |
| 最终重点回归                     | models/generation-config/use-conversation-turn/chat-generation-settings共4文件101项通过     |
| Frontend typecheck               | 通过；已为目录query显式声明GetModelCatalogData，避免带signal后placeholderData的重载推断歧义 |
| Frontend lint                    | 通过，仅既有无关img提示                                                                     |
| import边界                       | 使用参数数组执行仓库ESLint等价命令，通过；无跨应用导入                                      |
| 复杂度检查                       | 通过，仅收紧聊天页面基线，无新增豁免                                                        |
| 生产构建                         | 通过；最终构建包含目录取消保护，20个静态页面生成完成                                        |

SSR静态组件测试在Node中执行renderToStaticMarkup，Vitest启用oxc自动JSX运行时以处理Next的jsx:preserve；未启动DOM、浏览器、Playwright、预览或本地UI服务器。该检查不等于真实UI验收。

## 覆盖与修正

- 实际QueryClient/MutationObserver验证提交后保护、成功后展示模型、失败不自动重发、多个模型入口写入串行，以及不相关mutation不影响发送。
- 轻量hook运行器验证未加载目录/偏好仍可发送；渲染后才开始保存的快速send/regenerate被同步保护；同一状态也供choice和清空草稿前检查。
- 语音验证显式点击仅放行读取、GET失败仅重试GET、读取重试明确禁用cancelRefetch以复用在途GET、已有音频在配置刷新时保留、生成连点不重复、切换会话不复用旧操作/显示迟到错误。
- SSR断言deferred/loading/error均无“生成语音”入口；已知空记录才允许生成；加载配置失败不影响已有音频播放，重生成保持不可用。
- 取消目录请求后，即便底层迟到返回也不覆盖last-good及已确认模型；API请求带signal并有总期限。
- 新增单测最初复用了旧stream mock的未完成Promise而超时，已在该测试组单独重置mock，既有测试不变；TSX最初未被Node测试转换，已用Vitest的oxc自动运行时解决。均非通过放宽断言或增加超时绕过。
- 未修改生产配置、环境文件或数据库；测试均使用假API/内存状态，没有调用真实模型或发起付费生成。

## 日志与限制

复用Frontend api.terminal及Backend原HTTP日志和request/trace关联；本地保存中保护展示正常status，不当作服务器错误、不伪造请求。新状态仅从既有query/mutation推导，无新日志存储、监控高基数标签或告警通知。

保存失败响应不证明服务器回滚；模型使用原GET校准，设置的本地回滚只恢复展示，实际发送继续由Backend读取已保存事实。付费POST不自动重发。跨设备更改仍由服务端事实决定，本次不引入跨设备锁或新协议。

真实Telegram键盘/触屏及完整UI场景按用户要求未执行；线上48小时Android/iOS页面与API P95未取新样本，不能宣称已改善。原任务T3恢复容量、GET解耦和精确PT409根因门禁继续保留。

后续建议复用packages/ui-tests的@chat扩展模型读取失败/重试、保存期间发送与草稿保留、语音读取失败/重试/切会话及已有音频播放。本轮不启动该系统。
