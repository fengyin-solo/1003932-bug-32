<template>
  <section class="page" data-module="acceptance">
    <header class="page-head">
      <div>
        <h2>工程验收管理</h2>
        <p class="page-desc">验收是否仍「需整改」只看关联整改任务进度：任务提交复核后显示复核中，全部复核通过后才能确认验收。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出工程验收清单</button>
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
          <th>当前状态（按整改进度）</th>
          <th>关联整改</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ display(row, column) }}</td>
          <td><span class="badge" :class="acceptBadgeClass(derivedOf(row))">{{ derivedOf(row) }}</span></td>
          <td>
            <RouterLink
              class="link"
              :to="{ name: 'rectification', query: { keyword: String(row.验收编号 ?? '') } }"
            >{{ progressText(row) }}</RouterLink>
          </td>
          <td class="row-actions">
            <button
              v-for="action in availableAcceptActions(row)"
              :key="action"
              class="link"
              type="button"
              :disabled="busy"
              @click="openAction(row, action)"
            >
              {{ action }}
            </button>
            <span v-if="!availableAcceptActions(row).length" class="muted-text">{{ idleText(row) }}</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无工程验收数据</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条工程验收记录</span>
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
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute } from 'vue-router'

import ActionDialog, { type DialogField } from '@/components/ActionDialog.vue'
import { downloadEntries, moduleMeta } from '@/api/local-service'
import {
  ACCEPT_DERIVED_STATUSES,
  acceptBadgeClass,
  derivedAcceptStatus,
  listAcceptanceRows,
  rectProgress,
} from '@/data/rectification-flow'
import { availableAcceptActions, runAcceptAction } from '@/data/acceptance-flow'
import { useSessionStore } from '@/stores/session'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('acceptance')
// 验收状态徽标单独成列，避免同一结论出现两列两个口径。
const columns = ['验收编号', '项目编号', '验收类型', '验收日期', '验收组成员', '验收结论', '整改意见']
const filterFields = ['验收编号', '项目编号', '验收类型']
const legendStatuses = [...ACCEPT_DERIVED_STATUSES, '已驳回', '逾期未改']
const store = useSessionStore()
const route = useRoute()

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const busy = ref(false)
const filters = ref<Record<string, string>>({ 验收编号: String(route.query.keyword ?? '') })
const dialog = reactive<{ open: boolean; action: string; row: EntryRow | null }>({
  open: false,
  action: '',
  row: null,
})

const stats = computed(() => [
  { label: '待验收项目', value: countDerived('待验收') + countDerived('验收中') },
  { label: '需整改项目', value: countDerived('需整改') + countDerived('复核中') },
  { label: '复核通过待确认', value: countDerived('复核通过') },
  { label: '验收通过项目', value: countDerived('验收通过') },
  { label: '历史逾期未改', value: countDerived('逾期未改') },
])

const statusSummary = computed(() =>
  legendStatuses.map((status) => ({ status, count: countDerived(status) })),
)

function countDerived(derived: string): number {
  return rows.value.filter((row) => derivedOf(row) === derived).length
}

/** 唯一口径：验收行的展示状态一律向整改模块要结论，本页不自行判断。 */
function derivedOf(row: EntryRow): string {
  return String(row.验收状态 ?? derivedAcceptStatus(row))
}

function progressText(row: EntryRow): string {
  const p = rectProgress(String(row.验收编号 ?? ''))
  if (p.total === 0) return '无整改任务'
  return `已复核 ${p.reviewed}/${p.total}${p.overdue ? '（含逾期）' : ''}`
}

function idleText(row: EntryRow): string {
  const derived = derivedOf(row)
  if (derived === '验收通过') return '已办结'
  if (derived === '复核中') return '整改已提交，等待复核'
  if (derived === '逾期未改') return '历史逾期，结论冻结'
  if (derived === '验收中') return '可提出整改或现场核查'
  return ''
}

function display(row: EntryRow, column: string): string {
  const value = row[column]
  return value === undefined || value === '' ? '—' : String(value)
}

const dialogFields = computed<DialogField[]>(() => {
  if (dialog.action === '要求整改') {
    return [
      { name: '整改内容', label: '整改内容', type: 'textarea', required: true, defaultValue: String(dialog.row?.整改意见 ?? '') },
      { name: '责任单位', label: '责任单位', required: true },
      { name: '整改期限', label: '整改期限', type: 'date', required: true },
    ]
  }
  return [
    {
      name: '验收结论',
      label: '验收结论',
      type: 'textarea',
      required: true,
      defaultValue: String(dialog.row?.验收结论 ?? ''),
      placeholder: '关联整改全部复核通过后可确认验收通过',
    },
  ]
})

const dialogHint = computed(() => {
  if (dialog.action === '要求整改') return '确认后生成一条「待整改」任务，任务进度将决定本验收单状态。'
  if (dialog.action === '确认通过') {
    const acceptanceNo = String(dialog.row?.验收编号 ?? '')
    const p = rectProgress(acceptanceNo)
    if (p.total > 0) return `关联整改 ${p.reviewed}/${p.total} 已复核；未全部通过时提交会被拒绝，数据不会改动。`
    return '无关联整改任务，可直接确认验收通过。'
  }
  return ''
})

function openAction(row: EntryRow, action: string) {
  dialog.open = true
  dialog.action = action
  dialog.row = row
  errorMessage.value = ''
}

function closeDialog() {
  if (busy.value) return
  dialog.open = false
  dialog.row = null
}

async function submitAction(values: Record<string, string>) {
  if (!dialog.row) return
  busy.value = true
  errorMessage.value = ''
  const result = await runAcceptAction(Number(dialog.row.id), dialog.action, values, store.operator)
  busy.value = false
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  dialog.open = false
  dialog.row = null
  reload()
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
  const pairs = Object.entries(filters.value).filter(([, value]) => value.trim() !== '')
  rows.value = listAcceptanceRows().filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
  total.value = rows.value.length
}

onMounted(reload)
</script>
