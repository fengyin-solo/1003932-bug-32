import { computed, reactive, ref } from 'vue'

import ActionDialog, { type DialogField } from '@/components/ActionDialog.vue'
import { nextAction, runRectAction } from '@/data/rectification-flow'
import { useSessionStore } from '@/stores/session'
import type { EntryRow } from '@/data/types'

/**
 * 列表页与详情页共用的整改动作弹窗口径：
 * 字段必填校验、写回、串行提交都在状态机里，这里只负责收集输入和提示。
 */
export function useRectActionDialog(onDone: () => void) {
  const store = useSessionStore()
  const busy = ref(false)
  const errorMessage = ref('')
  const dialog = reactive<{ open: boolean; action: string; row: EntryRow | null }>({
    open: false,
    action: '',
    row: null,
  })

  function openAction(row: EntryRow) {
    const action = nextAction(String(row.status))
    if (!action) return
    errorMessage.value = ''
    dialog.open = true
    dialog.action = action
    dialog.row = row
  }

  function closeDialog() {
    if (busy.value) return
    dialog.open = false
    dialog.row = null
  }

  const dialogFields = computed<DialogField[]>(() => {
    if (dialog.action === '开始整改') {
      const oldDeadline = String(dialog.row?.整改期限 ?? '')
      return [
        {
          name: '整改期限',
          label: '整改期限',
          type: 'date',
          required: true,
          defaultValue: oldDeadline && oldDeadline !== '—' ? oldDeadline : '',
        },
        { name: '整改措施', label: '整改措施', type: 'textarea', placeholder: '可先填写整改方案，提交复核前可补充' },
      ]
    }
    if (dialog.action === '提交复核') {
      const oldReviewer = String(dialog.row?.复核人 ?? '')
      return [
        { name: '复核人', label: '复核人', required: true, defaultValue: oldReviewer || store.operator },
        {
          name: '整改措施',
          label: '落实的整改措施',
          type: 'textarea',
          defaultValue: String(dialog.row?.整改措施 ?? ''),
        },
      ]
    }
    return [
      {
        name: '复核结论',
        label: '复核结论',
        type: 'textarea',
        required: true,
        placeholder: '确认复核即视为通过，请填写现场复核意见',
      },
    ]
  })

  const dialogHint = computed(() => {
    if (dialog.action === '确认复核') return '复核结果只保留一次，重复点击「确认复核」不会追加结论。'
    if (dialog.action === '提交复核') return '提交后任务进入「已整改（待复核）」，关联验收状态同步更新。'
    return ''
  })

  async function submitAction(values: Record<string, string>) {
    if (!dialog.row) return
    busy.value = true
    errorMessage.value = ''
    const result = await runRectAction(Number(dialog.row.id), dialog.action, values, store.operator)
    busy.value = false
    if (!result.ok) {
      errorMessage.value = result.message
      return
    }
    dialog.open = false
    dialog.row = null
    onDone()
  }

  return {
    ActionDialog,
    busy,
    errorMessage,
    dialog,
    dialogFields,
    dialogHint,
    openAction,
    closeDialog,
    submitAction,
  }
}
