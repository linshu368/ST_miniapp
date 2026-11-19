# 影像广场视频模型 · Venice 调用报价

采集时间：2026-11-19（Asia/Shanghai）  
来源：Venice `POST /api/v1/video/quote`（USD）  
模型清单：Admin 默认目录 `packages/admin-client/src/videoPlazaConfig.ts`（`image_plaza_video_model_catalog` 六模型）  
报价参数：`aspect_ratio=16:9`；可配音频模型分别询价 `audio=true/false`（本次结果相同）  
说明：此为 **Venice 上游调用价**，不是星尘 `price_matrix`；运营核价后再写入 `standard_prices`。

## 总表

| 模型（Admin）      | Venice model id（询价用）               |     时长 | 清晰度 | 音频   |                           Venice 报价 (USD) |
| ------------------ | --------------------------------------- | -------: | ------ | ------ | ------------------------------------------: |
| Wan 3.0 Pro        | `wan-3-0-pro-text-to-video`             |       5s | 1080p  | 开/关  |                                    **1.69** |
| Wan 3.0 Pro        | `wan-3-0-pro-text-to-video`             |      10s | 1080p  | 开/关  |                                    **3.38** |
| Wan 3.0 Reference  | `wan-3-0-reference-to-video`            |       5s | 720p   | 开/关  |                                    **0.65** |
| Wan 3.0 Reference  | `wan-3-0-reference-to-video`            |       5s | 1080p  | 开/关  |                                    **1.30** |
| Wan 3.0 Reference  | `wan-3-0-reference-to-video`            |      10s | 720p   | 开/关  |                                    **1.30** |
| Wan 3.0 Reference  | `wan-3-0-reference-to-video`            |      10s | 1080p  | 开/关  |                                    **2.60** |
| MiniMax H3 Max     | `minimax-h3-max-text-to-video`          |       5s | 1080P  | 固定开 |                                    **0.72** |
| MiniMax H3 Max     | `minimax-h3-max-text-to-video`          |      10s | 1080P  | 固定开 |                                    **1.44** |
| MiniMax H3 Max R2V | `minimax-h3-max-reference-to-video`     |       5s | 1080P  | 固定开 |                                    **0.96** |
| MiniMax H3 Max R2V | `minimax-h3-max-reference-to-video`     |      10s | 1080P  | 固定开 |                                    **1.92** |
| Seedance 1.5 Pro   | `seedance-1-5-pro-text-to-video-basic`  |       5s | 720p   | 开/关  |                                    **0.47** |
| Seedance 1.5 Pro   | `seedance-1-5-pro-text-to-video-basic`  |      10s | 720p   | 开/关  |                                    **0.95** |
| Seedance 1.5 Pro   | `seedance-1-5-pro-text-to-video-basic`  | 5s / 10s | 1080p  | —      | **不支持**（Venice 仅允许 `720p` / `480p`） |
| Seedance 2.0 R2V   | `seedance-2-0-reference-to-video-basic` |       5s | 720p   | 开/关  |                                    **0.95** |
| Seedance 2.0 R2V   | `seedance-2-0-reference-to-video-basic` |       5s | 1080p  | 开/关  |                                    **2.34** |
| Seedance 2.0 R2V   | `seedance-2-0-reference-to-video-basic` |      10s | 720p   | 开/关  |                                    **1.89** |
| Seedance 2.0 R2V   | `seedance-2-0-reference-to-video-basic` |      10s | 1080p  | 开/关  |                                    **4.68** |

## 按模型透视（时长 × 清晰度，USD）

### 1. Wan 3.0 Pro（仅 1080p；音频可配，价同）

| 时长 \\ 清晰度 | 1080p |
| -------------- | ----: |
| 5s             |  1.69 |
| 10s            |  3.38 |

同档 `wan-3-0-pro-image-to-video` 抽查 5s/1080p = 1.69（与 t2v 一致）。

### 2. Wan 3.0 Reference（720p / 1080p）

| 时长 \\ 清晰度 | 720p | 1080p |
| -------------- | ---: | ----: |
| 5s             | 0.65 |  1.30 |
| 10s            | 1.30 |  2.60 |

### 3. MiniMax H3 Max（仅 1080P；音频固定开）

| 时长 \\ 清晰度 | 1080P |
| -------------- | ----: |
| 5s             |  0.72 |
| 10s            |  1.44 |

同档 `minimax-h3-max-image-to-video` 抽查 5s/1080P = 0.72。

### 4. MiniMax H3 Max R2V（仅 1080P；音频固定开）

| 时长 \\ 清晰度 | 1080P |
| -------------- | ----: |
| 5s             |  0.96 |
| 10s            |  1.92 |

### 5. Seedance 1.5 Pro（Admin 目录含 720p/1080p）

| 时长 \\ 清晰度 | 720p |  1080p | 480p（Venice 额外支持，Admin 未列） |
| -------------- | ---: | -----: | ----------------------------------: |
| 5s             | 0.47 | 不支持 |                                0.22 |
| 10s            | 0.95 | 不支持 |                            （未询） |

### 6. Seedance 2.0 R2V（720p / 1080p）

| 时长 \\ 清晰度 | 720p | 1080p |
| -------------- | ---: | ----: |
| 5s             | 0.95 |  2.34 |
| 10s            | 1.89 |  4.68 |

## 备注

1. **音频**：可配音频模型本次 `audio=true/false` 报价相同；MiniMax 两款 Admin 为固定开音频。
2. **Seedance 1.5 Pro**：当前绑定的 Venice id `…-basic` **不接受 1080p**；若运营台仍展示 1080p 档，核价/发布前需改能力或换 provider id。
3. **线性关系**：多数档位 10s ≈ 2×5s（Seedance 2.0 R2V 720p：1.89 / 0.95 ≈ 1.99）。
4. 测试库 `app_core.runtime_config.image_plaza_video_model_catalog` 当前 `standard_prices` 为空；上表仅上游报价，未换算星尘。
