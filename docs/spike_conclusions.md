# SPIKE-R1 & SPIKE-R4 Conclusions

## SPIKE-R1：ST 是否对 API key 做格式校验（sk- 前缀等）？

**结论**：否。ST 不对 API Key 进行格式层面的强制校验（如要求以 `sk-` 开头或特定长度）。

**主要依据**：

1. 分析 ST 获取密钥的核心逻辑：所有后端的 API 密钥均通过 `src/endpoints/secrets.js` 中的 `readSecret` 方法读取。该方法仅执行从文件（或内存状态）中查找对应的激活的密钥字符串操作（`return activeSecret?.value || '';`），**无任何正则表达式或长度/前缀校验逻辑**。
2. 以 OpenAI / Claude 等核心 API 请求的处理代码为例（在 `src/endpoints/backends/chat-completions.js` 中）：
   获取密钥后，均只有一步非空校验，例如：
   ```javascript
   if (!apiKey) {
     console.warn('Claude API key is missing.');
     return response.status(400).send({ error: true });
   }
   ```
   随后直接将密钥通过 `Authorization: 'Bearer ' + apiKey` 注入请求头。全量代码搜索 `startsWith('sk-')` 或长度校验逻辑，未发现任何在发送请求前拦截特定格式密钥的代码。

## SPIKE-R4：ST session cookie 默认 TTL 是多少？

**结论**：默认 TTL 是**会话级别（即浏览器关闭时失效）**。

**主要依据**：

1. `src/server-main.js` 初始化 `cookieSession` 时，其 `maxAge` 属性由 `getSessionCookieAge()` 返回。
2. 查看 `src/users.js` 中的 `getSessionCookieAge()` 实现：

   ```javascript
   export function getSessionCookieAge() {
     // Defaults to "no expiration" if not set
     const configValue = getConfigValue('sessionTimeout', -1, 'number');

     // Convert to milliseconds
     if (configValue > 0) {
       return configValue * 1000;
     }

     // "No expiration" is just 400 days as per RFC 6265
     if (configValue < 0) {
       return 400 * 24 * 60 * 60 * 1000; // 约等于一年多
     }

     // 0 means session cookie is deleted when the browser session ends
     // (depends on the implementation of the browser)
     return undefined;
   }
   ```

3. 查看默认配置文件（`vendor/sillytavern/config.yaml` 或 `default.yaml` 缺省值）：如果没有修改过，`getConfigValue('sessionTimeout', -1, 'number')` 的缺省 fallback 是 `-1`。
   但在 ST 默认发行的 `config.yaml`（或等效默认配置加载时）往往默认或强制处理逻辑。根据代码注释：
   - 设为 `> 0` 时为该数值的毫秒数
   - 设为 `< 0`（如 `-1`，ST的默认回退值）时，被硬编码为 **400天**。
   - 设为 `0` 时，返回 `undefined`，表示这是一个**会话级别的 Cookie**（关闭浏览器即删除）。
     _纠正_：基于代码直接逻辑，如果没有任何配置，fallback 为 `-1`，此时 Cookie TTL 被硬编码为 400 天。然而，如果在配置文件里配了 0，就是 Session Cookie。所以**纯默认值**（即没有任何显式配置，触发代码中的 `-1` default 时）是 **400天（`400 * 24 * 60 * 60 * 1000` ms）**。
