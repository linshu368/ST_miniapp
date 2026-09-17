# CS Platform UI、状态与可访问性

- 保持三栏信息架构和运营人员熟悉的流程，重大改变需 PRD 与人工回归。
- server state 放 Query；token、选中项、Modal 和输入草稿放局部 state；派生筛选结果不复制为第二份可变 state。
- `styles.css` 使用语义类/CSS variables，新增样式同时检查窄屏、长文本、滚动区和中文换行。
- button/input/dialog 必须可键盘操作，有可访问名称、label、焦点管理；状态不可只靠颜色表达。
- 消息列表更新不应抢走用户焦点或无条件滚到底；发送后可按明确规则滚动。
- 复用以稳定行为为依据；小型显式组件优于高度参数化“万能面板”。不得仅为少写代码引入新 UI/state 库。
