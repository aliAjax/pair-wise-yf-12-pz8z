// 上网电费规则：抄表校验、复核挂起、分段计价、账单与负向调整。
// 纯函数模块，不读写存储，便于测试与复用。

export interface PriceSegment {
  id: string;
  effectiveDate: string; // 生效日 YYYY-MM-DD
  price: number; // 元/kWh
}

export interface Station {
  id: string;
  name: string;
  area: string;
  inverterNo: string; // 逆变器编号
  gridDate: string; // 并网日期 YYYY-MM-DD
  lng: number;
  lat: number;
  priceSegments: PriceSegment[]; // 分段电价，按生效日生效
  createdAt: string;
}

export interface StationDraft {
  name: string;
  area: string;
  inverterNo: string;
  gridDate: string;
  lng: number;
  lat: number;
  priceSegments: PriceSegment[];
}

export type ReadingStatus = "confirmed" | "pending_review" | "rejected";

export interface MeterReading {
  id: string;
  stationId: string;
  readDate: string; // 抄表日期 YYYY-MM-DD
  reading: number; // 累计表码 kWh
  status: ReadingStatus;
  resetBefore: boolean; // 复核通过的换表读数：作为新基线，之前区间增量清零
  note: string;
  createdAt: string;
}

export interface BillSplit {
  from: string; // 含
  to: string; // 含
  days: number;
  kwh: number;
  price: number; // 元/kWh
  amount: number; // 元
}

export type BillKind = "original" | "adjustment";

export interface Bill {
  id: string;
  billNo: string;
  stationId: string;
  month: string; // 原始单为结算月 YYYY-MM；调整单为更正月
  kind: BillKind;
  adjustsBillId?: string; // 调整单指向的原始单
  reason?: string; // 调整原因
  startReadingId: string; // 期初读数（首次读数保留）
  endReadingId: string;
  startReading: number;
  endReading: number;
  energyKwh: number;
  amount: number;
  splits: BillSplit[];
  createdAt: string;
}

// ---------- 基础工具 ----------

const DAY_MS = 86400000;

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function parseDay(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

export function formatDay(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function addDays(date: string, days: number): string {
  return formatDay(parseDay(date) + days * DAY_MS);
}

export function diffDays(a: string, b: string): number {
  return Math.round((parseDay(b) - parseDay(a)) / DAY_MS);
}

export function monthOf(date: string): string {
  return date.slice(0, 7);
}

// ---------- 分段电价 ----------

export function sortedSegments(segments: PriceSegment[]): PriceSegment[] {
  return [...segments].sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
}

// 某日适用的上网单价：取生效日不晚于当日的最后一段；早于首段则沿用首段价格。
export function priceAt(segments: PriceSegment[], date: string): number {
  const sorted = sortedSegments(segments);
  let price = sorted[0]?.price ?? 0;
  for (const seg of sorted) {
    if (seg.effectiveDate <= date) price = seg.price;
    else break;
  }
  return price;
}

// ---------- 抄表与复核 ----------

// 已确认抄表按日期排序，构成结算链；待复核与已驳回的不参与结算。
export function confirmedChain(readings: MeterReading[], stationId: string): MeterReading[] {
  return readings
    .filter((r) => r.stationId === stationId && r.status === "confirmed")
    .sort((a, b) =>
      a.readDate === b.readDate ? a.createdAt.localeCompare(b.createdAt) : a.readDate.localeCompare(b.readDate)
    );
}

export interface ReadingVerdict {
  status: ReadingStatus;
  resetBefore: boolean;
  reason: string;
}

// 抄表值低于上期已确认表码时，挂起补录复核，通过前不动待结算电量。
export function evaluateReading(
  readings: MeterReading[],
  stationId: string,
  readDate: string,
  reading: number
): ReadingVerdict {
  const chain = confirmedChain(readings, stationId);
  const prev = chain.filter((r) => r.readDate <= readDate).pop();
  if (!prev) {
    return { status: "confirmed", resetBefore: false, reason: "首次/历史基线读数，作为结算起点" };
  }
  if (reading < prev.reading) {
    return {
      status: "pending_review",
      resetBefore: false,
      reason: `本次表码 ${reading} 低于上期 ${prev.reading}（${prev.readDate}），疑似表计更换，挂起补录复核`,
    };
  }
  return { status: "confirmed", resetBefore: false, reason: "" };
}

// 复核通过：按表计更换处理，本次读数成为新基线，与上期之间的增量清零。
export function approveReview(reading: MeterReading): MeterReading {
  return {
    ...reading,
    status: "confirmed",
    resetBefore: true,
    note: [reading.note, "复核通过：按表计更换处理，以本次表码为新基线"].filter(Boolean).join("；"),
  };
}

// 复核驳回：仅留痕，不参与结算。
export function rejectReview(reading: MeterReading): MeterReading {
  return {
    ...reading,
    status: "rejected",
    note: [reading.note, "复核驳回：不计入结算"].filter(Boolean).join("；"),
  };
}

// ---------- 增量与月度电量 ----------

export interface Increment {
  from: MeterReading;
  to: MeterReading;
  kwh: number;
}

// 相邻已确认读数两两成区间；换表基线读数与前一期之间的增量按 0 处理。
export function increments(readings: MeterReading[], stationId: string): Increment[] {
  const chain = confirmedChain(readings, stationId);
  const out: Increment[] = [];
  for (let i = 1; i < chain.length; i += 1) {
    const from = chain[i - 1];
    const to = chain[i];
    const kwh = to.resetBefore ? 0 : Math.max(0, round2(to.reading - from.reading));
    out.push({ from, to, kwh });
  }
  return out;
}

// 某月的增量：以区间末次读数所在月份归属，挂起复核的读数不计入。
export function monthIncrements(readings: MeterReading[], stationId: string, month: string): Increment[] {
  return increments(readings, stationId).filter((inc) => monthOf(inc.to.readDate) === month);
}

// ---------- 分段计价 ----------

// 把 (fromDate, toDate] 的表计增量按天均摊，再按电价生效日拆开计价；
// 月中调价只影响生效日及之后的部分，不拿期末单价覆盖全月。
export function splitByPrice(
  segments: PriceSegment[],
  fromDate: string,
  toDate: string,
  kwh: number
): BillSplit[] {
  if (kwh <= 0) return [];
  const days: { date: string; price: number }[] = [];
  if (fromDate >= toDate) {
    days.push({ date: toDate, price: priceAt(segments, toDate) });
  } else {
    for (let d = addDays(fromDate, 1); d <= toDate; d = addDays(d, 1)) {
      days.push({ date: d, price: priceAt(segments, d) });
    }
  }
  const groups: BillSplit[] = [];
  for (const day of days) {
    const last = groups[groups.length - 1];
    if (last && last.price === day.price) {
      last.to = day.date;
      last.days += 1;
    } else {
      groups.push({ from: day.date, to: day.date, days: 1, kwh: 0, price: day.price, amount: 0 });
    }
  }
  const totalDays = days.length;
  let allocated = 0;
  groups.forEach((group, index) => {
    group.kwh =
      index < groups.length - 1 ? round2((kwh * group.days) / totalDays) : round2(kwh - allocated);
    allocated = round2(allocated + group.kwh);
    group.amount = round2(group.kwh * group.price);
  });
  return groups;
}

// 相邻且同价的计价区间合并，便于账单展示。
function mergeSplits(splits: BillSplit[]): BillSplit[] {
  const out: BillSplit[] = [];
  for (const split of splits) {
    const last = out[out.length - 1];
    if (last && last.price === split.price && addDays(last.to, 1) === split.from) {
      last.to = split.to;
      last.days += split.days;
      last.kwh = round2(last.kwh + split.kwh);
      last.amount = round2(last.amount + split.amount);
    } else {
      out.push({ ...split });
    }
  }
  return out;
}

// ---------- 账单 ----------

export interface BillPreview {
  ok: boolean;
  message: string;
  month: string;
  energyKwh: number;
  amount: number;
  splits: BillSplit[];
  startReading: MeterReading | null;
  endReading: MeterReading | null;
}

export function previewBill(
  station: Station,
  readings: MeterReading[],
  bills: Bill[],
  month: string
): BillPreview {
  const base: BillPreview = {
    ok: false,
    message: "",
    month,
    energyKwh: 0,
    amount: 0,
    splits: [],
    startReading: null,
    endReading: null,
  };
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return { ...base, message: "请选择结算月份" };
  }
  if (bills.some((b) => b.stationId === station.id && b.month === month && b.kind === "original")) {
    return { ...base, message: "该月已存在原始账单；账单确认后不能改原单，请在更正月生成负向调整单" };
  }
  const incs = monthIncrements(readings, station.id, month).filter((inc) => inc.kwh > 0);
  if (incs.length === 0) {
    return { ...base, message: "该月无有效抄表增量：抄表缺失、增量为 0，或仍有抄表挂起复核" };
  }
  const splits = mergeSplits(
    incs.flatMap((inc) => splitByPrice(station.priceSegments, inc.from.readDate, inc.to.readDate, inc.kwh))
  );
  const energyKwh = round2(incs.reduce((sum, inc) => sum + inc.kwh, 0));
  const amount = round2(splits.reduce((sum, split) => sum + split.amount, 0));
  return {
    ok: true,
    message: "",
    month,
    energyKwh,
    amount,
    splits,
    startReading: incs[0].from,
    endReading: incs[incs.length - 1].to,
  };
}

// 地图/列表用的月度估算：与出账同一套规则，但不受"已出账"限制。
export function estimateMonth(
  station: Station,
  readings: MeterReading[],
  month: string
): { kwh: number; amount: number } {
  const incs = monthIncrements(readings, station.id, month).filter((inc) => inc.kwh > 0);
  let kwh = 0;
  let amount = 0;
  for (const inc of incs) {
    kwh += inc.kwh;
    for (const split of splitByPrice(station.priceSegments, inc.from.readDate, inc.to.readDate, inc.kwh)) {
      amount += split.amount;
    }
  }
  return { kwh: round2(kwh), amount: round2(amount) };
}

export function buildBill(
  station: Station,
  readings: MeterReading[],
  bills: Bill[],
  month: string
): Bill | null {
  const preview = previewBill(station, readings, bills, month);
  if (!preview.ok || !preview.startReading || !preview.endReading) return null;
  return {
    id: crypto.randomUUID(),
    billNo: `OR-${station.inverterNo}-${month}`,
    stationId: station.id,
    month,
    kind: "original",
    startReadingId: preview.startReading.id,
    endReadingId: preview.endReading.id,
    startReading: preview.startReading.reading,
    endReading: preview.endReading.reading,
    energyKwh: preview.energyKwh,
    amount: preview.amount,
    splits: preview.splits,
    createdAt: new Date().toISOString(),
  };
}

// 负向调整单：更正月对原单做等额冲减，原账单与首次读数保持不动。
export function buildAdjustment(
  original: Bill,
  bills: Bill[],
  correctionMonth: string,
  reason: string
): Bill {
  const seq =
    bills.filter((b) => b.kind === "adjustment" && b.adjustsBillId === original.id).length + 1;
  return {
    id: crypto.randomUUID(),
    billNo: `AD-${original.billNo.replace(/^OR-/, "")}-${seq}`,
    stationId: original.stationId,
    month: correctionMonth,
    kind: "adjustment",
    adjustsBillId: original.id,
    reason,
    startReadingId: original.startReadingId,
    endReadingId: original.endReadingId,
    startReading: original.startReading,
    endReading: original.endReading,
    energyKwh: round2(-original.energyKwh),
    amount: round2(-original.amount),
    splits: original.splits.map((split) => ({
      ...split,
      kwh: round2(-split.kwh),
      amount: round2(-split.amount),
    })),
    createdAt: new Date().toISOString(),
  };
}

// 原始单净额 = 原单金额 + 其名下全部调整单金额。
export function billNet(original: Bill, bills: Bill[]): number {
  return round2(
    bills
      .filter((b) => b.kind === "adjustment" && b.adjustsBillId === original.id)
      .reduce((sum, b) => sum + b.amount, original.amount)
  );
}

// ---------- 表单校验 ----------

export function validateStationDraft(
  draft: StationDraft,
  stations: Station[],
  editingId?: string
): string[] {
  const errors: string[] = [];
  if (!draft.name.trim()) errors.push("请填写站点名称");
  if (!draft.inverterNo.trim()) {
    errors.push("请填写逆变器编号");
  } else if (stations.some((s) => s.inverterNo === draft.inverterNo.trim() && s.id !== editingId)) {
    errors.push("逆变器编号已存在");
  }
  if (!draft.gridDate) errors.push("请选择并网日期");
  if (!(draft.lng >= -180 && draft.lng <= 180) || !(draft.lat >= -90 && draft.lat <= 90)) {
    errors.push("经纬度超出范围");
  }
  if (draft.priceSegments.length === 0) errors.push("至少登记一段上网电价");
  draft.priceSegments.forEach((seg, index) => {
    if (!seg.effectiveDate) errors.push(`第 ${index + 1} 段电价缺少生效日`);
    if (!(seg.price >= 0)) errors.push(`第 ${index + 1} 段电价需不小于 0`);
  });
  const dates = draft.priceSegments.map((seg) => seg.effectiveDate).filter(Boolean);
  if (new Set(dates).size !== dates.length) errors.push("电价生效日重复");
  return errors;
}

export function validateReadingDraft(station: Station, readDate: string, reading: number): string[] {
  const errors: string[] = [];
  if (!readDate) {
    errors.push("请选择抄表日期");
  } else if (readDate < station.gridDate) {
    errors.push(`抄表日期早于并网日期 ${station.gridDate}`);
  }
  if (!(reading >= 0)) errors.push("表码需不小于 0");
  return errors;
}
