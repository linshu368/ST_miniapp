# SAAS_CHANGES.md

ST_miniapp 对 SillyTavern 原生文件的所有改动记录。
**每次改动必须在此追加**，包含：改动位置、原因、上游升级注意事项。

---

## 改动清单

### [C001] 关闭 CSRF 保护

**日期**：2026-06-06
**文件**：`SillyTavern-latest/config.yaml`
**改动**：

```yaml
# 改前
disableCsrfProtection: false

# 改后
disableCsrfProtection: true
```

**原因**：
Bridge（backend）和 sync-engine 需要以服务端身份调用 ST 的 HTTP API
（`POST /api/users/login`、`POST /api/users/create` 等）。
ST 的 CSRF 保护针对浏览器场景（防止第三方页面冒用 session），
对服务端内网调用无实际安全意义，且会造成所有 server-to-server 调用被 403 拒绝。

**安全影响评估**：

- ST 实例只绑定内网（`listen: false`，白名单仅 `127.0.0.1` / `::1`）
- 外部网络无法直接访问 ST，CSRF 攻击面不存在
- Bridge 作为唯一入口，在 Bridge 侧做 TG InitData 签名校验

**上游升级注意**：
若 SillyTavern 升级后 `config.yaml` 被覆盖或重置，需检查此字段是否恢复为 `false`，
重新改为 `true`。

---

### [C002] 开启多用户账户系统

**日期**：2026-06-06（已在运行时确认）
**文件**：`SillyTavern-latest/config.yaml`
**改动**：

```yaml
# 已设置
enableUserAccounts: true
enableDiscreetLogin: false
```

**原因**：
ST 默认单用户模式，`enableUserAccounts: true` 开启多用户隔离，
每个用户数据独立存放在 `data/<handle>/`。
`enableDiscreetLogin: false` 保持用户列表可见（Bridge 需要用户列表做检查）。

**上游升级注意**：
此字段若被重置为 `false`，所有用户将共用 `default-user` 数据目录，
数据隔离失效。升级后必须检查。

---

## 改动模板

````
### [CXXX] 标题

**日期**：YYYY-MM-DD
**文件**：相对路径
**改动**：
```diff
- 改前
+ 改后
````

**原因**：...
**安全影响评估**：...
**上游升级注意**：...

```

```
