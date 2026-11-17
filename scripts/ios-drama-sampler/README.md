# iPhone 短剧生产采样工具

Mac + Appium + XCUITest 原生触摸。依赖安装包已有 Node，不增加 npm 包；本机 Vision OCR 由 Xcode 的 Swift 编译。支持剧场精选、最新、分类、搜索、放映滑动、观看完整短剧、详情下一部、放映选集。**不包含追剧、自动换号或 Grafana 查询。**

工具判断何时操作；真实起播耗时、未缓冲快进资格及恢复耗时继续由既有遥测判断。`ui_completed` 只表示界面流程完成，不能当成性能成功。客户端配置里的 group 只是已核验结果，不能改变服务端分组。

## 准备

1. 完成 `miniapp-ios-setup` 中的 iPhone 配对、开发者模式、WDA 签名和 `Product → Test`。用该包的 `04-start-server.command` 启动本机 Appium。
2. iPhone 保持竖屏、解锁、Telegram 前台，手动打开 production Mini App。不要在采样时切换其他应用。WDA 标识、UDID只保存在本机配置。
3. 准备 production 实验的完整30条清单，确认实际部署版本、实验ID、A/B账号。两个账号各自手动登录、分别运行相同参数。

下文从仓库根目录运行；也可以直接 `node scripts/ios-drama-sampler/cli.mjs ...`。`run.command` 默认复用 `$HOME/Downloads/miniapp-ios-setup`。安装包在别处时设置 `MINIAPP_IOS_SETUP_ROOT`。

```bash
bash scripts/ios-drama-sampler/run.command init --udid DEVICE_UDID --wda YOUR_WDA_BUNDLE_ID
```

配置默认写到 `~/.config/miniapp-ios-sampler/config.json`。如果同目录已有主代理生成的 `device.json`，`init` 会读取 `udid`、`updatedWDABundleId`，可省略这两个参数。其他命令用 `--config /absolute/path/config.json` 指定配置。

## 导入实验片单和分组

片单格式：

```json
{
  "environment": "production",
  "experimentId": "THE_CURRENT_EXPERIMENT",
  "verified": true,
  "videos": [
    {
      "index": 1,
      "title": "剧名",
      "dramaId": "DRAMA_ID",
      "videoId": "VIDEO_ID",
      "episode": 1,
      "duration": 180
    }
  ]
}
```

实际必须完整30条，dramaId、videoId均唯一，按实验置顶顺序排列。`episode` 是 UI 第几集，不是归档源的 episode 字段；源字段为 null 时，可经确认指定默认第1集。导入会保留 `sourceEpisode`；每次运行仍从手机检查实际剧名、集号和时长。分类入口需要条目的 `category` 字段，例如 `"category": "悬疑"`；缺失分类时记录 `not_applicable`，不补片外素材。显示名截断或重名时可增加唯一的 `uiTitle`，但必须在实际 UI 上验证。

```bash
bash scripts/ios-drama-sampler/run.command import-manifest --file /absolute/path/source-manifest.json --output manifest.normalized.json --episode 1 --verified
bash scripts/ios-drama-sampler/run.command configure --release DEPLOYED_SHA --account account-a --group supabase --verified-experiment THE_CURRENT_EXPERIMENT
```

`--verified` 只在片单身份和顺序已被核验后使用；`--verified-experiment` 只在当前登录账号的服务端分组已被核验后使用。B组填 `--group stream`。如两号自然分桶同组，须先由已批准的服务器定向实现处理，本工具不会通过更换实验密钥来重分所有用户。

## 只读校准

```bash
bash scripts/ios-drama-sampler/run.command compile-ocr
bash scripts/ios-drama-sampler/run.command inspect
```

`inspect`/`capture` 创建一次 Appium 会话，读取 native XML 和截图，输出本机私有目录及 XCTest 屏幕尺寸。它不发送触摸，也不启动/关闭 Telegram；会话退出保留登录。原始截图/XML可能包含账号或页面信息，仅本机保存，不提交 Git。

在手机手动打开片单第1条目标集并开始播放，保持控件可见。根据截图和输出的 `screenPoints`，选播放器空白位置，以及进度轨道左右端与中心y坐标。截图可能是 Retina 像素，所有参数必须换算为 XCTest 点坐标。

```bash
bash scripts/ios-drama-sampler/run.command calibrate --video 1 --layout detail --blank X,Y --progress LEFT,Y,RIGHT
```

上面只读取并显示结果，不发送触摸。确认坐标后，同样命令加 `--confirm` 保存。放映与详情的进度条位置不同，需分别在对应页面用 `--layout feed` 和 `--layout detail` 校准，工具保存各自轨道；每次拖动优先采用当前原生“播放进度”的边界，没有原生轨道时才用该布局的校准值，缺失则停止。若 native 可访问性暴露完整轨道，`--progress` 可省略；空白点仍需指定。校准要求手动显示控件，并读到剧名、目标集号、时长及连续播放时间。读不到时停下来检查截图和元素，不退化为固定等秒盲跑。

```bash
bash scripts/ios-drama-sampler/run.command calibrate --video 1 --layout detail --blank X,Y --progress LEFT,Y,RIGHT --confirm
# 手动进入放映页并显示控件后，另存该页面的轨道：
bash scripts/ios-drama-sampler/run.command calibrate --video 1 --layout feed --blank X,Y --progress LEFT,Y,RIGHT --confirm
bash scripts/ios-drama-sampler/run.command check
bash scripts/ios-drama-sampler/run.command plan --entries catalog --limit 2
```

`check` 只校验本机配置，`plan` 不连接手机、不发触摸。`plan` 可显示完整30条候选片单（包括待核验集号），并分别输出 `manifestVerified`、`groupVerified`、`calibrationVerified` 与是否记录部署版本；未核验的目标group不能视为服务端实际组别。`run` 始终要求完整已核验片单及实际集号。`--limit 2` 只缩小执行数量。更换账号别名、group或实验ID会自动撤销旧分组核验，重新核验后再用 `--verified-experiment` 确认。

## 小批预演与正式执行

先运行两条精选封面路径：

```bash
bash scripts/ios-drama-sampler/run.command run --entries catalog --limit 2
```

确认没有点错、换错集、暂停或误滑，并在已有 Grafana 中核对两项真实终态，再逐入口扩到30条：

```bash
bash scripts/ios-drama-sampler/run.command run --entries catalog,feed,full,search,detail-next,feed-episode,latest,category --rounds 1
```

每入口按片单1→30执行；分类缺失、详情下一部的第1条等不可适用项会注明原因。放映起始位置需在冻结的30部中；工具核对标题后按索引向上/下滑到目标，未知片目会停止。详情页上下滑会换集，因此不使用该手势扩充白名单之外的样本。

每条：时间连续前进 → 正常播放2秒 → 一次水平拖到70% → 等目标位置继续播放 → 播放3秒 → 回约1秒并离开 → 等5秒。目标须向前且离末尾至少10秒；无空间则记录，不伪造快进。每个入口批次结束，在非播放页休息60秒。起播观察最多60秒，快进恢复最多65秒；3秒/5秒阈值不会提前终止长尾。速度能读到时归一到1倍。

当前默认 `maxHours=4`、最多100轮；建议先1轮，按结果决定后续。两组必须使用相同参数、同网络与相同静音策略。首次与重复播放存在缓存差异，不能把重播称为冷缓存。

## 停止、断点和证据

- Control+C 取消等待并停止后续触摸，保留已在执行的命令结果不确定性，保存断点并释放会话。失败触摸不自动重发；设备断连、前台变化、系统弹窗立即停止。
- 普通视频错误记录后仅做一次页面恢复并继续；连续3项定位/播放无法确认则停止。
- 采样、inspect、calibrate 共用同一设备锁，配置不同输出目录也不会绕过。异常退出留下锁时，先核对PID确已退出，再手动移除对应 `~/.config/miniapp-ios-sampler/locks/device-*.lock`，不要删除其他设备的锁。
- `run ... --resume` 必须保持相同配置、入口、limit和rounds；中断项重新执行并注明 interrupted，不会冒充原样本成功。快进后未确认复位时会阻断，先人工复位后加 `--ack-reset`；不会重试未确认的快进。
- 每次输出到配置目录的 `runs/<runId>/actions.jsonl`，日志最多64MiB、失败截图每次最多20份；清理旧运行由操作者决定。截图和OCR中间文件仅本机保存。
- 日志分为 prepare / sample / cleanup；清理的向后seek不进入未缓冲向前指标。准备播放仍可能生成遥测，需要用时间窗区分。
- 脚本不测/不输出性能P95、不推断buffered，也不获取签名媒体URL。现有看板多个入口共享cover/direct标签，不能宣称按本地runId精确关联。

当前实现的本机语法/编译/离线检查不能代替真实 iPhone、真实HLS与生产遥测验收。线上布局、Telegram或屏幕尺寸变化后重新 inspect/calibrate。
