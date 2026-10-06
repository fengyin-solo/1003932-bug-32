<template>
  <section class="page" data-module="acceptance-detail">
    <header class="page-head">
      <div>
        <h2>验收报告详情</h2>
        <p class="page-desc">验收状态与关联整改进度共用一份口径：关联任务全部复核通过后验收单自动回到验收中，历史逾期记录保留当时结论。</p>
      </div>
      <div class="page-actions">
        <button class="btn ghost" type="button" @click="goList">返回验收列表</button>
      </div>
    </header>

    <template v-if="row">
      <div class="stat-row">
        <article class="stat-card">
          <span class="stat-label">当前状态</span>
          <strong class="stat-value">
            <span class="status-tag" :class="statusClass(row.status)">{{ row.status }}</span>
          </strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">关联整改</span>
          <strong class="stat-value">{{ rectifications.length }} 条任务</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">已复核 / 逾期</span>
          <strong class="stat-value">{{ reviewedCount }} / {{ overdueCount }}</strong>
        </article>
      </div>

      <h3 class="section-title">验收信息</h3>
      <div class="detail-grid">
        <div v-for="field in infoFields" :key="field" class="detail-item" :class="{ full: longFields.includes(field) }">
          <span class="detail-label">{{ field }}</span>
          <span>{{ displayValue(field) }}</span>
        </div>
        <div v-if="row['要求整改时间']" class="detail-item">
          <span class="detail-label">要求整改时间</span>
          <span>{{ row['要求整改时间'] }}</span>
        </div>
      </div>

      <h3 class="section-title">关联整改任务（验收编号 {{ row['验收编号'] }}）</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th>任务编号</th>
            <th>整改内容</th>
            <th>责任单位</th>
            <th>整改期限</th>
            <th>复核人</th>
            <th>当前状态</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in rectifications" :key="String(item.id)">
            <td>
              <RouterLink class="link" :to="`/rectification/${item.id}`">{{ item['任务编号'] }}</RouterLink>
            </td>
            <td>{{ item['整改内容'] || '—' }}</td>
            <td>{{ item['责任单位'] || '—' }}</td>
            <td>{{ item['整改期限'] || '—' }}</td>
            <td>{{ item['复核人'] || '—' }}</td>
            <td>
              <span class="status-tag" :class="statusClass(item.status)">{{ item.status }}</span>
            </td>
          </tr>
          <tr v-if="!rectifications.length">
            <td colspan="6" class="empty-state">暂无按此验收编号关联的整改任务</td>
          </tr>
        </tbody>
      </table>

      <p v-if="String(row.status) === '需整改' && !reviewedAll" class="page-desc" style="margin-top: 12px">
        仍有整改任务未完成复核或存在逾期记录，验收单保持「需整改」，不会提前转回验收中。
      </p>

      <div class="page-actions" style="margin-top: 16px">
        <template v-for="action in allowedActions" :key="action">
          <button
            v-if="action !== '要求整改'"
            class="btn"
            type="button"
            :disabled="busy"
            @click="runSimpleAction(action)"
          >
            {{ action }}
          </button>
          <button v-else class="btn primary" type="button" :disabled="busy" @click="openDeadlineDialog">
            要求整改…
          </button>
        </template>
        <span v-if="!allowedActions.length" class="page-desc">当前状态无可用动作</span>
      </div>
    </template>

    <p v-else class="empty-state">没有找到该验收报告，可能已被重置。</p>

    <footer class="page-foot">
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="notice" class="page-desc">{{ notice }}</span>
    </footer>

    <div v-if="deadlineOpen" class="modal-mask" @click.self="closeDeadlineDialog">
      <form class="modal-card" @submit.prevent="confirmRequireRectification">
        <h3 class="modal-title">要求整改</h3>
        <div class="modal-body">
          <label>
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
import { useRoute, useRouter } from 'vue-router'

import {
  availableActions,
  getEntry,
  isActionInFlight,
  linkedRectifications,
  moduleMeta,
  submitAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('acceptance')
const route = useRoute()
const router = useRouter()

const infoFields = ['验收编号', '项目编号', '验收类型', '验收日期', '验收组成员', '验收结论', '整改意见', '验收状态']
const longFields = ['验收结论', '整改意见']
const row = ref<EntryRow | undefined>()
const rectifications = ref<EntryRow[]>([])
const errorMessage = ref('')
const notice = ref('')
const busy = ref(false)
const deadlineOpen = ref(false)
const deadline = ref('')

const allowedActions = computed(() => (row.value ? availableActions(meta, row.value) : []))
const reviewedCount = computed(
  () => rectifications.value.filter((item) => String(item.status) === '已复核').length,
)
const overdueCount = computed(
  () => rectifications.value.filter((item) => String(item.status) === '逾期未改').length,
)
const reviewedAll = computed(
  () => rectifications.value.length > 0 && rectifications.value.every((item) => String(item.status) === '已复核'),
)

function displayValue(field: string): string {
  if (!row.value) return '—'
  const value = row.value[field]
  return value === '' || value == null ? '—' : String(value)
}

function statusClass(status: string | number | boolean): string {
  const text = String(status)
  if (['验收通过', '已复核'].includes(text)) return 'final'
  if (['已驳回', '逾期未改'].includes(text)) return 'overdue'
  return ''
}

function goList() {
  router.push('/acceptance')
}

function openDeadlineDialog() {
  errorMessage.value = ''
  notice.value = ''
  deadline.value = ''
  deadlineOpen.value = true
}

function closeDeadlineDialog() {
  if (busy.value) return
  deadlineOpen.value = false
}

async function runSimpleAction(action: string) {
  await execute(action)
}

async function confirmRequireRectification() {
  if (!deadline.value) {
    errorMessage.value = '请选择整改期限'
    return
  }
  await execute('要求整改', { 整改期限: deadline.value })
  if (!errorMessage.value) {
    deadlineOpen.value = false
  }
}

async function execute(action: string, patch: Record<string, string> = {}) {
  errorMessage.value = ''
  notice.value = ''
  if (!row.value || isActionInFlight(meta.key, Number(row.value.id))) {
    errorMessage.value = '该验收单正在处理中，请勿重复提交'
    return
  }
  busy.value = true
  try {
    const result = await submitAction(meta.key, Number(row.value.id), action, patch)
    if (!result.ok) {
      errorMessage.value = result.message
      return
    }
    notice.value = result.message
  } finally {
    busy.value = false
    reload()
  }
}

function reload() {
  const id = Number(route.params.id)
  row.value = getEntry(meta.key, id)
  rectifications.value = row.value
    ? linkedRectifications(String(row.value['验收编号'] ?? ''))
    : []
}

onMounted(reload)
</script>
