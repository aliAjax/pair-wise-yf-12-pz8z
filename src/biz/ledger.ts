/**
 * 账本读写层：唯一接触 localStorage 的地方。
 * 站点、分段电价可增；抄表与账单只追加、不改删（复核是状态流转，更正走负向调整单）。
 * 以响应式单例暴露给界面，所有写操作即时落盘。
 */

import { reactive } from "vue";
import * as R from "./rules";
import type { Bill, PriceSegment, Reading, Station } from "./rules";

const STORAGE_KEY = "hxwlfront-21-feedin-ledger-v1";

export interface LedgerState {
  stations: Station[];
  prices: PriceSegment[];
  readings: Reading[];
  bills: Bill[];
}

const uid = (): string => crypto.randomUUID();
const now = (): string => new Date().toISOString();

// ---------- 种子数据：三站、分段电价（含月中调价）、历史抄表、已确认账单 ----------

function seed(): LedgerState {
  const stations: Station[] = [
    { id: "st-east", name: "东区一站", area: "东区", inverterNo: "INV-E001-SUN2000", gridDate: "2025-11-20", lng: 121.503, lat: 31.245, createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "st-west", name: "西区二站", area: "西区", inverterNo: "INV-W002-SG110CX", gridDate: "2026-01-15", lng: 121.401, lat: 31.222, createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "st-airport", name: "机场线站", area: "机场线", inverterNo: "INV-A003-GCI-100K", gridDate: "2026-03-02", lng: 121.805, lat: 31.156, createdAt: "2026-01-01T00:00:00.000Z" },
  ];

  const prices: PriceSegment[] = [
    { id: uid(), stationId: "st-east", effectiveFrom: "2026-01-01", price: 0.42, createdAt: "2026-01-01T00:00:00.000Z" },
    // 东区一站 8 月 15 日月中调价：0.42 -> 0.36，用于演示按生效日拆分计价
    { id: uid(), stationId: "st-east", effectiveFrom: "2026-08-15", price: 0.36, createdAt: "2026-08-15T00:00:00.000Z" },
    { id: uid(), stationId: "st-west", effectiveFrom: "2026-01-01", price: 0.4, createdAt: "2026-01-01T00:00:00.000Z" },
    { id: uid(), stationId: "st-airport", effectiveFrom: "2026-04-01", price: 0.45, createdAt: "2026-04-01T00:00:00.000Z" },
  ];

  const mk = (
    stationId: string,
    readDate: string,
    value: number,
    status: Reading["status"] = "confirmed",
    note = "",
  ): Reading => ({
    id: uid(),
    stationId,
    readDate,
    month: R.monthOf(readDate),
    value,
    status,
    meterReset: false,
    approvedDelta: null,
    note,
    createdAt: `${readDate}T09:00:00.000Z`,
  });

  const readings: Reading[] = [
    mk("st-east", "2026-06-30", 10000, "confirmed", "首次抄表，作为基准"),
    mk("st-east", "2026-07-31", 13240),
    mk("st-east", "2026-08-31", 16910),
    mk("st-west", "2026-06-30", 5000, "confirmed", "首次抄表，作为基准"),
    mk("st-west", "2026-07-31", 7420),
    mk("st-west", "2026-08-31", 9910),
    // 换表疑似：新表码 260 远低于上期 9910，挂起补录复核
    mk("st-west", "2026-09-20", 260, "pending", "表码低于上期 9910，疑似换表，挂起复核"),
    mk("st-airport", "2026-07-31", 2100, "confirmed", "首次抄表，作为基准"),
    mk("st-airport", "2026-08-31", 4680),
  ];

  const bills: Bill[] = [];
  const seedBill = (stationId: string, month: string, createdAt: string) => {
    const preview = R.previewBill(stationId, month, readings, prices);
    if (preview.ok) bills.push(R.createBill(preview.value, uid(), createdAt));
  };
  seedBill("st-east", "2026-07", "2026-08-03T02:00:00.000Z");
  seedBill("st-west", "2026-07", "2026-08-03T02:10:00.000Z");
  seedBill("st-airport", "2026-08", "2026-09-03T02:00:00.000Z");

  return { stations, prices, readings, bills };
}

// ---------- 读写 ----------

function load(): LedgerState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as LedgerState;
      if (
        Array.isArray(parsed.stations) &&
        Array.isArray(parsed.prices) &&
        Array.isArray(parsed.readings) &&
        Array.isArray(parsed.bills)
      ) {
        return parsed;
      }
    }
  } catch {
    // 本地数据损坏时回退种子数据
  }
  return seed();
}

export interface StationInput {
  name: string;
  area: string;
  inverterNo: string;
  gridDate: string;
  lng: number;
  lat: number;
}

export interface ReadingInput {
  stationId: string;
  readDate: string;
  value: number;
  note: string;
}

export interface ReviewInput {
  mode: "reset" | "correct" | "reject"; // 换表核定 / 改值确认 / 驳回
  approvedDelta?: number;
  correctedValue?: number;
  note?: string;
}

export type SubmitResult = { ok: true; pending: boolean; reason: string } | { ok: false; error: string };

function createLedger() {
  const state = reactive<LedgerState>(load());

  const persist = () => localStorage.setItem(STORAGE_KEY, JSON.stringify(state));

  const stationName = (id: string): string => state.stations.find((s) => s.id === id)?.name ?? "未知站点";

  /** 登记站点：逆变器编号、并网日期、坐标 */
  function addStation(input: StationInput): string | null {
    if (!input.name.trim()) return "请填写站点名称";
    if (!input.inverterNo.trim()) return "请填写逆变器编号";
    if (!R.isDay(input.gridDate)) return "并网日期格式不正确";
    if (!Number.isFinite(input.lng) || !Number.isFinite(input.lat)) return "经纬度必须是数字";
    if (Math.abs(input.lng) > 180 || Math.abs(input.lat) > 90) return "经纬度超出范围";
    if (state.stations.some((s) => s.inverterNo === input.inverterNo.trim())) {
      return `逆变器编号 ${input.inverterNo} 已存在，不能重复登记`;
    }
    state.stations.push({
      id: uid(),
      name: input.name.trim(),
      area: input.area,
      inverterNo: input.inverterNo.trim(),
      gridDate: input.gridDate,
      lng: input.lng,
      lat: input.lat,
      createdAt: now(),
    });
    persist();
    return null;
  }

  /** 登记分段电价：同站同生效日只允许一段；历史账单是快照，不受后续电价影响 */
  function addPrice(stationId: string, effectiveFrom: string, price: number): string | null {
    if (!state.stations.some((s) => s.id === stationId)) return "请先选择站点";
    if (!R.isDay(effectiveFrom)) return "生效日期格式不正确";
    if (!Number.isFinite(price) || price <= 0) return "电价必须大于 0";
    if (state.prices.some((p) => p.stationId === stationId && p.effectiveFrom === effectiveFrom)) {
      return `${effectiveFrom} 已登记过电价，同一天只能有一段`;
    }
    state.prices.push({ id: uid(), stationId, effectiveFrom, price: R.round2(price), createdAt: now() });
    persist();
    return null;
  }

  /** 抄表：低于上期自动挂起补录复核，通过前不进待结算电量 */
  function submitReading(input: ReadingInput): SubmitResult {
    const station = state.stations.find((s) => s.id === input.stationId);
    if (!station) return { ok: false, error: "请先选择站点" };
    if (!R.isDay(input.readDate)) return { ok: false, error: "抄表日期格式不正确" };
    if (input.readDate > R.localToday()) return { ok: false, error: "抄表日期不能晚于今天" };
    if (input.readDate < station.gridDate) return { ok: false, error: `抄表日期早于并网日期 ${station.gridDate}` };
    if (!Number.isFinite(input.value) || input.value < 0) return { ok: false, error: "表码必须是不小于 0 的数字" };
    if (
      state.readings.some(
        (r) => r.stationId === input.stationId && r.readDate === input.readDate && r.value === input.value && r.status !== "rejected",
      )
    ) {
      return { ok: false, error: "同一站点同一天已有相同表码的抄表记录" };
    }

    const prev = R.prevConfirmed(state.readings, input.stationId, input.readDate);
    const check = R.evaluateReading(prev?.value ?? null, input.value);
    state.readings.push({
      id: uid(),
      stationId: input.stationId,
      readDate: input.readDate,
      month: R.monthOf(input.readDate),
      value: input.value,
      status: check.needsReview ? "pending" : "confirmed",
      meterReset: false,
      approvedDelta: null,
      note: input.note.trim() || (check.needsReview ? check.reason : ""),
      createdAt: now(),
    });
    persist();
    return { ok: true, pending: check.needsReview, reason: check.reason };
  }

  /** 复核：换表核定（人工核定跨表增量）/ 改值确认 / 驳回 */
  function reviewReading(id: string, input: ReviewInput): string | null {
    const reading = state.readings.find((r) => r.id === id);
    if (!reading) return "抄表记录不存在";
    if (reading.status !== "pending") return "该记录不在复核队列中";

    if (input.mode === "reject") {
      reading.status = "rejected";
      reading.note = `${reading.note}｜复核驳回：${input.note?.trim() || "读数作废"}`.replace(/^｜/, "");
      persist();
      return null;
    }

    if (input.mode === "correct") {
      const corrected = input.correctedValue;
      if (corrected === undefined || !Number.isFinite(corrected) || corrected < 0) {
        return "请填写不小于 0 的更正表码";
      }
      const prev = R.prevConfirmed(state.readings, reading.stationId, reading.readDate);
      const check = R.evaluateReading(prev?.value ?? null, corrected);
      if (check.needsReview) return "更正后的表码仍低于上期，请改走换表核定";
      reading.value = corrected;
      reading.status = "confirmed";
      reading.note = `${reading.note}｜复核改值：${input.note?.trim() || "录入错误已更正"}`.replace(/^｜/, "");
      persist();
      return null;
    }

    // 换表核定：保留新表首次读数，跨表增量以人工核定为准
    const delta = input.approvedDelta;
    if (delta === undefined || !Number.isFinite(delta) || delta < 0) {
      return "请填写不小于 0 的核定增量（旧表末次到新表首读之间的上网电量）";
    }
    reading.meterReset = true;
    reading.approvedDelta = R.round2(delta);
    reading.status = "confirmed";
    reading.note = `${reading.note}｜复核确认换表，核定增量 ${reading.approvedDelta} kWh`.replace(/^｜/, "");
    persist();
    return null;
  }

  /** 结算：按生效日拆分计价生成账单；已有生效账单的账期只能走负向调整 */
  function settleMonth(stationId: string, month: string): string | null {
    if (R.activeBill(state.bills, stationId, month)) {
      return "该账期已有生效账单，如需更正请使用负向调整单";
    }
    const preview = R.previewBill(stationId, month, state.readings, state.prices);
    if (!preview.ok) return preview.error;
    state.bills.push(R.createBill(preview.value, uid(), now()));
    persist();
    return null;
  }

  /** 更正：原单不改，追加负向调整单全额冲销 */
  function correctBill(billId: string, reason: string): string | null {
    const original = state.bills.find((b) => b.id === billId);
    if (!original) return "账单不存在";
    if (original.kind !== "normal") return "调整单不能再调整";
    if (R.isOffset(original, state.bills)) return "该账单已被冲销，不能重复更正";
    if (!reason.trim()) return "请填写更正原因";
    state.bills.push(R.buildAdjustment(original, reason.trim(), uid(), now()));
    persist();
    return null;
  }

  /** 清空本地账本并回到种子数据 */
  function resetLedger(): void {
    Object.assign(state, seed());
    persist();
  }

  return {
    state,
    stationName,
    addStation,
    addPrice,
    submitReading,
    reviewReading,
    settleMonth,
    correctBill,
    resetLedger,
  };
}

let instance: ReturnType<typeof createLedger> | null = null;

/** 账本单例：所有组件共享同一份本地账本 */
export function useLedger(): ReturnType<typeof createLedger> {
  if (!instance) instance = createLedger();
  return instance;
}
