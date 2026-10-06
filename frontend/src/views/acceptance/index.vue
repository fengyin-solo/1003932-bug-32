<template>
  <section class="page" data-module="acceptance">
    <header class="page-head">
      <div>
        <h2>工程验收管理</h2>
        <p class="page-desc">维护验收报告，围绕验收编号、项目编号、验收类型、验收日期做登记、筛选与状态流转。要求整改时填写的期限会同事务写回关联整改任务。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记验收报告</button>
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
          <th>关联整改</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">
            <RouterLink v-if="column === '验收编号'" class="link" :to="`/acceptance/${row.id}`">
              {{ row[column] ?? '—' }}
            </RouterLink>
            <template v-else>{{ row[column] === '' || row[column] == null ? '—' : row[column] }}</template>
          </td>
          <td>
            <RouterLink class="link" :to="`/acceptance/${row.id}`">
              {{ rectSummary(row) }}
            </RouterLink>
          </td>
          <td>
            <span class="status-tag" :class="statusClass(row.status)">{{ row.status }}</span>
          </td>
          <td class="row-actions">
            <template v-if="allowedActions(row).length">
              <button
                v-for="action in allowedActions(row)"
                :key="action"
                class="link"
                type="button"
                :disabled="busyKey === `${row.id}:${action}`"
                @click="runAction(action, row)"
              >
                {{ action === '要求整改' ? `${action}…` : action }}
              </button>
            </template>
            <span v-else class="page-desc">无可用动作</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无工程验收数据，可先登记验收报告</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条工程验收记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="deadlineOpen" class="modal-mask" @click.self="closeDeadlineDialog">
      <form class="modal-card" @submit.prevent="confirmRequireRectification">
        <h3 class="modal-title">要求整改</h3>
        <div class="modal-body">
          <p class="page-desc">验收单将转为「需整改」，整改期限写回验收编号 {{ targetCode }} 下仍在推进的整改任务。</p>          <label>
            <span>整改期限 *</span>
            <input v-model="deadline" type="date" />
          </label>
        </div>
        <div class="modal-foot">
          <button class="btn ghost" type="button" @click="closeDeadlineDialog">取消</button>
          <button class="btn primary" type="submit" :disabled="busy">确认要求整改</button>
        </div>
      </form>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  availableActions,
  downloadEntries,
  isActionInFlight,
  linkedRectifications,
  listEntries,
  moduleMeta,
  submitAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('acceptance')
const columns = ["验收编号", "项目编号", "验收类型", "验收日期", "验收组成员", "验收结论", "整改意见", "验收状态"]
const statuses = ["待验收", "验收中", "验收通过", "需整改", "已驳回"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const busyKey = ref('')
const busy = ref(false)
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const deadlineOpen = ref(false)
const targetRow = ref<EntryRow | null>(null)
const deadline = ref('')
const targetCode = computed(() => (targetRow.value ? String(targetRow.value['验收编号'] ?? '') : ''))

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
const stats = computed(() => [
  { label: '待验收项目', value: rows.value.filter((row) => ['待验收', '验收中'].includes(String(row.status))).length },
  { label: '通过项目数', value: rows.value.filter((row) => String(row.status) === '验收通过').length },
  { label: '整改中项目', value: rows.value.filter((row) => String(row.status) === '需整改').length },
])

function statusClass(status: string | number | boolean): string {
  const text = String(status)
  if (['验收通过'].includes(text)) return 'final'
  if (['已驳回'].includes(text)) return 'overdue'
  return ''
}

function allowedActions(row: EntryRow): string[] {
  return availableActions(meta, row)
}

function rectSummary(row: EntryRow): string {
  const linked = linkedRectifications(String(row['验收编号'] ?? ''))
  if (!linked.length) {
    return '无关联任务'
  }
  const reviewed = linked.filter((item) => String(item.status) === '已复核').length
  const overdue = linked.filter((item) => String(item.status) === '逾期未改').length
  return `共${linked.length}条 · 已复核${reviewed}条${overdue ? ` · 逾期${overdue}条` : ''}`
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '验收报告登记入口尚未接入审批流'
}

async function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  if (action === '要求整改') {
    targetRow.value = row
    deadline.value = ''
    deadlineOpen.value = true
    return
  }
  await execute(row, action)
}

function closeDeadlineDialog() {
  if (busy.value) return
  deadlineOpen.value = false
  targetRow.value = null
}

async function confirmRequireRectification() {
  if (!targetRow.value) return
  if (!deadline.value) {
    errorMessage.value = '请选择整改期限'
    return
  }
  await execute(targetRow.value, '要求整改', { 整改期限: deadline.value })
  if (!errorMessage.value) {
    deadlineOpen.value = false
    targetRow.value = null
  }
}

async function execute(row: EntryRow, action: string, patch: Record<string, string> = {}) {
  errorMessage.value = ''
  if (isActionInFlight(meta.key, Number(row.id))) {
    errorMessage.value = '该验收单正在处理中，请勿重复提交'
    return
  }
  busyKey.value = `${row.id}:${action}`
  busy.value = true
  try {
    const result = await submitAction(meta.key, Number(row.id), action, patch)
    if (!result.ok) {
      errorMessage.value = result.message
    }
  } finally {
    busyKey.value = ''
    busy.value = false
    reload()
  }
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '工程验收列表读取失败'
  }
}

onMounted(reload)
</script>
