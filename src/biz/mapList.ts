/**
 * 地图列表交互层：Leaflet 地图与站点列表共享一套选中状态。
 * 地图按月显示各站上网电量（圆点大小=电量、颜色=账期状态），
 * 点列表定位地图，点地图高亮列表。
 */

import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { computed, ref, watch } from "vue";
import { useLedger } from "./ledger";
import * as R from "./rules";

export interface StationMonthRow {
  station: R.Station;
  month: string;
  status: R.MonthStatus;
  statusLabel: string;
  energyKwh: number | null;
  amount: number | null;
  pendingCount: number;
}

export const STATUS_COLOR: Record<R.MonthStatus, string> = {
  billed: "#14724f",
  settleable: "#d9822b",
  offset: "#7a5af8",
  review: "#c84b31",
  empty: "#98a4b8",
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function createMapList() {
  const ledger = useLedger();

  /** 默认账期：最近一个有已确认读数或账单的月份 */
  function defaultMonth(): string {
    const months = [
      ...ledger.state.readings.filter((r) => r.status === "confirmed").map((r) => r.month),
      ...ledger.state.bills.map((b) => b.month),
    ].sort();
    return months.length ? months[months.length - 1] : R.currentMonth();
  }

  const selectedMonth = ref<string>(defaultMonth());
  const selectedStationId = ref<string | null>(null);

  /** 当月各站汇总行：地图圆点和列表共用 */
  const rows = computed<StationMonthRow[]>(() =>
    ledger.state.stations.map((station) => {
      const s = R.summarizeMonth(
        station.id,
        selectedMonth.value,
        ledger.state.readings,
        ledger.state.bills,
        ledger.state.prices,
      );
      return {
        station,
        month: selectedMonth.value,
        status: s.status,
        statusLabel: R.MONTH_STATUS_LABEL[s.status],
        energyKwh: s.energyKwh,
        amount: s.amount,
        pendingCount: s.pendingCount,
      };
    }),
  );

  const monthOptions = computed<string[]>(() => {
    const set = new Set(R.allMonths(ledger.state.readings, ledger.state.bills));
    set.add(R.currentMonth());
    set.add(selectedMonth.value);
    return [...set].sort().reverse();
  });

  const monthTotals = computed(() => ({
    energy: R.round2(rows.value.reduce((acc, r) => acc + (r.energyKwh ?? 0), 0)),
    amount: R.round2(rows.value.reduce((acc, r) => acc + (r.amount ?? 0), 0)),
  }));

  // ---------- Leaflet ----------

  let map: L.Map | null = null;
  let markerLayer: L.LayerGroup | null = null;
  const markers = new Map<string, L.CircleMarker>();

  function popupHtml(row: StationMonthRow): string {
    const s = row.station;
    return [
      `<div style="min-width:190px;line-height:1.7">`,
      `<strong>${escapeHtml(s.name)}</strong><br/>`,
      `逆变器：${escapeHtml(s.inverterNo)}<br/>`,
      `并网日期：${escapeHtml(s.gridDate)}<br/>`,
      `${row.month} 上网电量：${row.energyKwh ?? "—"} kWh<br/>`,
      `结算金额：${row.amount ?? "—"} 元<br/>`,
      `账期状态：${row.statusLabel}`,
      `</div>`,
    ].join("");
  }

  function syncMarkers(): void {
    if (!map || !markerLayer) return;
    markerLayer.clearLayers();
    markers.clear();
    const maxEnergy = Math.max(1, ...rows.value.map((r) => r.energyKwh ?? 0));
    for (const row of rows.value) {
      const { station } = row;
      const radius = 10 + (row.energyKwh ? (row.energyKwh / maxEnergy) * 16 : 0);
      const marker = L.circleMarker([station.lat, station.lng], {
        radius,
        color: "#ffffff",
        weight: 2,
        fillColor: STATUS_COLOR[row.status],
        fillOpacity: 0.92,
      });
      marker.bindTooltip(`${escapeHtml(station.name)}｜${row.energyKwh ?? "—"} kWh`, {
        direction: "top",
        offset: [0, -radius],
      });
      marker.bindPopup(popupHtml(row));
      marker.on("click", () => {
        selectedStationId.value = station.id;
      });
      marker.addTo(markerLayer);
      markers.set(station.id, marker);
    }
  }

  function fitStations(): void {
    if (!map || ledger.state.stations.length === 0) return;
    const bounds = L.latLngBounds(ledger.state.stations.map((s) => [s.lat, s.lng] as [number, number]));
    map.fitBounds(bounds.pad(0.3));
  }

  function initMap(el: HTMLElement): void {
    if (map) return;
    map = L.map(el).setView([121.5, 31.22], 10);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: "&copy; OpenStreetMap",
    }).addTo(map);
    markerLayer = L.layerGroup().addTo(map);
    syncMarkers();
    fitStations();
  }

  function disposeMap(): void {
    map?.remove();
    map = null;
    markerLayer = null;
    markers.clear();
  }

  /** 列表 -> 地图：选中并定位 */
  function focusStation(id: string): void {
    selectedStationId.value = id;
    const station = ledger.state.stations.find((s) => s.id === id);
    if (!station || !map) return;
    map.flyTo([station.lat, station.lng], Math.max(map.getZoom(), 12), { duration: 0.5 });
    window.setTimeout(() => markers.get(id)?.openPopup(), 400);
  }

  // 账期切换、抄表/复核/结算/站点变更都会改变 rows，地图跟着重画
  watch(rows, syncMarkers);

  return {
    selectedMonth,
    selectedStationId,
    rows,
    monthOptions,
    monthTotals,
    initMap,
    disposeMap,
    focusStation,
  };
}

let instance: ReturnType<typeof createMapList> | null = null;

/** 地图列表交互单例：地图与列表共享选中账期和选中站点 */
export function useMapList(): ReturnType<typeof createMapList> {
  if (!instance) instance = createMapList();
  return instance;
}
