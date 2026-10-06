<template>
  <section class="page" data-module="rectification">
    <header class="page-head">
      <div>
        <h2>整改跟踪管理</h2>
        <p class="page-desc">整改任务统一按「待整改 → 整改中 → 已整改 → 已复核」推进，逾期未改为历史结论，冻结保留。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出整改跟踪清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">
            <RouterLink v-if="column === '任务编号'" class="link" :to="{ name: 'rectification-detail', params: { id: row.id } }">
              {{ row[column] }}
            </RouterLink>
            <template v-else>{{ display(row, column) }}</template>
          </td>
          <td><span class="badge" :class="rectBadgeClass(String(row.status))">{{ row.status }}</span></td>
          <td class="row-actions">
            <button
              v-if="nextAction(String(row.status))"
              class="link"
              type="button"
              :disabled="busy"
              @click="openAction(row)"
            >
              {{ nextAction(String(row.status)) }}
            </button>
            <RouterLink class="link" :to="{ name: 'rectification-detail', params: { id: row.id } }">详情</RouterLink>
            <span v-if="!nextAction(String(row.status))" class="muted-text">
              {{ row.status === '逾期未改' ? '历史结论已冻结' : '已办结' }}
            </span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无整改跟踪数据，整改任务由工程验收「要求整改」下发</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条整改跟踪记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <ActionDialog
      :open="dialog.open"
      :title="dialog.action"
      :fields="dialogFields"
      :hint="dialogHint"
      :busy="busy"
      @submit="submitAction"
      @cancel="closeDialog"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'

import { downloadEntries, moduleMeta } from '@/api/local-service'
import {
  RECT_STATUSES,
  filterRectTasks,
  nextAction,
  rectBadgeClass,
} from '@/data/rectification-flow'
import { useRectActionDialog } from './use-rect-action-dialog'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('rectification')
// 整改状态列由统一徽标渲染，不再作为普通列展示两个口径。
const columns = ['任务编号', '验收编号', '整改内容', '责任单位', '整改期限', '整改措施', '复核人']
const filterFields = ['任务编号', '验收编号', '责任单位']
const legendStatuses = [...RECT_STATUSES, '逾期未改']
const route = useRoute()

const rows = ref<EntryRow[]>([])
const total = ref(0)
const filters = ref<Record<string, string>>({ 验收编号: String(route.query.keyword ?? '') })

const {
  ActionDialog,
  busy,
  errorMessage,
  dialog,
  dialogFields,
  dialogHint,
  openAction,
  closeDialog,
  submitAction,
} = useRectActionDialog(reload)

const stats = computed(() => [
  { label: '待整改数', value: countOf('待整改') },
  { label: '整改中数', value: countOf('整改中') },
  { label: '待复核数（已整改）', value: countOf('已整改') },
  { label: '已复核数', value: countOf('已复核') },
  { label: '逾期未改数', value: countOf('逾期未改') },
])

const statusSummary = computed(() =>
  legendStatuses.map((status) => ({ status, count: countOf(status) })),
)

function countOf(status: string): number {
  return rows.value.filter((row) => String(row.status) === status).length
}

/** 期限/复核人等列展示真实写回值，空值不再回退成占位文案。 */
function display(row: EntryRow, column: string): string {
  const value = row[column]
  return value === undefined || value === '' ? '—' : String(value)
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function reload() {
  errorMessage.value = ''
  rows.value = filterRectTasks(filters.value)
  total.value = rows.value.length
}

onMounted(reload)
</script>
