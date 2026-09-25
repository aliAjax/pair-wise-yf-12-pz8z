<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { STATUS_COLOR, useMapList } from "../biz/mapList";
import { MONTH_STATUS_LABEL, type MonthStatus } from "../biz/rules";

const { selectedMonth, selectedStationId, rows, monthOptions, monthTotals, initMap, disposeMap, focusStation } =
  useMapList();

const mapEl = ref<HTMLElement | null>(null);
onMounted(() => {
  if (mapEl.value) initMap(mapEl.value);
});
onBeforeUnmount(() => disposeMap());

const legend = (Object.keys(STATUS_COLOR) as MonthStatus[]).map((status) => ({
  status,
  label: MONTH_STATUS_LABEL[status],
  color: STATUS_COLOR[status],
}));
</script>

<template>
  <section class="panel map-panel">
    <div class="toolbar">
      <h2>上网电量地图</h2>
      <label class="inline-field">
        账期
        <select v-model="selectedMonth">
          <option v-for="m in monthOptions" :key="m" :value="m">{{ m }}</option>
        </select>
      </label>
    </div>

    <div ref="mapEl" class="map" />

    <div class="legend">
      <span v-for="item in legend" :key="item.status"><i :style="{ background: item.color }" />{{ item.label }}</span>
      <span class="legend-total">{{ selectedMonth }} 合计 {{ monthTotals.energy }} kWh / {{ monthTotals.amount }} 元</span>
    </div>

    <div class="record-grid">
      <div v-if="rows.length === 0" class="empty">暂无站点，请先在「站点电价」登记</div>
      <article
        v-for="row in rows"
        :key="row.station.id"
        class="record clickable"
        :class="{ active: row.station.id === selectedStationId }"
        @click="focusStation(row.station.id)"
      >
        <div class="record-head">
          <p class="record-title">{{ row.station.name }}</p>
          <span class="status" :class="`tag-${row.status}`">{{ row.statusLabel }}</span>
        </div>
        <div class="details">
          <span>逆变器: {{ row.station.inverterNo }}</span>
          <span>并网日期: {{ row.station.gridDate }}</span>
          <span>上网电量: {{ row.energyKwh ?? "—" }} kWh</span>
          <span>结算金额: {{ row.amount ?? "—" }} 元</span>
        </div>
        <p v-if="row.pendingCount > 0" class="note warn">有 {{ row.pendingCount }} 条抄表挂起复核，通过前不计入待结算电量</p>
      </article>
    </div>
  </section>
</template>
