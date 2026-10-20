# 技术设计

## 边界

本任务只改变文件地址和引用地址。运行时模块图、公开包出口、函数/组件导出、路由、数据契约和部署拓扑保持不变。

## 目标结构

### 仓库脚本

- `scripts/checks/`：静态守卫。
- `scripts/database/`：migration runner、inspect 与隔离本地数据库验证器。
- `scripts/data/`：角色导入和图片广场 seed 导出工具。
- `ops/image-plaza/README.md`：图片广场离线迁移 runbook。

只下沉一层，避免按每个历史专题继续建立深层目录。Package script 名称保持不变，GitHub workflow 改为新地址。

### 应用与共享包

- Admin 继续采用 `components/` 与 `lib/` 分层：组件分为 `views/`、`config/`，helper 分为 `api/` 和已有明确领域目录。
- Frontend 保持 App Router 和现有业务域目录，只把明显散落的 helper/hook/icon 放入已有所有者目录。
- Backend 把 Lobby/Notifications 移入 `features`，聊天媒体存储归入 `lib/storage`；不移动线上脚本、route 和 repository 大目录。
- Shared 移动文件后由 `src/index.ts` 保持同名根出口，消费者无需改变包级 import。
- Reply Renderer 的 `src/index.ts` 保持公开入口，内部按 rendering、worker、testing 归类。

## 路径风险与保护

1. **脚本根目录计算**：下沉一层后，所有 `dirname`/`import.meta.url` 的 repo root 计算同步多退一级；脚本互引和帮助文本同步。
2. **自动化入口**：更新 package scripts、CI 注释与 Database Migration workflow；后者为手工 workflow，必须静态核对，不能依赖普通 CI 发现。
3. **Worker 与 raw import**：Admin 预览 worker 与 runner 同目录移动，保持相对 Worker URL；更新 triple-slash 和 `?raw` 路径。Reply Renderer 同步 Vitest global setup、esbuild entry 和 Worker URL。
4. **测试 mock**：所有 `vi.mock` 字符串与源码 import 一起更新，避免类型检查通过但 mock 失效。
5. **仓库外配置**：Backend `src/scripts` 不移动，因为 Railway 控制台可能保存仓库外 Start Command。

## 可靠性与恢复

- 无网络、数据库、并发、事务、重试、限流和容量行为变化；这些项不适用于路径归纳。
- 主要故障模型是漏改消费者、相对路径层级错误和工具发现失败，以全仓搜索、类型检查、测试、build 和脚本语法检查覆盖。
- 每组移动可独立 Git revert；不引入双路径 shim，避免旧地址长期存在。
- 若某个移动需要改变业务逻辑或无法验证仓库外消费者，则停止该项并保留原位，其余独立归纳继续。

## 拒绝的过度设计

- 不改成全仓 feature-slice 架构。
- 不给单文件建立目录，不增加 barrel `index.ts`。
- 不重命名公开符号，不拆分大组件，不顺手格式化或重构函数体。
- 不移动 Next route、migration、Prisma、GitHub/Railway/Vercel 约定文件。
