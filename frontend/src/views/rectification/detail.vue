<template>
  <section class="page" data-module="rectification-detail">
    <header class="page-head">
      <div>
        <h2>整改任务详情</h2>
        <p class="page-desc">
          <RouterLink class="link" :to="{ name: 'rectification' }">← 返回整改跟踪列表</RouterLink>
        </p>
      </div>
      <div class="page-actions">
        <button
          v-if="task && nextAction(String(task.status))"
          class="btn primary"
          type="button"
          :disabled="busy"
          @click="openAction(task)"
        >
          {{ nextAction(String(task.status)) }}
        </button>
      </div>
    </header>

    <p v-if="errorMessage" class="error-text">{{ errorMessage }}</p>
    <template v-else-if="task">
      <p v-if="String(task.status) === '逾期未改'" class="notice-bar">
        该任务于 {{ task.整改期限 || '当时' }} 被判定为「逾期未改」，历史结论保留，不再允许推进或复核。
      </p>

      <div class="detail-grid">
        <div v-for="field in fields" :key="field.name" :class="['detail-item', field.wide ? 'detail-wide' : '']">
          <span class="k">{{ field.label }}</span>
          <span v-if="field.name === 'status'" class="v">
            <span class="badge" :class="rectBadgeClass(String(task.status))">{{ task.status }}</span>
          </span>
          <span v-else class="v">{{ display(task[field.name]) }}</span>
        </div>
        <div class="detail-item">
          <span class="k">关联验收</span>
          <span class="v">
            {{ task.验收编号 || '—' }}
            <span class="badge" :class="acceptBadgeClass(acceptView.derived)">{{ acceptView.derived }}</span>
            <RouterLink
              class="link"
              :to="{ name: 'acceptance', query: { keyword: String(task.验收编号 ?? '') } }"
            >查看验收单</RouterLink>
          </span>
        </div>
        <div class="detail-item">
          <span class="k">整改进度</span>
          <span class="v">{{ acceptView.text }}</span>
        </div>
      </div>

      <h3 class="section-title">流转记录</h3>
      <div class="timeline">
        <div v-for="(event, index) in events" :key="index" class="timeline-item">
          <span class="t">{{ event.at }}</span>
          <span class="a">{{ event.action }}</span>
          <span>
            {{ event.from }} → {{ event.to }}
            <template v-if="event.operator"> · {{ event.operator }}</template>
            <template v-if="event.note"> · {{ event.note }}</template>
          </span>
        </div>
        <p v-if="!events.length" class="empty-state">暂无流转记录</p>
      </div>
    </template>

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

import {
  acceptBadgeClass,
  derivedAcceptStatus,
  findRectTask,
  listAcceptanceRows,
  nextAction,
  rectBadgeClass,
  rectProgress,
} from '@/data/rectification-flow'
import { useRectActionDialog } from './use-rect-action-dialog'
import type { EntryRow, FlowEvent } from '@/data/types'

const route = useRoute()
const task = ref<EntryRow | null>(null)

const fields = [
  { name: '任务编号', label: '任务编号' },
  { name: 'status', label: '当前状态' },
  { name: '验收编号', label: '验收编号' },
  { name: '责任单位', label: '责任单位' },
  { name: '整改内容', label: '整改内容', wide: true },
  { name: '整改期限', label: '整改期限' },
  { name: '复核人', label: '复核人' },
  { name: '整改措施', label: '整改措施', wide: true },
  { name: '复核结论', label: '复核结论', wide: true },
]

function reload() {
  errorMessage.value = ''
  const id = Number(route.params.id)
  task.value = findRectTask(id) ?? null
  if (!task.value) {
    errorMessage.value = `没有找到编号为 ${id} 的整改任务`
  }
}

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

const acceptView = computed(() => {
  if (!task.value) return { derived: '—', text: '—' }
  const acceptanceNo = String(task.value.验收编号 ?? '')
  const acceptance = listAcceptanceRows().find((row) => String(row.验收编号 ?? '') === acceptanceNo)
  const derived = acceptance ? derivedAcceptStatus(acceptance) : '未关联验收'
  const progress = rectProgress(acceptanceNo)
  const text =
    progress.total > 0
      ? `关联整改 ${progress.total} 项：已复核 ${progress.reviewed}、待复核 ${progress.submitting}、整改中 ${progress.working}、待整改 ${progress.waiting}${progress.overdue ? '、含逾期未改' : ''}`
      : '暂无关联整改任务'
  return { derived, text }
})

const events = computed<FlowEvent[]>(() =>
  Array.isArray(task.value?.timeline) ? (task.value!.timeline as FlowEvent[]) : [],
)

function display(value: unknown): string {
  return value === undefined || value === '' ? '—' : String(value)
}

onMounted(reload)
</script>
