> **已暂停（2026-11-11，范围已澄清）**：后续开发不强制执行本地性能测试；此前已有规划与质量门禁不变。仅暂停本任务新增采样/结果门禁，下文为待重新研究的历史方案。

# 执行计划

状态：用户已批准并 start；采样器和本地/CI 门禁已实施，正在验证。用户已执行 TEST 迁移，严格 TLS 与结构预检复核通过，实际双引擎批次因大厅预热连续失败安全停止，清理完成，正式样本为0。当前等待固定网络口径并重测；工具验证不代表性能达标。

## 阶段与修改范围

1. **合同和门禁模型**：扩展mobile_performance_gate及task_store默认声明；抽取小型结果/证据验证模块，保持单文件/函数预算。明确schema版本、nearest-rank、状态、指纹和人工确认来源。先扩展既有 `.trellis/tests/test_mobile_performance_gate.py`，必要时拆专用证据测试（本规划明确授权这些安全/流程回归）。
2. **环境与采样入口**：ui-tests新增独立perf config、runner、场景注册和TEST fixture生命周期；复用既有启动/宿主能力。Frontend只为独立生产构建输出及必要只读计时observer改动，Backend只补实际缺失的受控TEST注入边界；不扩公开业务API。
3. **页面/API计时与证据**：同浏览器时钟、20次固定计划、body与重试完整计时、双引擎独立组、脱敏样本及JSON/HTML报告；失效/清理/恢复路径先验证，再访问共享TEST。
4. **试点场景**：大厅和聊天普通/长历史、首次/深页；一次访问可贡献多个不同指标，但同一组不重复计数。复用已有UI断言保证内容/草稿/滚动及功能正确。
5. **实际TEST验收**：核对目标、结构、权限、版本、资源窗口和专用数据；现有聊天迁移若缺失走workflow逐文件执行，不能自动跑本地SQL。每组Android/Chromium和iOS/WebKit≥20，生成可复算报告；不达标修复重跑或取得精确人工豁免。
6. **完成/归档门禁**：Phase2/3验证、cmd_archive最前检查、archive_stale绕过修复；保持finish清指针语义。拒绝时验证所有状态与文件无变更。
7. **CI和文档**：新增无TEST秘密的Performance Gate检查，核对scope/内容指纹/脱敏样本与豁免来源；可信手动运行才可持有TEST凭证。分支保护实际设置单列发布步骤。同步AGENTS/workflow、ui-tests README、架构/环境及相应module知识载荷，保留原聊天任务未完成项。

## 已实现命令

```text
pnpm perf:mobile:plan --task <task>
pnpm perf:mobile:run --task <task>
pnpm perf:mobile:verify --task <task>
pnpm perf:mobile:report --task <task>
```

plan输出完整组矩阵、预计请求/数据/时间上限及缺口；run必须显式读取并验证方案，不暗中改阈值；verify无需数据库凭证，重算当前证据；report仅呈现结果，不改变decision。

## 可执行既有验证

```text
python -m unittest discover -s .trellis/tests -p test_mobile_performance_gate.py
python -m unittest discover -s .trellis/tests -p test_trellis_git_safety.py
python -m unittest discover -s .trellis/tests
pnpm --filter @miniapp/ui-tests typecheck
pnpm --filter @miniapp/frontend test
pnpm --filter @miniapp/backend test
pnpm --filter @miniapp/shared test
pnpm -r typecheck
pnpm -r --if-present build
pnpm lint:complexity
pnpm lint:migrations
pnpm test:ui --grep '@chat|@roleplay'
```

新增TS采样/统计测试按ui-tests既有node/tsx工具选最小入口，不为机制引入第二测试框架；具体命令随实现登记。只读文档阶段不跑真实库integration或20次远端采样。

## 必须锁定的失败路径

- 阈值精度、19/20、nearest-rank、NaN/Infinity/负数、同一sample重复、缺平台、混场景、空响应/只收到headers。
- 应用内部重试计总耗时、控制器不重发POST、20次尝试中失败不可删除、缓存未请求不可补0、断点恢复不可跨版本拼样本。
- TEST/prod混配、TLS关闭、mock/dev构建、凭证/迁移缺失、CI拿不到样本、后台进程或锁残留。
- 脱敏摘要与原始样本不一致、内容指纹变化、过期/撤回/伪造豁免、只有名字无确认来源、人工确认发生在报告之前。
- start未声明拒绝且指针不变；archive性能失败不写module/status/日期/目录；stale与直接状态修改不能在CI绕过。
- 测试数据创建半途失败、清理失败和重试、只清本次run、预算到限、共享TEST其他运行冲突。
- 真实browser消费检查：Android和iOS引擎分别运行；新页面未登记ready、API未登记metric时fail closed。

## 人工验收与恢复

工程师查看失败组和源样本，确认真实内容、阅读位置和草稿；若明确豁免，逐组记录可核验的原话/来源、风险和跟进，不自动勾选批准。报告与代码必须匹配。

工具异常停止采集，保留incomplete及创建清单；只结束自身进程、只清本次测试数据。不关闭全局gate伪装通过；采样器回退后仍执行人工性能检查。无生产部署/真机证据时如实记录，不用模拟成绩替代。
