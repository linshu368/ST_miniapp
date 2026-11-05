# iPhone production 短剧采样设计

用户于2026-11-05批准实现；本地工具与账号定向代码已完成，未发布定向后端，未完成真机预演。手机联动由用户在另一窗口处理，本轮不继续操作设备。

## 唯一主路径

Mac沿用已有miniapp-ios-setup的Node/Appium/XCUITest/WDA；独立脚本使用Node内置fetch调用W3C，无新增npm依赖。NATIVE_APP原生触摸，native XML优先、本机Swift Vision OCR补充。网页ARIA是否暴露需实际校准；无法识别标题/集号/时长/时间递增则停止。不是WebView DOM自动化。

流程为：核验当前实验完整30条 → 手动登录指定账号 → inspect/calibrate → 无触摸plan → 两条预演 → 30条运行 → 既有Grafana核对真实终态。客户端账号group字段不能改变服务器来源。

## 已核对入口和单集资格

当前本地导航：放映/watch、剧场/dramas。精选/全部/空搜索保留后端30条同序置顶，最新/搜索/分类有自己的排序，必须寻找冻结的相同视频，不能各取前30条。

覆盖catalog、latest、category、search、feed、full、detail-next、feed-episode。移除所有追剧/收藏/最近看过/接着看路径。分类缺失以及详情下一部的首条记not_applicable，不拿片单外视频补数。放映上下滑换剧；详情上下滑换本剧集数，不以此扩充AB样本。选集点当前集不新建起播，因此只用放映选集进入详情路径。

片单必须匹配实际videoId，不只认dramaId。30条生产ID已读live配置并与本地素材准备记录对应，标题/时长匹配30/30；归档source episode全为null，UI序号由播放排序生成，导入显式设置第1集为候选并保留sourceEpisode，每项仍须实际UI核验。

## 动作、等待与结果

单击画面显隐控件，双击播放/暂停；快进使用进度条水平拖动，不能先暂停或用倍速代替。每条等待时间连续前进两次，之后2秒，一次拖到70%，目标须向前且距结尾至少10秒；等目标后时间继续前进，播放3秒，回约1秒离开，间隔5秒。每30条/入口批次在非播放页休60秒。起播最多60秒，seek恢复65秒；3/5秒是阈值，不提前切断长尾。

seek buffered资格仅由现有埋点确认。目标70%不保证未缓冲；只有wasPlaying=true、direction=forward、buffered=no的候选属于目标分布。UI完成/seeked/无加载圈不是成功性能证据。正常与失败终态、回退、缺终态均保留，network/slow不重复计数。清理向后seek与前置播放分别记时间窗；多个UI入口共享cover/direct标签，不能称按本地runId精确过滤。

## 可靠性与最小实现

每设备串行锁、原子断点、限定轮次/运行时长/日志/截图上限。外部Appium读写均有超时；不确定触摸不盲重发。CtrlC取消等待并阻止后续触摸，finally释放会话且不删除Telegram登录/数据。普通失败有限恢复，连续3项定位/播放失败停止；前台变化、弹窗或断连停止。seek后复位未确认不得继续，恢复前需人工复位并显式ack-reset。坐标必须由实际原生轨道或该播放布局的校准产生，Retina截图换算成XCTest点。

复用现有DramaLink/DramaHome/DramaPlayer/EpisodeSheet手势、drama-seek性能owner和Grafana；不建新采集系统、业务API、数据库对象、队列、迁移或通用框架。事务/服务端写补偿不适用，本地断点用原子替换。停止工具即停止操作，无应用回滚。

## 两个指定账号

production已核验：Stream开启、Bunny关闭、enrollment=10000，实验为drama-stream-prod-20261104-v1。两账号实际Telegram ID仅留本机600权限配置，不提交。自然分桶：指定A为Supabase，指定B也为Supabase，故B当前尚不是Cloudflare。

本地后端新增可选DRAMA_STREAM_SAMPLING_COHORT，严格包含experimentId、supabase、stream，两个不同安全正整数Telegram ID；只在当前实验匹配时覆盖这两账号，其他用户HMAC与匿名实验用户标识不变。不绕过开关、入组比例或实际单集白名单，原delivery契约和回退归属不变。坏配置忽略以保普通实验，启用前CLI需核验精确提案。观察窗口固定映射，迟到事件仍读该映射；移除覆盖后另开窗口。

不能更换全体实验密钥/ID来给两号配组。发布顺序：审核本地代码与提案 → 从main隔离发布定向支持 → 核对部署版本 → 注入仅两账号配置 → 实际播放核对来源。异常移除定向恢复自然hash；保留观察窗口边界。当前未commit/push/部署/写生产变量。

## 验证与剩余门槛

已有stream.test.ts扩展隔离、坏配置、关闭、0入组、Bunny互斥及迟到身份，不新增测试文件。Backend完整119文件1328项测试、类型与复杂度通过。独立工具语法、Shell、Swift编译、无网络解析/计划/停止检查；这些不代替真实HLS或iPhone验收。手机未就绪时run门禁应拒绝。

真实验收仍需：手机/WDA可用、部署/当前账号/实际集号核验、feed/detail校准、每组两条预演及30条运行，读取已有Grafana两项终态。重复播放保留缓存条件，两个账号大量重播不等于大量独立用户，不能据此宣称总体P95改善。

暂缓自动换号、Grafana自动补跑与新埋点关联。建议真实流程与已有@drama本地模拟验收并列，真实付费媒体不接默认CI。
