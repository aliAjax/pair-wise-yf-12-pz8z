// 账本读写：站点、抄表、账单的本地持久化（localStorage），并内置演示数据。
// 所有业务判断走 feedinRules，本模块只负责读写与状态持有。
import { reactive } from "vue";
import {
  approveReview,
  buildAdjustment,
  buildBill,
  diffDays,
  evaluateReading,
  previewBill,
  rejectReview,
  type Bill,
  type MeterReading,
  type ReadingVerdict,
  type Station,
  type StationDraft,
} from "../domain/feedinRules";

const STORAGE_KEY = "hxwlfront-21-feedin-ledger";

export interface LedgerState {
  stations: Station[];
  readings: MeterReading[];
  bills: Bill[];
}

// ---------- 演示数据 ----------

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function localISO(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function monthStart(offset: number): string {
  const now = new Date();
  return localISO(new Date(now.getFullYear(), now.getMonth() + offset, 1));
}

function daysAgo(n: number): string {
  return localISO(new Date(Date.now() - n * DAY_MS));
}

const DAY_MS = 86400000;

export function currentMonth(): string {
  return monthStart(0).slice(0, 7);
}

function seed(): LedgerState {
  const now = Date.now();
  const gridEast = monthStart(-4);
  const gridWest = monthStart(-3);
  const gridAirport = `${monthStart(-2).slice(0, 8)}10`;
  const cutLastMonth = `${monthStart(-1).slice(0, 8)}15`; // 上月15日调价
  const cutThisMonth = `${monthStart(0).slice(0, 8)}15`; // 本月15日调价

  const stations: Station[] = [
    {
      id: "st-east-1",
      name: "东区光伏一站",
      area: "东区",
      inverterNo: "INV-E01-2601",
      gridDate: gridEast,
      lng: 121.52,
      lat: 31.27,
      priceSegments: [
        { id: "ps-e1-a", effectiveDate: gridEast, price: 0.42 },
        { id: "ps-e1-b", effectiveDate: cutLastMonth, price: 0.38 },
      ],
      createdAt: new Date(now - 120 * DAY_MS).toISOString(),
    },
    {
      id: "st-west-1",
      name: "西区光伏二站",
      area: "西区",
      inverterNo: "INV-W02-2602",
      gridDate: gridWest,
      lng: 121.39,
      lat: 31.21,
      priceSegments: [{ id: "ps-w1-a", effectiveDate: gridWest, price: 0.42 }],
      createdAt: new Date(now - 90 * DAY_MS).toISOString(),
    },
    {
      id: "st-ap-1",
      name: "机场线光伏站",
      area: "机场线",
      inverterNo: "INV-A03-2603",
      gridDate: gridAirport,
      lng: 121.81,
      lat: 31.15,
      priceSegments: [
        { id: "ps-a1-a", effectiveDate: gridAirport, price: 0.42 },
        { id: "ps-a1-b", effectiveDate: cutThisMonth, price: 0.4 },
      ],
      createdAt: new Date(now - 60 * DAY_MS).toISOString(),
    },
  ];

  // 抄表走 evaluateReading 判定，倒挂的读数自然进入待复核。
  const readings: MeterReading[] = [];
  let seq = 0;
  const addReading = (stationId: string, readDate: string, value: number, note = "") => {
    const verdict = evaluateReading(readings, stationId, readDate, value);
    seq += 1;
    readings.push({
      id: `rd-${seq}`,
      stationId,
      readDate,
      reading: value,
      status: verdict.status,
      resetBefore: verdict.resetBefore,
      note: note || verdict.reason,
      createdAt: new Date(now - (100 - seq) * 3600000).toISOString(),
    });
  };

  // 东区一站：约 135 kWh/天，每月1日抄表，本月补一次近抄。
  const eastDates = [monthStart(-4), monthStart(-3), monthStart(-2), monthStart(-1), monthStart(0), daysAgo(2)];
  for (const date of eastDates) {
    addReading("st-east-1", date, Math.round(135 * diffDays(gridEast, date)));
  }
  // 西区二站：约 120 kWh/天，最近一次抄表表码倒挂（表计更换，待复核）。
  const westDates = [monthStart(-3), monthStart(-2), monthStart(-1), monthStart(0)];
  for (const date of westDates) {
    addReading("st-west-1", date, Math.round(120 * diffDays(gridWest, date)));
  }
  const westLast = Math.round(120 * diffDays(gridWest, monthStart(0)));
  addReading("st-west-1", daysAgo(1), westLast - 800, "巡检确认表计更换，新表底数待复核");
  // 机场线站：约 45 kWh/天，并网当月起抄。
  const airportDates = [gridAirport, monthStart(-1), monthStart(0), daysAgo(3)];
  for (const date of airportDates) {
    addReading("st-ap-1", date, 120 + Math.round(45 * diffDays(gridAirport, date)));
  }

  // 东区一站上月账单直接按规则出账，账单里能看到月中调价的拆分。
  const bills: Bill[] = [];
  const seeded = buildBill(stations[0], readings, bills, monthStart(-1).slice(0, 7));
  if (seeded) bills.push(seeded);

  return { stations, readings, bills };
}

// ---------- 读写 ----------

function load(): LedgerState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as LedgerState;
      if (
        Array.isArray(parsed.stations) &&
        Array.isArray(parsed.readings) &&
        Array.isArray(parsed.bills)
      ) {
        return parsed;
      }
    }
  } catch {
    // 数据损坏时重建演示账本
  }
  return seed();
}

const state = reactive<LedgerState>(load());

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export const ledger = {
  state,

  saveStation(draft: StationDraft, editingId?: string): Station {
    const normalized: StationDraft = {
      ...draft,
      name: draft.name.trim(),
      inverterNo: draft.inverterNo.trim(),
      priceSegments: [...draft.priceSegments]
        .map((seg) => ({ ...seg, price: Number(seg.price) }))
        .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate)),
    };
    if (editingId) {
      const index = state.stations.findIndex((s) => s.id === editingId);
      if (index >= 0) {
        const updated: Station = { ...state.stations[index], ...normalized };
        state.stations[index] = updated;
        persist();
        return updated;
      }
    }
    const station: Station = {
      ...normalized,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    };
    state.stations.push(station);
    persist();
    return station;
  },

  submitReading(input: {
    stationId: string;
    readDate: string;
    reading: number;
    note: string;
  }): { reading: MeterReading; verdict: ReadingVerdict } {
    const verdict = evaluateReading(state.readings, input.stationId, input.readDate, input.reading);
    const reading: MeterReading = {
      id: crypto.randomUUID(),
      stationId: input.stationId,
      readDate: input.readDate,
      reading: input.reading,
      status: verdict.status,
      resetBefore: verdict.resetBefore,
      note: input.note || verdict.reason,
      createdAt: new Date().toISOString(),
    };
    state.readings.push(reading);
    persist();
    return { reading, verdict };
  },

  resolveReview(readingId: string, approve: boolean): void {
    const index = state.readings.findIndex((r) => r.id === readingId);
    if (index < 0 || state.readings[index].status !== "pending_review") return;
    state.readings[index] = approve
      ? approveReview(state.readings[index])
      : rejectReview(state.readings[index]);
    persist();
  },

  confirmBill(stationId: string, month: string): { bill?: Bill; error?: string } {
    const station = state.stations.find((s) => s.id === stationId);
    if (!station) return { error: "站点不存在" };
    const preview = previewBill(station, state.readings, state.bills, month);
    if (!preview.ok) return { error: preview.message };
    const bill = buildBill(station, state.readings, state.bills, month);
    if (!bill) return { error: "出账失败" };
    state.bills.push(bill);
    persist();
    return { bill };
  },

  createAdjustment(originalBillId: string, reason: string): { bill?: Bill; error?: string } {
    const original = state.bills.find((b) => b.id === originalBillId && b.kind === "original");
    if (!original) return { error: "原始账单不存在" };
    if (!reason.trim()) return { error: "请填写调整原因" };
    const adjustment = buildAdjustment(original, state.bills, currentMonth(), reason.trim());
    state.bills.push(adjustment);
    persist();
    return { bill: adjustment };
  },

  resetDemo(): void {
    const fresh = seed();
    state.stations = fresh.stations;
    state.readings = fresh.readings;
    state.bills = fresh.bills;
    persist();
  },
};
