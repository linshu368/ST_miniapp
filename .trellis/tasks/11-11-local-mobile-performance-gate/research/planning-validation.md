> Historical planning/research record: the initial 200-sample policy below was superseded by the user on 2026-11-11. Current policy is local-mobile-p95-v2: 20 samples per platform/page/API/scenario, P95 <= 2000ms.

# 规划验证记录

日期：2026-11-11。范围仅本次规划、任务元数据及项目规范，不改变产品代码、数据库或运行时脚本。

## 已验证

- 用户两项明确答复已收敛到PRD：每平台/每页面或接口/每关键场景至少200样本，P95≤2秒，未达标须明确开发者豁免；Android/Chromium、iOS/WebKit本地模拟，报告标识模拟。
- prd/design/implement/task/research已存在，无TBD；需求、复用、可靠性、最小方案、演进恢复、失败验证、移动端P95声明均覆盖。
- `task.py validate`：implement.jsonl 7项、check.jsonl 3项路径有效。
- `module_knowledge.py check`：通过。当前只改规划和约束，无功能模块实现事实变更，mode为no_module_change；实施阶段需按实际范围更新。
- 直接调用现有mobile_performance声明validator：通过；未执行本任务start，status仍planning。
- `python -m unittest discover -s .trellis/tests -p test_mobile_performance_gate.py`：11项通过。
- `python -m unittest discover -s .trellis/tests -p test_trellis_git_safety.py`：4项通过。
- 新任务文档/JSON和规范guide的Prettier检查通过；git diff --check通过（仅既有CRLF提示）。

## 不可据此声称的结果

这些是规划结构和既有门禁回归，不证明拟新增200样本门禁已实现或产品性能已达标。本轮没有运行Chromium/WebKit的200次性能采样、TEST写入、远端迁移、生产部署、提交或归档。仅文档/元数据变更不重复运行产品build/typecheck；实施时执行implement.md的适用全套检查。

AGENTS、workflow、guides及前后端规范已要求后续任务遵守新规则，并明确自动化仍待实现；实现前人工验收也不得把未通过或缺失结果标为完成。原聊天任务仅增加新机制关联，原剩余硬门槛与完成后自动归档要求保留。
