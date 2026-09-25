<script setup lang="ts">
import { computed, reactive } from "vue";
import { ElMessage } from "element-plus";
import { useLedger } from "../biz/ledger";
import { localToday, prevConfirmed, type Reading } from "../biz/rules";

const ledger = useLedger();

const form = reactive({
  stationId: "",
  readDate: localToday(),
  value: 0,
  note: "",
});

function submit() {
  const res = ledger.submitReading({ ...form, value: Number(form.value) });
  if (!res.ok) return ElMessage.error(res.error);
  if (res.pending) {
    ElMessage.warning(res.reason);
  } else {
    ElMessage.success("抄表已确认，表计增量计入待结算电量");
  }
  form.value = 0;
  form.note = "";
}

/** 复核队列：挂起中的抄表 + 上期基准 */
const pendingRows = computed(() =>
  ledger.state.readings
    .filter((r) => r.status === "pending")
    .map((r) => ({
      reading: r,
      stationName: ledger.stationName(r.stationId),
      prev: prevConfirmed(ledger.state.readings, r.stationId, r.readDate),
    })),
);

const reviewForms = reactive<Record<string, { delta: number | null; value: number | null; note: string }>>({});

function reviewForm(id: string) {
  if (!reviewForms[id]) reviewForms[id] = { delta: null, value: null, note: "" };
  return reviewForms[id];
}

function review(id: string, mode: "reset" | "correct" | "reject") {
  const f = reviewForm(id);
  const err = ledger.reviewReading(id, {
    mode,
    approvedDelta: f.delta === null ? undefined : Number(f.delta),
    correctedValue: f.value === null ? undefined : Number(f.value),
    note: f.note,
  });
  if (err) return ElMessage.error(err);
  ElMessage.success(mode === "reject" ? "已驳回，该读数不进结算" : "复核通过，增量已计入待结算电量");
  delete reviewForms[id];
}

const statusLabel: Record<Reading["status"], string> = {
  confirmed: "已确认",
  pending: "复核挂起",
  rejected: "已驳回",
};

const recentRows = computed(() =>
  [...ledger.state.readings]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 8)
    .map((r) => ({ ...r, stationName: ledger.stationName(r.stationId) })),
);
</script>

<template>
  <section class="panel">
    <h2>抄表录入</h2>
    <form class="form-grid" @submit.prevent="submit">
      <label>
        站点
        <select v-model="form.stationId" required>
          <option value="">请选择</option>
          <option v-for="s in ledger.state.stations" :key="s.id" :value="s.id">{{ s.name }}</option>
        </select>
      </label>
      <div class="field-pair">
        <label>
          抄表日（所在月即账期）
          <input v-model="form.readDate" type="date" required />
        </label>
        <label>
          总表表码 kWh
          <input v-model="form.value" type="number" step="0.01" min="0" required />
        </label>
      </div>
      <label>
        备注
        <input v-model="form.note" placeholder="如：月底抄总表 / 换表现场" />
      </label>
      <button type="submit">提交抄表</button>
      <p class="hint">表码低于上期会自动挂起补录复核，复核通过前不动待结算电量。</p>
    </form>

    <h2 class="gap-top">补录复核队列</h2>
    <div v-if="pendingRows.length === 0" class="empty">没有待复核的抄表</div>
    <article v-for="row in pendingRows" :key="row.reading.id" class="record review-card">
      <div class="record-head">
        <p class="record-title">{{ row.stationName }} / {{ row.reading.readDate }}</p>
        <span class="status tag-review">复核挂起</span>
      </div>
      <div class="details">
        <span>本次表码: {{ row.reading.value }} kWh</span>
        <span>上期基准: {{ row.prev ? `${row.prev.value} kWh（${row.prev.readDate}）` : "无" }}</span>
      </div>
      <p class="note warn">{{ row.reading.note }}</p>
      <div class="review-actions">
        <label>
          换表核定增量 kWh
          <input v-model="reviewForm(row.reading.id).delta" type="number" step="0.01" min="0" placeholder="跨表期间电量" />
        </label>
        <label>
          或更正表码 kWh
          <input v-model="reviewForm(row.reading.id).value" type="number" step="0.01" min="0" placeholder="录入错误时填" />
        </label>
        <label>
          复核说明
          <input v-model="reviewForm(row.reading.id).note" placeholder="选填" />
        </label>
      </div>
      <div class="actions">
        <button type="button" @click="review(row.reading.id, 'reset')">确认换表（按核定增量）</button>
        <button class="secondary" type="button" @click="review(row.reading.id, 'correct')">改值确认</button>
        <button class="danger" type="button" @click="review(row.reading.id, 'reject')">驳回</button>
      </div>
    </article>

    <h2 class="gap-top">最近抄表</h2>
    <div class="reading-list">
      <div v-for="r in recentRows" :key="r.id" class="reading-row">
        <span>{{ r.readDate }}</span>
        <strong>{{ r.stationName }}</strong>
        <span>{{ r.value }} kWh{{ r.meterReset ? "（新表首读）" : "" }}</span>
        <span class="status" :class="`tag-${r.status === 'confirmed' ? 'billed' : r.status === 'pending' ? 'review' : 'empty'}`">
          {{ statusLabel[r.status] }}
        </span>
      </div>
    </div>
  </section>
</template>
