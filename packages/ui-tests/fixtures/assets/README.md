# 本地短剧演示素材

`drama-preview.mp4` 来自 MDN Interactive Examples 的 CC0 视频示例：

https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4

仅用于本地验证视频解码、播放、拖动进度与换集，所有示例集数复用这段花卉视频。目录标题和封面均为虚构占位，不代表线上短剧内容。运行时只读取本地文件，不访问外部媒体服务。

`mujian-hls/` 是本目录已有 `drama-preview.mp4` 的本地 fMP4 HLS 转封装，使用 `ffmpeg -c copy -hls_segment_type fmp4 -hls_time 2 -hls_list_size 0` 生成；仅作播放器兼容测试，不是真实短剧或 Cloudflare 返回值。
