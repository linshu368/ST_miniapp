# 官方接口核对（2026-10-23）

- https://openrouter.ai/docs/guides/best-practices/reasoning-tokens
- https://docs.venice.ai/guides/features/reasoning-models
- https://docs.venice.ai/api-reference/api-spec
- https://github.com/veniceai/skills/blob/main/skills/venice-chat/SKILL.md

OpenRouter开：reasoning:{enabled:true,exclude:false}；关：{enabled:false,exclude:true}。exclude只是去除返回，不代表停止计算。delta.reasoning或reasoning_details中的reasoning.text.text / reasoning.summary.summary可读；同chunk优先plain避免重复；encrypted.data/signature不能展示/解码。mandatory模型不能承诺关闭计算。

Venice开：reasoning:{enabled:true}，venice_parameters:{include_venice_system_prompt:false,disable_thinking:false,strip_thinking_response:false}；关：reasoning.enabled=false，兼容disable_thinking=true,strip_thinking_response=true。delta.reasoning_content为当前格式，兼容可读details与前导think标签。旧模型/强制思考能力遵循provider，不能承诺不计算/零reasoning费；不要统一发reasoning_effort:none。

思考token算输出，completion_tokens已经包含reasoning_tokens，不重复相加。本轮不更改收费公式。无工具循环，不持久化或回传reasoning_details，不能将展示文本代替加密签名。应用默认请求开启，不伪造思考或扩展完整模型目录。
