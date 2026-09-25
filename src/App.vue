<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import {
  billNet,
  confirmedChain,
  estimateMonth,
  previewBill,
  round2,
  validateReadingDraft,
  validateStationDraft,
  type Bill,
  type MeterReading,
  type StationDraft,
} from "./domain/feedinRules";
import { currentMonth, ledger } from "./data/feedinLedger";
import FeedinMapPanel from "./components/FeedinMapPanel.vue";

const state = ledger.state;

const selectedMonth = ref(currentMonth());
const selectedStationId = ref<string | null>(null);

function localToday(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ---------- 站点登记 ----------

function blankStation(): StationDraft {
  return {
    name: "",
    area: "东区",
    inverterNo: "",
    gridDate: "",
    lng: 121.47,
    lat: 31.23,
    priceSegments: [{ id: crypto.randomUUID(), effectiveDate: "", price: 0.42 }],
  };
}

const stationForm = reactive<StationDraft>(blankStation());
const editingStationId = ref<string | null>(null);
const stationErrors = ref<string[]>([]);

function addSegment() {
  stationForm.priceSegments.push({ id: crypto.randomUUID(), effectiveDate: "", price: 0.42 });
}

function removeSegment(id: string) {
  stationForm.priceSegments = stationForm.priceSegments.filter((seg) => seg.id !== id);
}

function submitStation() {
  const errors = validateStationDraft(stationForm, state.stations, editingStationId.value ?? undefined);
  stationErrors.value = errors;
  if (errors.length > 0) return;
  ledger.saveStation(stationForm, editingStationId.value ?? undefined);
  cancelEdit();
}

function editStation(id: string) {
  const station = state.stations.find((s) => s.id === id);
  if (!station) return;
  editingStationId.value = id;
  Object.assign(stationForm, {
    name: station.name,
    area: station.area,
    inverterNo: station.inverterNo,
    gridDate: station.gridDate,
    lng: station.lng,
    lat: station.lat,
    priceSegments: station.priceSegments.map((seg) => ({ ...seg })),
  });
  stationErrors.value = [];
}

function cancelEdit() {
  editingStationId.value = null;
  Object.assign(stationForm, blankStation());
  stationErrors.value = [];
}

// ---------- 抄表登记 ----------

const readingForm = reactive({ stationId: "", readDate: localToday(), reading: 0, note: "" });
const readingMsg = ref<{ kind: "ok" | "warn" | "err"; text: string } | null>(null);

function submitReading() {
  const station = state.stations.find((s) => s.id === readingForm.stationId);
  if (!station) {
    readingMsg.value = { kind: "err", text: "请选择站点" };
    return;
  }
  const errors = validateReadingDraft(station, readingForm.readDate, Number(readingForm.reading));
  if (errors.length > 0) {
    readingMsg.value = { kind: "err", text: errors.join("；") };
    return;
  }
  const { verdict } = ledger.submitReading({
    stationId: station.id,
    readDate: readingForm.readDate,
    reading: Number(readingForm.reading),
    note: readingForm.note.trim(),
  });
  readingMsg.value =
    verdict.status === "pending_review"
      ? { kind: "warn", text: `已挂起补录复核：${verdict.reason}。复核通过前不计入待结算电量。` }
      : { kind: "ok", text: "抄表已确认，计入待结算电量。" };
  readingForm.reading = 0;
  readingForm.note = "";
}

// ---------- 复核队列 ----------

const pendingReadings = computed(() =>
  state.readings
    .filter((r) => r.status === "pending_review")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
);

function previousConfirmed(reading: MeterReading): MeterReading | null {
  const chain = confirmedChain(state.readings, reading.stationId).filter(
    (r) => r.readDate <= reading.readDate
  );
  return chain[chain.length - 1] ?? null;
}

// ---------- 账单结算 ----------

const billForm = reactive({ stationId: "", month: currentMonth() });
const billMsg = ref<{ kind: "ok" | "warn" | "err"; text: string } | null>(null);

const billPreview = computed(() => {
  const station = state.stations.find((s) => s.id === billForm.stationId);
  if (!station || !billForm.month) return null;
  return previewBill(station, state.readings, state.bills, billForm.month);
});

function confirmCurrentBill() {
  const result = ledger.confirmBill(billForm.stationId, billForm.month);
  billMsg.value = result.error
    ? { kind: "err", text: result.error }
    : {
        kind: "ok",
        text: `账单 ${result.bill?.billNo} 已确认。确认后不可改原单，更正月只能生成负向调整单。`,
      };
}

const originalBills = computed(() =>
  state.bills
    .filter((b) => b.kind === "original")
    .sort((a, b) => b.month.localeCompare(a.month) || b.createdAt.localeCompare(a.createdAt))
);

function adjustmentsOf(billId: string): Bill[] {
  return state.bills
    .filter((b) => b.kind === "adjustment" && b.adjustsBillId === billId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

const adjustFor = ref<string | null>(null);
const adjustReason = ref("");
const adjustError = ref("");

function submitAdjustment() {
  if (!adjustFor.value) return;
  const result = ledger.createAdjustment(adjustFor.value, adjustReason.value);
  if (result.error) {
    adjustError.value = result.error;
    return;
  }
  adjustFor.value = null;
  adjustReason.value = "";
  adjustError.value = "";
}

// ---------- 地图与汇总 ----------

const statsByStation = computed(() => {
  const stats: Record<string, { kwh: number; amount: number; pending: number }> = {};
  for (const station of state.stations) {
    const estimate = estimateMonth(station, state.readings, selectedMonth.value);
    stats[station.id] = {
      kwh: estimate.kwh,
      amount: estimate.amount,
      pending: state.readings.filter(
        (r) => r.stationId === station.id && r.status === "pending_review"
      ).length,
    };
  }
  return stats;
});

const metrics = computed(() => {
  const monthKwh = Object.values(statsByStation.value).reduce((sum, s) => sum + s.kwh, 0);
  const monthAmount = state.bills
    .filter((b) => b.month === selectedMonth.value)
    .reduce((sum, b) => sum + b.amount, 0);
  return [
    { label: "站点数", value: String(state.stations.length) },
    { label: `${selectedMonth.value} 上网电量`, value: `${round2(monthKwh)} kWh` },
    { label: "待复核抄表", value: String(pendingReadings.value.length) },
    { label: `${selectedMonth.value} 账单净额`, value: `¥${round2(monthAmount)}` },
  ];
});

function onSelectStation(id: string) {
  selectedStationId.value = id;
  readingForm.stationId = id;
  billForm.stationId = id;
}

// ---------- 抄表流水 ----------

const selectedReadings = computed(() => {
  if (!selectedStationId.value) return [];
  return state.readings
    .filter((r) => r.stationId === selectedStationId.value)
    .sort((a, b) => b.readDate.localeCompare(a.readDate) || b.createdAt.localeCompare(a.createdAt));
});

function readingTag(reading: MeterReading): string {
  if (reading.status === "pending_review") return "待复核";
  if (reading.status === "rejected") return "已驳回";
  if (reading.resetBefore) return "换表基线";
  const chain = confirmedChain(state.readings, reading.stationId);
  return chain[0]?.id === reading.id ? "首次读数" : "已确认";
}

function tagClass(reading: MeterReading): string {
  if (reading.status === "pending_review") return "warn";
  if (reading.status === "rejected") return "err";
  return "ok";
}

// ---------- 通用 ----------

function stationName(id: string): string {
  return state.stations.find((s) => s.id === id)?.name ?? "未知站点";
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", { hour12: false });
}

function resetDemo() {
  if (window.confirm("将清空本地账本并恢复演示数据，继续？")) {
    ledger.resetDemo();
    cancelEdit();
    selectedStationId.value = null;
  }
}
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">石油行业 · 分布式光伏结算</p>
          <h1>油站光伏上网电费台</h1>
          <p class="subtitle">
            每站登记逆变器编号、并网日期与分段电价；地图按月显示上网电量。
            抄表倒挂先挂补录复核，电价月中调整按生效日拆开计价，账单确认后只能负向调整。
          </p>
        </div>
        <div class="stack">
          <span class="tag">Vue3</span>
          <span class="tag">Leaflet</span>
          <span class="tag">本地账本</span>
          <button type="button" class="secondary" @click="resetDemo">恢复演示数据</button>
        </div>
      </header>

      <section class="metrics">
        <article v-for="metric in metrics" :key="metric.label" class="metric">
          <span>{{ metric.label }}</span>
          <strong>{{ metric.value }}</strong>
        </article>
      </section>

      <section class="workspace">
        <div class="col">
          <form class="panel" @submit.prevent="submitStation">
            <h2>{{ editingStationId ? "编辑站点" : "站点登记" }}</h2>
            <div class="form-grid">
              <label>
                油站名称
                <input v-model="stationForm.name" placeholder="如：东区光伏一站" required />
              </label>
              <label>
                区域
                <select v-model="stationForm.area">
                  <option>东区</option>
                  <option>西区</option>
                  <option>机场线</option>
                </select>
              </label>
              <label>
                逆变器编号
                <input v-model="stationForm.inverterNo" placeholder="如 INV-E01-2601" required />
              </label>
              <label>
                并网日期
                <input v-model="stationForm.gridDate" type="date" required />
              </label>
              <div class="row2">
                <label>
                  经度
                  <input v-model.number="stationForm.lng" type="number" step="any" required />
                </label>
                <label>
                  纬度
                  <input v-model.number="stationForm.lat" type="number" step="any" required />
                </label>
              </div>
              <div class="seg-head">
                <span>分段电价（按生效日计价）</span>
                <button type="button" class="secondary" @click="addSegment">+ 添加一段</button>
              </div>
              <div v-for="(seg, index) in stationForm.priceSegments" :key="seg.id" class="seg-row">
                <input
                  v-model="seg.effectiveDate"
                  type="date"
                  :aria-label="`第${index + 1}段生效日`"
                  required
                />
                <input
                  v-model.number="seg.price"
                  type="number"
                  step="0.0001"
                  min="0"
                  :aria-label="`第${index + 1}段电价(元/kWh)`"
                  required
                />
                <button
                  type="button"
                  class="danger"
                  :disabled="stationForm.priceSegments.length <= 1"
                  @click="removeSegment(seg.id)"
                >
                  删
                </button>
              </div>
              <p class="hint">
                月中调价时新增一段电价并填生效日，出账按天拆分表计增量，不会用期末单价覆盖全月。
              </p>
              <ul v-if="stationErrors.length > 0" class="msg err">
                <li v-for="error in stationErrors" :key="error">{{ error }}</li>
              </ul>
              <button type="submit">{{ editingStationId ? "保存修改" : "登记站点" }}</button>
              <button v-if="editingStationId" type="button" class="secondary" @click="cancelEdit">
                取消编辑
              </button>
            </div>
          </form>

          <form class="panel" @submit.prevent="submitReading">
            <h2>抄表登记</h2>
            <div class="form-grid">
              <label>
                站点
                <select v-model="readingForm.stationId" required>
                  <option value="">请选择</option>
                  <option v-for="station in state.stations" :key="station.id" :value="station.id">
                    {{ station.name }}
                  </option>
                </select>
              </label>
              <label>
                抄表日期
                <input v-model="readingForm.readDate" type="date" required />
              </label>
              <label>
                表码（kWh）
                <input v-model.number="readingForm.reading" type="number" step="0.01" min="0" required />
              </label>
              <label>
                备注
                <textarea v-model="readingForm.note" placeholder="换表、异常等说明" />
              </label>
              <p v-if="readingMsg" class="msg" :class="readingMsg.kind">{{ readingMsg.text }}</p>
              <button type="submit">提交抄表</button>
              <p class="hint">表码低于上期时自动挂起补录复核，复核通过前不计入待结算电量。</p>
            </div>
          </form>

          <section class="panel">
            <h2>复核队列</h2>
            <div v-if="pendingReadings.length === 0" class="empty">暂无待复核抄表</div>
            <div class="record-grid">
              <article v-for="reading in pendingReadings" :key="reading.id" class="record">
                <div class="record-head">
                  <p class="record-title">{{ stationName(reading.stationId) }} · {{ reading.readDate }}</p>
                  <span class="badge warn">待复核</span>
                </div>
                <div class="details">
                  <span>
                    上期表码 {{ previousConfirmed(reading)?.reading ?? "—" }}
                    （{{ previousConfirmed(reading)?.readDate ?? "—" }}）
                  </span>
                  <span>本次表码 {{ reading.reading }}</span>
                </div>
                <p class="note">{{ reading.note }}</p>
                <div class="actions">
                  <button type="button" @click="ledger.resolveReview(reading.id, true)">
                    通过复核（按表计更换处理）
                  </button>
                  <button type="button" class="danger" @click="ledger.resolveReview(reading.id, false)">
                    驳回
                  </button>
                </div>
              </article>
            </div>
          </section>
        </div>

        <div class="col">
          <FeedinMapPanel
            v-model:month="selectedMonth"
            :stations="state.stations"
            :stats="statsByStation"
            :selected-id="selectedStationId"
            @select="onSelectStation"
            @edit="editStation"
          />

          <section v-if="selectedStationId" class="panel">
            <div class="toolbar">
              <h2>{{ stationName(selectedStationId) }} · 抄表流水</h2>
              <button type="button" class="secondary" @click="selectedStationId = null">收起</button>
            </div>
            <table class="ledger">
              <thead>
                <tr><th>抄表日期</th><th class="num">表码</th><th>状态</th><th>备注</th></tr>
              </thead>
              <tbody>
                <tr v-for="reading in selectedReadings" :key="reading.id">
                  <td>{{ reading.readDate }}</td>
                  <td class="num">{{ reading.reading }}</td>
                  <td><span class="badge" :class="tagClass(reading)">{{ readingTag(reading) }}</span></td>
                  <td>{{ reading.note || "—" }}</td>
                </tr>
              </tbody>
            </table>
            <p class="hint">首次读数与原始账单永久保留；驳回记录仅留痕，不参与结算。</p>
          </section>

          <section class="panel">
            <h2>账单结算</h2>
            <div class="row2">
              <label>
                站点
                <select v-model="billForm.stationId">
                  <option value="">请选择</option>
                  <option v-for="station in state.stations" :key="station.id" :value="station.id">
                    {{ station.name }}
                  </option>
                </select>
              </label>
              <label>
                结算月份
                <input v-model="billForm.month" type="month" />
              </label>
            </div>

            <div v-if="billPreview" class="preview">
              <p v-if="!billPreview.ok" class="msg warn">{{ billPreview.message }}</p>
              <template v-else>
                <div class="details">
                  <span>
                    期初表码 {{ billPreview.startReading?.reading }}
                    （{{ billPreview.startReading?.readDate }}）
                  </span>
                  <span>
                    期末表码 {{ billPreview.endReading?.reading }}
                    （{{ billPreview.endReading?.readDate }}）
                  </span>
                  <span>上网电量 {{ billPreview.energyKwh }} kWh</span>
                  <span>应收电费 ¥{{ billPreview.amount }}</span>
                </div>
                <table class="ledger">
                  <thead>
                    <tr>
                      <th>计价区间</th><th class="num">天数</th><th class="num">电量(kWh)</th>
                      <th class="num">单价(元)</th><th class="num">金额(元)</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="(split, index) in billPreview.splits" :key="index">
                      <td>{{ split.from }} ~ {{ split.to }}</td>
                      <td class="num">{{ split.days }}</td>
                      <td class="num">{{ split.kwh }}</td>
                      <td class="num">{{ split.price }}</td>
                      <td class="num">{{ split.amount }}</td>
                    </tr>
                  </tbody>
                </table>
                <div class="actions">
                  <button type="button" @click="confirmCurrentBill">确认出账</button>
                </div>
              </template>
            </div>
            <p v-if="billMsg" class="msg" :class="billMsg.kind">{{ billMsg.text }}</p>
            <p class="hint">
              账单确认后不可修改原单；更正月只能生成负向调整单，原账单与首次读数保留。
            </p>

            <div class="record-grid bills">
              <article v-for="bill in originalBills" :key="bill.id" class="record">
                <div class="record-head">
                  <p class="record-title">{{ stationName(bill.stationId) }} · {{ bill.month }}</p>
                  <span class="status">已确认</span>
                </div>
                <div class="details">
                  <span>账单号 {{ bill.billNo }}</span>
                  <span>表码 {{ bill.startReading }} → {{ bill.endReading }}</span>
                  <span>上网电量 {{ bill.energyKwh }} kWh</span>
                  <span>账单金额 ¥{{ bill.amount }}</span>
                  <span>调整后净额 ¥{{ billNet(bill, state.bills) }}</span>
                  <span>出账时间 {{ formatTime(bill.createdAt) }}</span>
                </div>
                <table class="ledger splits">
                  <tbody>
                    <tr v-for="(split, index) in bill.splits" :key="index">
                      <td>{{ split.from }} ~ {{ split.to }}</td>
                      <td class="num">{{ split.days }}天</td>
                      <td class="num">{{ split.kwh }} kWh</td>
                      <td class="num">¥{{ split.price }}</td>
                      <td class="num">¥{{ split.amount }}</td>
                    </tr>
                  </tbody>
                </table>
                <div v-for="adj in adjustmentsOf(bill.id)" :key="adj.id" class="adj">
                  <span class="badge err">负向调整单</span>
                  <span>
                    {{ adj.billNo }} · 更正月 {{ adj.month }} · {{ adj.energyKwh }} kWh ·
                    ¥{{ adj.amount }} · 原因：{{ adj.reason }}
                  </span>
                </div>
                <div class="actions">
                  <template v-if="adjustFor !== bill.id">
                    <button type="button" class="secondary" @click="adjustFor = bill.id">
                      生成负向调整单
                    </button>
                  </template>
                  <template v-else>
                    <input v-model="adjustReason" placeholder="调整原因（必填）" />
                    <button type="button" @click="submitAdjustment">确认调整</button>
                    <button
                      type="button"
                      class="secondary"
                      @click="adjustFor = null; adjustReason = ''; adjustError = ''"
                    >
                      取消
                    </button>
                  </template>
                </div>
                <p v-if="adjustFor === bill.id && adjustError" class="msg err">{{ adjustError }}</p>
              </article>
              <div v-if="originalBills.length === 0" class="empty">暂无账单</div>
            </div>
          </section>
        </div>
      </section>
    </div>
  </main>
</template>
