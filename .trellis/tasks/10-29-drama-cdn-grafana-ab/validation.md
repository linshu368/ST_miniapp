# 验证记录

## 已执行

- 前端全量单测：63个文件、663项通过。
- 最后一次预算属性投影调整后的相关回归：3个文件、116项通过。
- Frontend typecheck通过；早期失败是新增测试fixture缺少必需meta，已修复后通过，没有放宽类型或增加any。最后一次并行typecheck/build遇到.next生成类型竞态，build完成后已串行typecheck通过；后续不将这两个命令并行运行。
- Frontend production build通过；仅既有未改动图片组件的next/image提示与Browserslist数据过期提示。
- Frontend lint通过，8处既有next/image警告位于未改动文件。
- 11条新增CDN查询在Grafana Cloud Loki上使用隔离无样本TEST筛选进行只读语法/空数据验证，均无错误、返回空，不把它解释为新字段已上线或真实指标成功。
- Prettier涉及产品/说明/spec文件通过；task context与module-updates校验通过。
- JSON结构比对：源码原有19个面板及全部原有变量逐对象不变；新增200–208号面板无冲突。
- 再读线上UID已有24个面板，末尾y=146；离线dashboard-operations.json仅11次append（2变量+9面板），已将新区域移到146后，不覆盖线上首张画面区域。正式发布前仍须重新核对当前版本/ID/布局。

## 本地真实链路

首次Faro→Alloy→Loki脚本运行在冷下载grafana/loki:3.5.0时触发既有60秒子进程预算；不是LogQL断言失败。随后先独立准备固定版本镜像，不提高脚本超时或更改固定依赖版本。缓存源Loki manifest digest为sha256:4c431d2e6b9b38718694b31c5d56be7c80dc69c513215fde1aeb5b02cd4e2665，Alloy为sha256:9726bfba078de9bc2212c60c6e643238c700b4fe0868ea78cbe03163d03d95bf，仅补本机固定标签。镜像缓存源准备完成后，本地真实链路通过：83条查询执行成功，覆盖本次11条CDN查询与既有面板。Bunny达标率1/2、有效分母6；Supabase达标率1/3、有效分母3；成功N为4/2，P95为5000.085/9550ms；卡顿比为2/31和1/2，窗口N为3/1；空桶无数据、全失败已观测桶为真实0、未知样本与disabled回退断言均通过。测试使用固定虚构数据，不代表生产结果。

## 证据边界与后续

当前只交付本地候选；尚未提交、推送、部署应用或写入线上看板。新字段必须随Frontend实际发布才能收到，历史没有cdn\_\*不回填。TEST真实浏览器摄取、Telegram iOS/Android与上线后新版本两桶样本需分别验收。

没有新增测试文件，复用既有grafana/observer/media与合成脚本；没有shared合同、Backend、数据库、配置或播放业务改动。

实际链路执行中补齐既有验算器的日志查询range端点和doublequote变量替换，错误正文先检查HTTP状态，避免把文本错误误当JSON；修正均限于现有本地验证脚本，不涉及产品采集/看板原查询。
