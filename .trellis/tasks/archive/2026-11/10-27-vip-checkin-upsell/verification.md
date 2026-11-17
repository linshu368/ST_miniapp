# Verification

- 线上基线：Vercel production READY、Railway production SUCCESS、main均d1ae70a893f91dd10ca14c0f2f48be799904275e。
- 用户确认两处为我的签到卡/签到成功提示；150是每日签到额，运营配置已由用户自行修改，本任务未操作生产配置。
- Frontend54文件390项既有测试、typecheck、lint PASS。lint仅既有影像img提示，本次文件无新增警告。最终生产构建PASS（完整独立checkout，无外链薄复制）。
- 手机390x844真实页面+本地合成API：两处150展示，领取后示例余额1280→1295，成功后可直接进入/vip；权益页显示150星尘/天，未触发订单。
- 320x568权益页documentWidth=bodyWidth=viewport=320，返回/支付方式/购买按钮都在视口内。有效VIP的开通引导数量0。
- 仅前端展示及既有入口接线，无共享契约/后端/发奖/支付/数据库变更，无新增依赖或测试文件。
- React review：hooks无条件分支，金额为派生值、服务器状态仍React Query；复用现有开通函数；新组件为纯展示，按钮有名称/焦点和44px触控，装饰图标aria-hidden，使用既有Tailwind配色与reduced-motion，不新增状态源或IO。
- 本地合成API的CORS与头像空值格式已在fixture纠正，未混入产品代码。

- 320px签到成功提示无横向溢出：documentWidth305<=viewport320，关闭按钮left236/right280/top77/bottom121；开通按钮left41/right264/top162/bottom300，可触达。标题/金额/CTA改为分行，避免单字落行。
- 权益缺失时引导数量0；模拟签到500只显示失败提示，余额不变、无成功弹层；同一入口重试成功后再展示成功及引导。关闭成功提示可用。
- 交付4个前端文件，新增复用纯展示组件46行，原3文件约50行新增/9行删除；未更改后端、配置、支付或数据库。未stage/commit/push/deploy。

## Dev alignment

- 用户已批准当前四文件预览，并授权按dev发布。由origin/dev04d5d1aa新建feat/vip-checkin-upsell-dev；回同步origin/main d1ae70a8，避免发布删除已上线的两份签到迁移及说明，三文件逐字节相等，未执行任何SQL。
- 对齐后四个产品文件SHA256与用户批准版本逐一一致；应用/共享源码基线与先前已测试树相同，因此本地390项测试/typecheck/lint/build证据仍有效，远端CI将覆盖完整合并候选。
- dev现行门禁：Quality Gate与1位人工审核，管理员不受强制；未假设此前其它PR的管理员授权适用。
