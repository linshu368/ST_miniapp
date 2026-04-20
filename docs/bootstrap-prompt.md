# 新会话前置 Prompt（一键复制）

> PM 每次开新会话时，把下面代码块里的内容作为第一条消息发给 AI，即可完成上下文对齐。

---

```
读 ST_miniapp/AGENTS.md，按里面的「新会话 Bootstrap 协议」执行，然后等我下任务。
```

---

## 就这样？对，就这样。

所有规则、必读清单、回复模板都写在 `ST_miniapp/AGENTS.md` 的「新会话 Bootstrap 协议」一节里。
prompt 只负责"指路"，具体要求由 md 文件做**单一真相源**——以后要调整规则，只改 md，不用改 prompt。
