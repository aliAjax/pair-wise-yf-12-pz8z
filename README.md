# 油站光伏上网电费台

- 行业：石油（分布式光伏上网结算）
- 技术栈：Vue3、Vite、TypeScript、Element Plus、Leaflet
- 启动：`npm install && npm run dev`
- 构建：`npm run build`

## 业务规则

- 每站登记逆变器编号、并网日期和分段电价（按生效日生效）。
- 地图按月显示各站上网电量，圆点大小与电量成正比，挂起复核的站点标黄。
- 抄表值低于上期已确认表码时，自动挂起补录复核；复核通过前不计入待结算电量，
  通过后按表计更换处理，以新表码为基线。
- 电价月中调整时，按生效日把表计增量按天拆开计价，不用期末单价覆盖全月。
- 账单确认后不可修改原单；更正月只能生成负向调整单，原账单与首次读数保留。

## 代码结构

- `src/domain/feedinRules.ts` — 规则：抄表校验、复核、分段计价、账单与负向调整（纯函数）
- `src/data/feedinLedger.ts` — 账本读写：localStorage 持久化与演示数据
- `src/components/FeedinMapPanel.vue` — 地图列表交互：Leaflet 地图与月度电量列表联动
- `src/App.vue` — 页面装配：站点登记、抄表复核、账单结算

数据默认保存在浏览器 localStorage（键 `hxwlfront-21-feedin-ledger`），
可通过页面右上角"恢复演示数据"重置。
