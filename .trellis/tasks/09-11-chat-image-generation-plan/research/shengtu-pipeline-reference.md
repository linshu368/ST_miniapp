# 生图流水线参考记录

## 来源

- `e:\飞书\生图流水线打包\shengtu_pipeline.py`
- `e:\飞书\生图流水线打包\视觉分镜师prompt.txt`

只记录可进入工程规划的流程和变量名。源 Python 文件包含本地默认 auth/token 示例，不能复制到源码、Markdown、日志或测试 fixture。

## 可采纳流程

1. 准备角色信息：根据当前会话的 `character_id` 读取 `app_core.characters`，必须包含 `character_persona_and_style` 和必要角色卡字段。
2. 默认路径写稿：使用“视觉分镜师”系统提示词，输入 `art_style`、`character_persona_and_style`、`recent_messages`，调用 DeepSeek 产出中文短文。
3. 自定义路径：用户输入/修改的中文短文不进入分镜师写稿，不补充、不润色。
4. 翻译阶段：无论默认还是自定义，送 Grok 生图前都调用 DeepSeek 将中文短文直译成英文提示词；翻译是内部 provider 输入，不替换用户看到的中文短文。
5. 生图阶段：使用 Grok，经 Liaobots OpenAI-compatible images endpoint 调用，返回 URL 后由 backend 下载、校验并上传 Supabase Storage。
6. 最终 provider prompt 可参考“角色锚点 + 英文场景 + 控制尾巴”的结构；具体美型基线需适配角色性别/物种/设定，不应直接把 Python 示例里的固定女性外貌词套给所有角色。

## 配置决策

- 写稿和翻译模型若与语音一致，复用现有 DeepSeek 配置：`DEEPSEEK_API_KEY`、`DEEPSEEK_URL`、`DEEPSEEK_MODEL`，默认模型仍为 `deepseek-v4-flash`。
- Grok/Liaobots 配置由 backend `platform/config.ts` 读取环境变量：`LIAOBOTS_AUTH`、`LIAOBOTS_BASE`、`GROK_MODEL`。
- `LIAOBOTS_AUTH` 是 secret，只能存在 backend 环境变量；`LIAOBOTS_BASE` 和 `GROK_MODEL` 可配置但不下发前端。
- Python 中的 Replicate/Z 降级链路不进入初版，除非后续单独评审；当前规划的图片 provider 只有 Grok。

## 约束

- 用户可见、前端编辑和 attempt 主输入都保持中文短文，长度仍为 1~200 字。
- 英文翻译 prompt、最终 provider prompt、Grok 原始 URL 不返回前端，不进入 info 日志。
- `character_persona_and_style` 为空时不能凭空造固定外貌锚点；实施需选择“该角色暂不可出图”或经评审的角色卡字段兜底策略。
- 健康向控制尾巴可进入 `image_prompt_policy` 或 backend prompt 常量，但不能悄悄覆盖用户中文短文的含义。
