# 实现与验证

1. 已完成 `scripts/ios-drama-sampler/`：Node内置fetch调用W3C，原生XML+本机Vision OCR，入口操作、时间前进判定、一次拖动及清理。
2. 已完成本地配置/完整片单导入/无触摸计划、受控run、单设备锁、原子断点、恢复、中断、日志与README。不改MiniApp页面。
3. 已完成Backend可选DRAMA_STREAM_SAMPLING_COHORT，两账号定向与只读核验CLI，扩展已有stream.test.ts，不新建测试文件。
4. 已运行Backend完整119文件1328项测试、类型检查、stream与遥测专项、复杂度检查、工具语法/Swift编译/离线校验。后续review若改动再跑对应检查。
5. 待完成：后端定向发布与精确production配置、手机/WDA就绪、inspect/calibrate、每组两条及30条真实执行、已有Grafana有效样本核对。未经确认不提交/推送/发布。

不确定触摸不重发；后台/弹窗/断连停止，连续定位或播放失败3项停止。seek后复位未确认保留断点，恢复需先人工复位并ack-reset。准备/采样/清理分段记录，buffered不可本地判断。

无前端代码/契约/数据库变更，不跑模拟页面检查替代真机。必要回归扩展已有测试。工具纯JS用node --check，无npm依赖或新增构建链。建议真机流程与已有@drama本地验收并列，真实媒体不进默认CI。
