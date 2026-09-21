# Batch Lab Postprocessing Results And Export

## Processor

Processor config 目前支持：

- `none_v1`：保留原始输出。
- `regex_json_v1`：按配置的 regex rules 抽取展示字段。

Processor preview 必须只引用一种来源：已有 `processor_version_id` 或 inline config。配置保存后产生版本事实，实验记录引用具体版本，避免历史结果被后续编辑改变。

## 展示结果与复用

Display result 是分析产物，不是生成上下文。reuse-display 实验必须显式标记 lineage：`source_experiment_id` 指向被复用展示结果，`generation_source_experiment_id` 指向产生原始生成的实验。reuse-display 不创建 generation attempts，不重新调用模型，计划模型调用数为 0。

Copy 实验复制冻结样本和 variants 形成新的草稿；它用于继续实验配置，不改变原实验事实。

## Annotation

Annotation 是轻量备注，按 experiment/sample/turn 定位。备注用于分析和 JSONL 导出，不参与生成、processor 或真实会话写入。

## JSONL Export

导出格式由 `BATCH_LAB_JSONL_SCHEMA_VERSION` 管理。每行代表一个冻结样本，包含：

- experiment lineage 和 source environment。
- sample snapshot。
- A/B attempts 的 status、error、raw output 和 display result。
- annotation。

导出只能读取 `batch_lab` 冻结事实，不重新查询来源库。响应使用 `application/x-ndjson` 并以附件下载；失败、blocked、unknown 和部分成功必须出现在 JSONL 中。
