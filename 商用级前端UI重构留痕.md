# 商用级前端UI重构留痕 (V2 Visual Upgrade)

## 📌 背景与目标

在第一版基于 `shadcn/ui` 的基础组件替换完成后，UI 仍带有较强的「基础组件库 / AI 生成」的通用感（多为灰/白扁平色块、默认阴影，缺乏深度和品牌质感）。
目标：参考市面头部 AI 角色对话产品（如 星野、Talkie 等），在**不改动 SillyTavern 核心前端和任何后端接口**的前提下，将 MiniApp 独立页面的视觉全面升级至「商用级（Commercial-Grade）」质感。

核心设计语言升级：

- **主题基调**：从纯黑/深灰（bg-background）切换至深邃星空紫/夜空黑（`bg-[#080014]`），结合顶部环境光晕（Radial Gradients）。
- **材质系统**：全面引入 Glassmorphism（毛玻璃/高斯模糊），使用 `bg-white/5` + `backdrop-blur` 替代死板的 `bg-card`，边框使用高光反射 `border-white/10`。
- **色彩与层级**：以高对比度的金色/琥珀色（Amber）作为充值/资产的强调色，紫色/靛蓝（Indigo/Fuchsia）作为交互组件和标签的强调色。
- **字体与留白**：优化标题 tracking（字间距），增加组件间的呼吸感。

---

## 🛠 详细改造记录

### 1. 全局设计规范注入 (Global Foundation)

虽然不直接大改 `globals.css` 避免污染 ST，但在各大主页的 `<main>` 容器级强制应用：

- 背景：`bg-[#080014] text-white`
- 顶部环境光：添加 absolute 定位的 `radial-gradient`，如 `from-indigo-900/20 via-transparent`，为页面打光。

### 2. 个人主页 (Profile Page) - `profile/page.tsx`

打破原有的堆叠布局，构建更强烈的身份与资产层次。

- **头部栏**：星尘余额展示从简单的 outline 变为胶囊态的玻璃拟态组件（`bg-white/5 backdrop-blur-md`），增加 hover 放大反馈。
- **用户身份区**：头像（Avatar）放大至 `h-24 w-24` 并加上厚重的光环（`ring-4 ring-white/10 ring-offset-4 ring-offset-[#080014]`）和底部投影。名称可点击编辑状态采用更宽的暗框焦点。
- **资产大卡片（我的星尘）**：设计独立的、具有实体卡片质感的充值引导区。数字使用流光渐变文字（`text-transparent bg-clip-text bg-gradient-to-b from-white to-amber-200`），并内置了背景氛围光（`bg-amber-500/10 blur-3xl`）。
- **每日签到卡片**：采用微缩的高斯模糊卡片，按钮颜色调整为更有质感的靛蓝（Indigo-500），点击态反馈更紧实。

### 3. 星尘商店 (Recharge Page) - `profile/recharge/page.tsx`

消除原先粗糙的占位感，打造更具沉浸感的虚拟商品商店。

- **背景与光效**：顶部增加 `h-56` 的琥珀色星空渐变环境光。
- **标语与安全背书**：调整字距和灰度（`text-white/60`），底部的安全认证增加图标和通透感。
- **底部悬浮结算台**：重构为 `bg-[#080014]/80 backdrop-blur-xl` 的玻璃态底座。
- **支付按钮**：去除了廉价的渐变，使用极简高级的纯白底黑字（`bg-white text-black`），未选中时为暗色（`bg-white/10 text-white/30`），并在选中后加入白光阴影（`shadow-[0_0_20px_rgba(255,255,255,0.3)]`）。

### 4. 套餐卡片 (Plan Card) - `components/payment/plan-card.tsx`

这是充值页面的视觉核心，对四种不同类型（入门、标准、推荐、SVIP）的套餐进行了深度重新映射（Variant Mapping）：

- 整体边框从简单的 outline 改为带有高光和阴影的玻璃态。
- **entry**：纯净玻璃态（`bg-white/5 border-white/10`）。
- **standard**：靛蓝科技感（`bg-indigo-900/20` + 发光外发边框）。
- **recommended**：主推琥珀金色（`bg-white/10 border-amber-500/50`），增加内部高光阴影，标签带有强烈视觉吸力。
- **premium**：紫色紫红系（Fuchsia）的特殊渐变底纹，SVIP 角标重新设计，凸显最高规格。

### 5. 订单列表 (Orders Page) - `profile/orders/page.tsx`

- **Tab 栏**：胶囊型 Tab，选中态使用高亮白底（`bg-white/10`），未选中态文字减淡（`text-white/40`），取消了底边框线条感。
- **列表 Item**：改用 `bg-white/[0.03]` 的暗色块，左侧 Icon 区域根据状态带有低饱和度的背板（如 `bg-emerald-500/10 text-emerald-400`），右侧箭头变得更为柔和。
- **底部抽屉 (Sheet)**：从底部弹出的订单详情，面板采用极致的深空色 `bg-[#120a1f]`。核心金额使用超大号（`text-[40px]`）无衬线字体，列表使用内部虚线分割。

### 6. 设置中心 (Settings Page) - `profile/settings/page.tsx`

模仿 iOS 和微信的块状分组（Grouped List），但保持暗黑太空主题。

- 每一个设置大块都是一个独立的玻璃态圆角矩形（`rounded-[24px]`）。
- 左侧 Icon 加入彩色的背板光晕（例如紫色的 `bg-indigo-500/20 text-indigo-400`）。
- **字号与长度选择器**：按钮组去除了边框，采用高斯模糊内的暗槽设计（`bg-white/5`），激活态按钮有强烈的品牌色突起和发光阴影。
- **文本输入区**：去除了默认的 border-input 色，改用 `bg-white/5 border-white/10` 并在获取焦点时泛出靛蓝光环。

### 7. 角色大厅 (Character Gallery & Card) - `components/characters/character-gallery.tsx` & `character-card.tsx`

- **角色卡片**：移除了呆板的 `bg-card` 灰色，转用 `bg-white/5 border-white/10` 的透光材质。交互上增加了 `hover:-translate-y-1` 的上浮和 `hover:shadow-indigo-500/20` 的环境光晕，使其更像实体卡牌。
- **搜索框与空态**：搜索框融入背景的玻璃质感，搜索不到结果时的「去许愿池」按钮重新设计，带有星光 Icon 和动态旋转反馈，增加了页面的趣味和互动感。

---

## 🚫 边界坚守 (Out of Scope)

本次 V2 商业级改造依然坚守以下底线：

1. **绝不触碰** `chat/composer.tsx` 或任何影响 SillyTavern 自身聊天流的底层渲染机制（只修改我们自己注入的「余额不足」等拦截弹窗）。
2. **零后端改动**：纯纯的前端展示层重绘，依然完全对接之前的真实支付与用户设置 API。
3. **保持独立性**：组件的重构没有修改根目录的 `tailwind.config.ts` 中的全局变量，而是通过在组件层应用具体的色值与透明度来确保绝对隔离。

---

## ✅ 验证步骤

1. 打开部署后的链接。
2. 浏览 `Profile -> 星尘商店`，感受流光溢彩的套餐卡片与底部深邃的结算台。
3. 返回主页点击「我的订单」，查看空态页面以及列表明细抽屉的字偶间距与呼吸感。
4. 进入「设置」，体验具有实体按键质感的选项切换，以及无感获取焦点的自定义指令输入框。
5. 浏览角色发现列表，感受高斯模糊材质下卡牌的悬浮光影效果。
