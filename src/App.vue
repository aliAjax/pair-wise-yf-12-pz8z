<script setup lang="ts">
import { computed, ref } from "vue";
import { ElMessageBox } from "element-plus";
import MapBoard from "./components/MapBoard.vue";
import StationPanel from "./components/StationPanel.vue";
import ReadingPanel from "./components/ReadingPanel.vue";
import BillPanel from "./components/BillPanel.vue";
import { useLedger } from "./biz/ledger";
import { useMapList } from "./biz/mapList";
import { pendingEnergy } from "./biz/rules";

const ledger = useLedger();
const { rows, selectedMonth } = useMapList();

const tab = ref("reading");

const metrics = computed(() => {
  const state = ledger.state;
  const monthEnergy = rows.value.reduce((acc, r) => acc + (r.energyKwh ?? 0), 0);
  const pending = state.stations.reduce(
    (acc, s) => acc + pendingEnergy(s.id, state.readings, state.bills, state.prices),
    0,
  );
  const reviewCount = state.readings.filter((r) => r.status === "pending").length;
  return [
    { label: "光伏站点", value: state.stations.length },
    { label: `${selectedMonth.value} 上网电量 kWh`, value: Math.round(monthEnergy * 100) / 100 },
    { label: "待结算电量 kWh", value: pending },
    { label: "复核挂起", value: reviewCount },
  ];
});

function resetAll() {
  ElMessageBox.confirm("将清空本地账本并恢复演示数据，确定继续？", "重置账本", {
    confirmButtonText: "重置",
    cancelButtonText: "取消",
    type: "warning",
  })
    .then(() => {
      ledger.resetLedger();
      window.location.reload();
    })
    .catch(() => undefined);
}
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">石油行业 · 油站屋顶光伏</p>
          <h1>油站光伏上网电费台</h1>
          <p class="subtitle">
            站点登记逆变器编号、并网日期与分段电价；地图按月显示各站上网电量。
            抄表低于上期先挂补录复核，电价月中调整按生效日拆开计价，账单确认后更正只走负向调整单。
          </p>
        </div>
        <div class="stack">
          <span class="tag">Vue3</span>
          <span class="tag">TypeScript</span>
          <span class="tag">Leaflet</span>
          <span class="tag">localStorage</span>
          <button class="secondary" type="button" @click="resetAll">重置演示数据</button>
        </div>
      </header>

      <section class="metrics">
        <article v-for="m in metrics" :key="m.label" class="metric">
          <span>{{ m.label }}</span>
          <strong>{{ m.value }}</strong>
        </article>
      </section>

      <section class="workspace">
        <MapBoard />
        <div class="side">
          <el-tabs v-model="tab" class="tabs">
            <el-tab-pane label="抄表复核" name="reading"><ReadingPanel /></el-tab-pane>
            <el-tab-pane label="账单调整" name="bill"><BillPanel /></el-tab-pane>
            <el-tab-pane label="站点电价" name="station"><StationPanel /></el-tab-pane>
          </el-tabs>
        </div>
      </section>
    </div>
  </main>
</template>
