<template>
  <section class="page" data-module="rectification-detail">
    <header class="page-head">
      <div>
        <h2>整改任务详情</h2>
        <p class="page-desc">任务状态、期限与复核信息都来自整改任务本身的唯一数据口径；复核确认后会同步回写关联验收单。</p>
      </div>
      <div class="page-actions">
        <button class="btn ghost" type="button" @click="goList">返回整改列表</button>
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
          <span class="stat-label">关联验收单</span>
          <strong class="stat-value">
            <RouterLink v-if="acceptance" class="link" :to="`/acceptance/${acceptance.id}`">
              {{ row['验收编号'] }}（{{ acceptance.status }}）
            </RouterLink>
            <template v-else>{{ row['验收编号'] || '—' }}</template>
          </strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">复核人</span>
          <strong class="stat-value">{{ row['复核人'] || '待复核确认' }}</strong>
        </article>
      </div>

      <h3 class="section-title">任务信息</h3>
      <div class="detail-grid">
        <div v-for="field in infoFields" :key="field" class="detail-item">
          <span class="detail-label">{{ field }}</span>
          <span>{{ displayValue(field) }}</span>
        </div>
      </div>

      <h3 class="section-title">整改流程记录</h3>
      <div class="timeline">
        <div v-for="item in timeline" :key="item.label" class="timeline-row">
          <span class="timeline-time">{{ item.time || '—' }}</span>
          <span>{{ item.label }}</span>
          <span v-if="item.extra" class="page-desc">{{ item.extra }}</span>
        </div>
      </div>

      <p v-if="String(row.status) === '逾期未改'" class="page-desc" style="margin-top: 12px">
        该任务为历史逾期记录，保留当时结论，不再推进状态。
      </p>

      <div class="page-actions" style="margin-top: 16px">
        <template v-for="action in allowedActions" :key="action">
          <button
            v-if="action !== '确认复核'"
            class="btn"
            type="button"
            :disabled="busy"
            @click="runSimpleAction(action)"
          >
            {{ action }}
          </button>
          <button v-else class="btn primary" type="button" :disabled="busy" @click="openReviewDialog">
            确认复核…
          </button>
        </template>
        <span v-if="!allowedActions.length" class="page-desc">当前状态无可用动作</span>
      </div>
    </template>

    <p v-else class="empty-state">没有找到该整改任务，可能已被重置。</p>

    <footer class="page-foot">
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="notice" class="page-desc">{{ notice }}</span>
    </footer>

    <div v-if="reviewOpen" class="modal-mask" @click.self="closeReviewDialog">
      <form class="modal-card" @submit.prevent="confirmReview">
        <h3 class="modal-title">确认复核</h3>
        <div class="modal-body">
          <label>
            <span>复核人 *</span>
            <input v-model="reviewer" placeholder="请输入复核人姓名" />
          </label>
          <label>
            <span>复核结论</span>
            <textarea v-model="reviewResult" rows="3" placeholder="不填默认「复核通过」"></textarea>
          </label>
        </div>
        <div class="modal-foot">
          <button class="btn ghost" type="button" @click="closeReviewDialog">取消</button>
          <button class="btn primary" type="submit" :disabled="busy">提交复核结论</button>
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
  listEntries,
  moduleMeta,
  submitAction,
} from '@/api/local-service'
import { useSessionStore } from '@/stores/session'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('rectification')
const route = useRoute()
const router = useRouter()
const session = useSessionStore()

const infoFields = ['任务编号', '验收编号', '整改内容', '责任单位', '整改期限', '整改措施']
const row = ref<EntryRow | undefined>()
const acceptance = ref<EntryRow | undefined>()
const errorMessage = ref('')
const notice = ref('')
const busy = ref(false)
const reviewOpen = ref(false)
const reviewer = ref(session.operator)
const reviewResult = ref('')

const allowedActions = computed(() => (row.value ? availableActions(meta, row.value) : []))

const timeline = computed(() => {
  if (!row.value) return []
  return [
    { label: '开始整改', time: row.value['整改开始时间'], extra: '' },
    { label: '提交复核', time: row.value['复核提交时间'], extra: '' },
    {
      label: '确认复核',
      time: row.value['复核时间'],
      extra: row.value['复核人'] ? `复核人：${row.value['复核人']}；结论：${row.value['复核结论'] ?? '复核通过'}` : '',
    },
  ].filter((item) => item.time || item.label === '开始整改' || item.label === '提交复核')
})

function displayValue(field: string): string {
  if (!row.value) return '—'
  const value = row.value[field]
  return value === '' || value == null ? '—' : String(value)
}

function statusClass(status: string | number | boolean): string {
  const text = String(status)
  if (text === '逾期未改') return 'overdue'
  if (text === '已复核') return 'final'
  return ''
}

function goList() {
  router.push('/rectification')
}

function openReviewDialog() {
  errorMessage.value = ''
  notice.value = ''
  reviewer.value = session.operator
  reviewResult.value = ''
  reviewOpen.value = true
}

function closeReviewDialog() {
  if (busy.value) return
  reviewOpen.value = false
}

async function runSimpleAction(action: string) {
  await execute(action)
}

async function confirmReview() {
  await execute('确认复核', { 复核人: reviewer.value.trim(), 复核结论: reviewResult.value.trim() })
  if (!errorMessage.value) {
    reviewOpen.value = false
  }
}

async function execute(action: string, patch: Record<string, string> = {}) {
  errorMessage.value = ''
  notice.value = ''
  if (!row.value || isActionInFlight(meta.key, Number(row.value.id))) {
    errorMessage.value = '该任务正在处理中，请勿重复提交'
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
  const code = row.value ? String(row.value['验收编号'] ?? '') : ''
  acceptance.value = code
    ? listEntries('acceptance').items.find((item) => String(item['验收编号'] ?? '') === code)
    : undefined
}

onMounted(reload)
</script>
