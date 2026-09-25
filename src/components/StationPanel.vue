<script setup lang="ts">
import { computed, reactive } from "vue";
import { ElMessage } from "element-plus";
import { useLedger } from "../biz/ledger";
import { localToday, sortedPrices } from "../biz/rules";

const ledger = useLedger();

const areas = ["东区", "西区", "机场线"];

const stationForm = reactive({
  name: "",
  area: areas[0],
  inverterNo: "",
  gridDate: localToday(),
  lng: 121.47,
  lat: 31.23,
});

function saveStation() {
  const err = ledger.addStation({
    ...stationForm,
    lng: Number(stationForm.lng),
    lat: Number(stationForm.lat),
  });
  if (err) return ElMessage.error(err);
  ElMessage.success("站点已登记");
  stationForm.name = "";
  stationForm.inverterNo = "";
}

const priceForm = reactive({
  stationId: "",
  effectiveFrom: `${localToday().slice(0, 7)}-01`,
  price: 0.4,
});

function savePrice() {
  const err = ledger.addPrice(priceForm.stationId, priceForm.effectiveFrom, Number(priceForm.price));
  if (err) return ElMessage.error(err);
  ElMessage.success("分段电价已登记，历史账单是快照不受影响");
}

const priceRows = computed(() =>
  ledger.state.stations.map((station) => ({
    station,
    segments: sortedPrices(ledger.state.prices, station.id),
  })),
);
</script>

<template>
  <section class="panel">
    <h2>站点登记</h2>
    <form class="form-grid" @submit.prevent="saveStation">
      <label>
        站点名称
        <input v-model="stationForm.name" required placeholder="如：东区一站" />
      </label>
      <label>
        区域
        <select v-model="stationForm.area">
          <option v-for="a in areas" :key="a">{{ a }}</option>
        </select>
      </label>
      <label>
        逆变器编号
        <input v-model="stationForm.inverterNo" required placeholder="如：INV-E001-SUN2000" />
      </label>
      <label>
        并网日期
        <input v-model="stationForm.gridDate" type="date" required />
      </label>
      <div class="field-pair">
        <label>
          经度
          <input v-model="stationForm.lng" type="number" step="0.000001" required />
        </label>
        <label>
          纬度
          <input v-model="stationForm.lat" type="number" step="0.000001" required />
        </label>
      </div>
      <button type="submit">保存站点</button>
    </form>

    <h2 class="gap-top">分段电价</h2>
    <form class="form-grid" @submit.prevent="savePrice">
      <label>
        站点
        <select v-model="priceForm.stationId" required>
          <option value="">请选择</option>
          <option v-for="s in ledger.state.stations" :key="s.id" :value="s.id">{{ s.name }}</option>
        </select>
      </label>
      <div class="field-pair">
        <label>
          生效日（含当天）
          <input v-model="priceForm.effectiveFrom" type="date" required />
        </label>
        <label>
          电价 元/kWh
          <input v-model="priceForm.price" type="number" step="0.0001" min="0.0001" required />
        </label>
      </div>
      <button type="submit">登记电价</button>
      <p class="hint">月中调价就按生效日新登记一段，结算时表计增量按天拆开计价，不拿期末单价覆盖全月。</p>
    </form>

    <div class="price-list">
      <div v-for="row in priceRows" :key="row.station.id" class="price-row">
        <strong>{{ row.station.name }}</strong>
        <span v-if="row.segments.length === 0" class="hint">未登记电价</span>
        <span v-for="seg in row.segments" :key="seg.id" class="tag">{{ seg.effectiveFrom }} 起 {{ seg.price }} 元</span>
      </div>
    </div>
  </section>
</template>
