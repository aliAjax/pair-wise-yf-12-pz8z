<script setup lang="ts">
// 地图列表交互：Leaflet 地图按月显示各站上网电量，列表与地图联动。
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { Station } from "../domain/feedinRules";

interface StationMonthStat {
  kwh: number;
  amount: number;
  pending: number;
}

const props = defineProps<{
  stations: Station[];
  stats: Record<string, StationMonthStat>;
  month: string;
  selectedId: string | null;
}>();

const emit = defineEmits<{
  "update:month": [value: string];
  select: [id: string];
  edit: [id: string];
}>();

const mapEl = ref<HTMLDivElement | null>(null);
let map: L.Map | null = null;
let markers = new Map<string, L.CircleMarker>();

function statOf(id: string): StationMonthStat {
  return props.stats[id] ?? { kwh: 0, amount: 0, pending: 0 };
}

const sortedStations = computed(() =>
  [...props.stations].sort((a, b) => statOf(b.id).kwh - statOf(a.id).kwh)
);

const maxKwh = computed(() => Math.max(1, ...props.stations.map((s) => statOf(s.id).kwh)));

function barWidth(id: string): string {
  return `${Math.round((statOf(id).kwh / maxKwh.value) * 100)}%`;
}

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function markerStyle(id: string): { radius: number; fillColor: string } {
  const stat = statOf(id);
  return {
    radius: Math.min(26, 9 + Math.sqrt(Math.max(stat.kwh, 0)) / 6),
    fillColor: stat.pending > 0 ? "#d9a514" : stat.kwh > 0 ? "#176b87" : "#9aa7b8",
  };
}

function popupHtml(station: Station): string {
  const stat = statOf(station.id);
  const lines = [
    `<strong>${esc(station.name)}</strong>`,
    `逆变器 ${esc(station.inverterNo)}`,
    `${props.month} 上网电量 ${stat.kwh} kWh`,
    `估算电费 ¥${stat.amount}`,
  ];
  if (stat.pending > 0) lines.push(`待复核抄表 ${stat.pending} 条`);
  return lines.join("<br/>");
}

function renderMarkers() {
  if (!map) return;
  markers.forEach((marker) => marker.remove());
  markers = new Map();
  for (const station of props.stations) {
    const style = markerStyle(station.id);
    const selected = station.id === props.selectedId;
    const marker = L.circleMarker([station.lat, station.lng], {
      radius: style.radius,
      color: selected ? "#c84b31" : "#ffffff",
      weight: selected ? 3 : 2,
      fillColor: style.fillColor,
      fillOpacity: 0.85,
    });
    marker.bindPopup(popupHtml(station));
    marker.on("click", () => emit("select", station.id));
    marker.addTo(map);
    markers.set(station.id, marker);
  }
}

function fitToStations() {
  if (!map || props.stations.length === 0) return;
  const bounds = L.latLngBounds(props.stations.map((s) => [s.lat, s.lng] as [number, number]));
  map.fitBounds(bounds.pad(0.25));
}

function focusStation(id: string | null) {
  if (!map || !id) return;
  const station = props.stations.find((s) => s.id === id);
  if (!station) return;
  map.setView([station.lat, station.lng], Math.max(map.getZoom(), 12));
  markers.get(id)?.openPopup();
}

function onMonthInput(event: Event) {
  const value = (event.target as HTMLInputElement).value;
  if (value) emit("update:month", value);
}

onMounted(() => {
  if (!mapEl.value) return;
  map = L.map(mapEl.value).setView([31.23, 121.5], 10);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);
  renderMarkers();
  fitToStations();
});

onBeforeUnmount(() => {
  map?.remove();
  map = null;
});

watch(() => props.stations, renderMarkers, { deep: true });
watch(() => [props.stats, props.month], renderMarkers);
watch(() => props.stations.length, fitToStations);
watch(
  () => props.selectedId,
  (id) => {
    renderMarkers();
    focusStation(id);
  }
);
</script>

<template>
  <section class="panel map-panel">
    <div class="toolbar">
      <h2>上网电量地图</h2>
      <label class="month-picker">
        结算月份
        <input type="month" :value="month" @input="onMonthInput" />
      </label>
    </div>

    <div ref="mapEl" class="map" />
    <p class="legend">
      <span><i class="dot dot-on" />正常发电</span>
      <span><i class="dot dot-pending" />有待复核抄表</span>
      <span><i class="dot dot-off" />当月无增量</span>
      <span>圆点大小 ∝ 当月上网电量</span>
    </p>

    <div class="station-list">
      <div v-if="sortedStations.length === 0" class="empty">暂无站点，请先在左侧登记</div>
      <article
        v-for="station in sortedStations"
        :key="station.id"
        class="station-row"
        :class="{ active: station.id === selectedId }"
        @click="emit('select', station.id)"
      >
        <div class="station-main">
          <p class="record-title">
            {{ station.name }}
            <span class="inv">逆变器 {{ station.inverterNo }}</span>
          </p>
          <p class="station-sub">
            并网 {{ station.gridDate }} · {{ station.area }} · {{ station.priceSegments.length }} 段电价
          </p>
          <div class="bar-track"><div class="bar-fill" :style="{ width: barWidth(station.id) }" /></div>
        </div>
        <div class="station-nums">
          <strong>{{ statOf(station.id).kwh }} kWh</strong>
          <span>≈ ¥{{ statOf(station.id).amount }}</span>
          <span v-if="statOf(station.id).pending > 0" class="badge warn">
            待复核 {{ statOf(station.id).pending }}
          </span>
        </div>
        <div class="row-actions">
          <button type="button" class="secondary" @click.stop="emit('edit', station.id)">编辑</button>
        </div>
      </article>
    </div>
  </section>
</template>
