/**
 * 上网电费规则层（纯函数，不碰存储、不碰界面）。
 *
 * 三条硬规则：
 * 1. 抄表值低于上期 -> 挂起补录复核，复核通过前不计入待结算电量；
 * 2. 电价月中调整 -> 按生效日把表计增量拆成多段分别计价，不用期末单价覆盖全月；
 * 3. 账单确认后更正月 -> 原账单不可改，只能追加负向调整单冲销，原单与首次读数都保留。
 */

// ---------- 基础类型 ----------

export interface Station {
  id: string;
  name: string;
  area: string;
  inverterNo: string; // 逆变器编号
  gridDate: string; // 并网日期 YYYY-MM-DD
  lng: number;
  lat: number;
  createdAt: string;
}

export interface PriceSegment {
  id: string;
  stationId: string;
  effectiveFrom: string; // 生效日 YYYY-MM-DD（含当天）
  price: number; // 元/kWh
  createdAt: string;
}

export type ReadingStatus = "confirmed" | "pending" | "rejected";

export interface Reading {
  id: string;
  stationId: string;
  readDate: string; // 抄表日，所在月份即账期
  month: string; // 账期 YYYY-MM
  value: number; // 表码 kWh
  status: ReadingStatus;
  meterReset: boolean; // 复核确认换表：本读数是新表首次读数
  approvedDelta: number | null; // 换表时人工核定的跨表增量
  note: string;
  createdAt: string;
}

export interface BillSegment {
  from: string; // 计价起始日（含）
  to: string; // 计价截止日（含）
  days: number;
  kwh: number;
  price: number;
  amount: number;
}

export type BillKind = "normal" | "adjustment";

export interface Bill {
  id: string;
  stationId: string;
  month: string; // 账期（调整单挂原单月）
  kind: BillKind;
  energyKwh: number; // 调整单为负
  amount: number; // 调整单为负
  segments: BillSegment[];
  openingReadingId: string | null;
  closingReadingId: string | null;
  targetBillId: string | null; // 调整单指向被冲销的原单
  reason: string;
  createdAt: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

// ---------- 日期工具（账期按自然日，UTC 口径避免时区漂移） ----------

const DAY_MS = 86400000;

export function parseDay(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

export function fmtDay(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

export function localToday(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function monthOf(day: string): string {
  return day.slice(0, 7);
}

export function currentMonth(): string {
  return localToday().slice(0, 7);
}

export function addDays(day: string, n: number): string {
  return fmtDay(parseDay(day) + n * DAY_MS);
}

export function diffDays(from: string, to: string): number {
  return Math.round((parseDay(to) - parseDay(from)) / DAY_MS);
}

export function isDay(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && fmtDay(parseDay(s)) === s;
}

export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

// ---------- 规则一：抄表复核 ----------

export interface ReadingCheck {
  needsReview: boolean;
  reason: string;
}

/** 抄表值低于上期 -> 挂起补录复核 */
export function evaluateReading(prevValue: number | null, value: number): ReadingCheck {
  if (prevValue !== null && value < prevValue) {
    return {
      needsReview: true,
      reason: `表码 ${value} 低于上期 ${prevValue}，疑似换表或录入错误，已挂起补录复核，复核通过前不计入待结算电量`,
    };
  }
  return { needsReview: false, reason: "" };
}

export function sortReadings(list: Reading[]): Reading[] {
  return [...list].sort((a, b) =>
    a.readDate === b.readDate ? a.createdAt.localeCompare(b.createdAt) : a.readDate.localeCompare(b.readDate),
  );
}

/** 已确认读数（pending/rejected 一律不进结算口径） */
export function confirmedReadings(readings: Reading[], stationId: string): Reading[] {
  return sortReadings(readings.filter((r) => r.stationId === stationId && r.status === "confirmed"));
}

/** 某抄表日之前的最近一条已确认读数（作为上期基准） */
export function prevConfirmed(readings: Reading[], stationId: string, beforeDate: string): Reading | null {
  const list = confirmedReadings(readings, stationId).filter((r) => r.readDate < beforeDate);
  return list.length ? list[list.length - 1] : null;
}

/** 账期的关账读数：该月最后一条已确认读数 */
export function closingReading(readings: Reading[], stationId: string, month: string): Reading | null {
  const list = confirmedReadings(readings, stationId).filter((r) => r.month === month);
  return list.length ? list[list.length - 1] : null;
}

// ---------- 规则二：分段电价拆分 ----------

export function sortedPrices(prices: PriceSegment[], stationId: string): PriceSegment[] {
  return prices
    .filter((p) => p.stationId === stationId)
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
}

/** 某日生效单价：取生效日不晚于当天的最后一段 */
export function priceOn(segments: PriceSegment[], day: string): number | null {
  let hit: number | null = null;
  for (const seg of segments) {
    if (seg.effectiveFrom <= day) hit = seg.price;
  }
  return hit;
}

export interface PriceSlice {
  from: string;
  to: string;
  days: number;
  price: number;
}

/**
 * 把计价期间 (fromExclusive, toInclusive] 按电价生效日逐日切开。
 * 月中调价时，调价日前后各按各的单价，绝不拿期末单价覆盖全月。
 */
export function splitPeriodByPrice(
  segments: PriceSegment[],
  fromExclusive: string,
  toInclusive: string,
): Result<PriceSlice[]> {
  if (diffDays(fromExclusive, toInclusive) <= 0) {
    return { ok: false, error: "计价期间不足一天，无法拆分" };
  }
  if (segments.length === 0) {
    return { ok: false, error: "该站尚未登记分段电价，请先在站点电价里补登记" };
  }
  const slices: PriceSlice[] = [];
  let cursor = addDays(fromExclusive, 1);
  let current = priceOn(segments, cursor);
  if (current === null) {
    return { ok: false, error: `${cursor} 之前没有生效电价，请先补登记更早的分段电价` };
  }
  let start = cursor;
  let days = 1;
  while (cursor !== toInclusive) {
    cursor = addDays(cursor, 1);
    const p = priceOn(segments, cursor);
    if (p === null) {
      return { ok: false, error: `${cursor} 缺少生效电价` };
    }
    if (p === current) {
      days += 1;
      continue;
    }
    slices.push({ from: start, to: addDays(cursor, -1), days, price: current });
    start = cursor;
    days = 1;
    current = p;
  }
  slices.push({ from: start, to: toInclusive, days, price: current });
  return { ok: true, value: slices };
}

// ---------- 账单生成 ----------

export interface SettlementPreview {
  stationId: string;
  month: string;
  opening: Reading | null;
  closing: Reading;
  periodFrom: string; // 含
  periodTo: string; // 含
  energyKwh: number;
  segments: BillSegment[];
  amount: number;
}

/**
 * 结算试算：表计增量 = 关账读数 - 上期基准（换表读数用核定增量），
 * 再按电价生效日把增量按天均摊到各价格段。
 */
export function previewBill(
  stationId: string,
  month: string,
  readings: Reading[],
  prices: PriceSegment[],
): Result<SettlementPreview> {
  const closing = closingReading(readings, stationId, month);
  if (!closing) {
    return { ok: false, error: "该账期没有已确认抄表（挂起复核中的读数不计），不能结算" };
  }
  const opening = prevConfirmed(readings, stationId, closing.readDate);

  let energy: number;
  if (closing.meterReset) {
    if (closing.approvedDelta === null || closing.approvedDelta < 0) {
      return { ok: false, error: "换表读数缺少核定增量，请先完成复核" };
    }
    energy = round2(closing.approvedDelta);
  } else {
    if (!opening) {
      return { ok: false, error: "缺少上期基准读数，首次抄表只作基准不计量" };
    }
    energy = round2(closing.value - opening.value);
    if (energy < 0) {
      return { ok: false, error: "表计增量为负，请先复核抄表" };
    }
  }

  const periodStart = opening ? opening.readDate : addDays(closing.readDate, -1);
  const split = splitPeriodByPrice(sortedPrices(prices, stationId), periodStart, closing.readDate);
  if (!split.ok) return split;

  const slices = split.value;
  const totalDays = slices.reduce((acc, s) => acc + s.days, 0);
  const segments: BillSegment[] = [];
  let allocated = 0;
  slices.forEach((s, i) => {
    let kwh: number;
    if (i === slices.length - 1) {
      kwh = round2(energy - allocated); // 尾段吃掉舍入差，保证分段电量合计=表计增量
    } else {
      kwh = round2((energy * s.days) / totalDays);
      allocated = round2(allocated + kwh);
    }
    segments.push({ from: s.from, to: s.to, days: s.days, kwh, price: s.price, amount: round2(kwh * s.price) });
  });

  return {
    ok: true,
    value: {
      stationId,
      month,
      opening,
      closing,
      periodFrom: slices[0].from,
      periodTo: closing.readDate,
      energyKwh: energy,
      segments,
      amount: round2(segments.reduce((acc, s) => acc + s.amount, 0)),
    },
  };
}

export function createBill(preview: SettlementPreview, id: string, now: string): Bill {
  return {
    id,
    stationId: preview.stationId,
    month: preview.month,
    kind: "normal",
    energyKwh: preview.energyKwh,
    amount: preview.amount,
    segments: preview.segments,
    openingReadingId: preview.opening?.id ?? null,
    closingReadingId: preview.closing.id,
    targetBillId: null,
    reason: "",
    createdAt: now,
  };
}

// ---------- 规则三：负向调整单 ----------

/** 原账单是否已被负向调整单冲销（原单本身永不修改，冲销是派生状态） */
export function isOffset(bill: Bill, bills: Bill[]): boolean {
  return bill.kind === "normal" && bills.some((b) => b.kind === "adjustment" && b.targetBillId === bill.id);
}

/** 更正月只能生成负向调整单：全额冲销原单，电量金额取负，原单与读数保留 */
export function buildAdjustment(original: Bill, reason: string, id: string, now: string): Bill {
  return {
    id,
    stationId: original.stationId,
    month: original.month,
    kind: "adjustment",
    energyKwh: -original.energyKwh,
    amount: -original.amount,
    segments: original.segments.map((s) => ({ ...s, kwh: -s.kwh, amount: -s.amount })),
    openingReadingId: original.openingReadingId,
    closingReadingId: original.closingReadingId,
    targetBillId: original.id,
    reason,
    createdAt: now,
  };
}

/** 账期当前生效账单（正常单且未被冲销） */
export function activeBill(bills: Bill[], stationId: string, month: string): Bill | null {
  const normals = bills
    .filter((b) => b.stationId === stationId && b.month === month && b.kind === "normal" && !isOffset(b, bills))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return normals.length ? normals[0] : null;
}

// ---------- 账期状态汇总（地图/列表共用口径） ----------

export type MonthStatus = "billed" | "settleable" | "offset" | "review" | "empty";

export const MONTH_STATUS_LABEL: Record<MonthStatus, string> = {
  billed: "已结算",
  settleable: "待结算",
  offset: "已冲销待重结",
  review: "复核挂起",
  empty: "无数据",
};

export interface MonthSummary {
  stationId: string;
  month: string;
  status: MonthStatus;
  energyKwh: number | null; // 已确认口径的当月上网电量
  amount: number | null;
  bill: Bill | null;
  pendingCount: number; // 挂起复核条数
  settleError: string;
}

export function summarizeMonth(
  stationId: string,
  month: string,
  readings: Reading[],
  bills: Bill[],
  prices: PriceSegment[],
): MonthSummary {
  const bill = activeBill(bills, stationId, month);
  const pendingCount = readings.filter(
    (r) => r.stationId === stationId && r.month === month && r.status === "pending",
  ).length;

  if (bill) {
    return { stationId, month, status: "billed", energyKwh: bill.energyKwh, amount: bill.amount, bill, pendingCount, settleError: "" };
  }

  const hadOffset = bills.some(
    (b) => b.stationId === stationId && b.month === month && b.kind === "normal" && isOffset(b, bills),
  );
  const preview = previewBill(stationId, month, readings, prices);
  if (preview.ok) {
    return {
      stationId,
      month,
      status: hadOffset ? "offset" : "settleable",
      energyKwh: preview.value.energyKwh,
      amount: preview.value.amount,
      bill: null,
      pendingCount,
      settleError: "",
    };
  }
  if (pendingCount > 0) {
    return { stationId, month, status: "review", energyKwh: null, amount: null, bill: null, pendingCount, settleError: preview.error };
  }
  return { stationId, month, status: "empty", energyKwh: null, amount: null, bill: null, pendingCount, settleError: preview.error };
}

/** 待结算电量：已确认增量中尚未被生效账单覆盖的部分（复核挂起的不计） */
export function pendingEnergy(
  stationId: string,
  readings: Reading[],
  bills: Bill[],
  prices: PriceSegment[],
): number {
  const months = new Set<string>();
  for (const r of readings) {
    if (r.stationId === stationId && r.status === "confirmed") months.add(r.month);
  }
  let sum = 0;
  for (const m of months) {
    const s = summarizeMonth(stationId, m, readings, bills, prices);
    if (s.status === "settleable" || s.status === "offset") sum += s.energyKwh ?? 0;
  }
  return round2(sum);
}

/** 出现过的全部账期（倒序） */
export function allMonths(readings: Reading[], bills: Bill[]): string[] {
  const set = new Set<string>();
  readings.forEach((r) => set.add(r.month));
  bills.forEach((b) => set.add(b.month));
  return [...set].sort().reverse();
}
