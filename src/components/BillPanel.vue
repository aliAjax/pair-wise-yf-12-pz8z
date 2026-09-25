<script setup lang="ts">
import { computed, reactive } from "vue";
import { ElMessage } from "element-plus";
import { useLedger } from "../biz/ledger";
import { isOffset, summarizeMonth, type Bill, type MonthSummary } from "../biz/rules";

const ledger = useLedger();

interface SettleRow {
  stationId: string;
  stationName: string;
  month: string;
  summary: MonthSummary;
}

/** 可结算账期：有已确认增量但还没有生效账单（含冲销后待重结） */
const settleRows = computed<SettleRow[]>(() => {
  const out: SettleRow[] = [];
  for (const station of ledger.state.stations) {
    const months = new Set(
      ledger.state.readings.filter((r) => r.stationId === station.id && r.status === "confirmed").map((r) => r.month),
    );
    for (const month of months) {
      const summary = summarizeMonth(
        station.id,
        month,
        ledger.state.readings,
        ledger.state.bills,
        ledger.state.prices,
      );
      if (summary.status === "settleable" || summary.status === "offset") {
        out.push({ stationId: station.id, stationName: station.name, month, summary });
      }
    }
  }
  return out.sort((a, b) => (a.month === b.month ? a.stationName.localeCompare(b.stationName) : b.month.localeCompare(a.month)));
});

function settle(row: SettleRow) {
  const err = ledger.settleMonth(row.stationId, row.month);
  if (err) return ElMessage.error(err);
  ElMessage.success(`${row.stationName} ${row.month} 账单已确认，增量已按电价生效日分段计价`);
}

interface BillRow {
  bill: Bill;
  stationName: string;
  offset: boolean;
  targetMonth: string | null;
}

const billRows = computed<BillRow[]>(() =>
  [...ledger.state.bills]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((bill) => {
      const target = bill.targetBillId ? ledger.state.bills.find((b) => b.id === bill.targetBillId) : null;
      return {
        bill,
        stationName: ledger.stationName(bill.stationId),
        offset: isOffset(bill, ledger.state.bills),
        targetMonth: target ? target.month : null,
      };
    }),
);

const correctForms = reactive<Record<string, { open: boolean; reason: string }>>({});

function correctForm(id: string) {
  if (!correctForms[id]) correctForms[id] = { open: false, reason: "" };
  return correctForms[id];
}

function correct(id: string) {
  const f = correctForm(id);
  const err = ledger.correctBill(id, f.reason);
  if (err) return ElMessage.error(err);
  ElMessage.success("已生成负向调整单冲销原账单，原单与首次读数保留，可重新结算");
  delete correctForms[id];
}
</script>

<template>
  <section class="panel">
    <h2>待结算账期</h2>
    <div v-if="settleRows.length === 0" class="empty">没有待结算的账期</div>
    <article v-for="row in settleRows" :key="`${row.stationId}-${row.month}`" class="record">
      <div class="record-head">
        <p class="record-title">{{ row.stationName }} / {{ row.month }}</p>
        <span class="status" :class="`tag-${row.summary.status}`">
          {{ row.summary.status === "offset" ? "已冲销待重结" : "待结算" }}
        </span>
      </div>
      <div class="details">
        <span>表计增量: {{ row.summary.energyKwh }} kWh</span>
        <span>试算金额: {{ row.summary.amount }} 元</span>
      </div>
      <div class="actions">
        <button type="button" @click="settle(row)">
          {{ row.summary.status === "offset" ? "重新结算" : "确认账单" }}
        </button>
      </div>
    </article>

    <h2 class="gap-top">账单台账</h2>
    <div v-if="billRows.length === 0" class="empty">暂无账单</div>
    <article v-for="row in billRows" :key="row.bill.id" class="record">
      <div class="record-head">
        <p class="record-title">{{ row.stationName }} / {{ row.bill.month }}</p>
        <span v-if="row.bill.kind === 'adjustment'" class="status tag-adjust">负向调整单</span>
        <span v-else-if="row.offset" class="status tag-offset">已冲销</span>
        <span v-else class="status tag-billed">生效中</span>
      </div>
      <div class="details">
        <span>结算电量: {{ row.bill.energyKwh }} kWh</span>
        <span>结算金额: {{ row.bill.amount }} 元</span>
        <span>确认时间: {{ row.bill.createdAt.slice(0, 19).replace("T", " ") }}</span>
        <span v-if="row.bill.kind === 'adjustment'">冲抵原单账期: {{ row.targetMonth }}</span>
      </div>
      <p v-if="row.bill.kind === 'adjustment'" class="note warn">更正原因：{{ row.bill.reason }}。原账单与首次读数保留，未做任何改动。</p>
      <details class="segments">
        <summary>分段计价明细（{{ row.bill.segments.length }} 段）</summary>
        <div class="segment-row segment-head">
          <span>期间</span><span>天数</span><span>电量 kWh</span><span>单价 元</span><span>金额 元</span>
        </div>
        <div v-for="(seg, i) in row.bill.segments" :key="i" class="segment-row">
          <span>{{ seg.from }} ~ {{ seg.to }}</span>
          <span>{{ seg.days }}</span>
          <span>{{ seg.kwh }}</span>
          <span>{{ seg.price }}</span>
          <span>{{ seg.amount }}</span>
        </div>
      </details>
      <div v-if="row.bill.kind === 'normal' && !row.offset" class="actions">
        <button class="secondary" type="button" @click="correctForm(row.bill.id).open = !correctForm(row.bill.id).open">
          更正（负向调整）
        </button>
      </div>
      <div v-if="row.bill.kind === 'normal' && !row.offset && correctForm(row.bill.id).open" class="correct-box">
        <input v-model="correctForm(row.bill.id).reason" placeholder="更正原因，如：抄表串行，需冲销重算" />
        <button class="danger" type="button" @click="correct(row.bill.id)">生成负向调整单</button>
      </div>
    </article>
  </section>
</template>
