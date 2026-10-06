import { listRows, saveRows } from './local-store'
import {
  ACCEPT_KEY,
  RECT_KEY,
  commitFlow,
  derivedAcceptStatus,
  rectProgress,
  tasksByAcceptance,
} from './rectification-flow'
import type { ActionResult, EntryRow, FlowEvent } from './types'

/**
 * 工程验收动作：启动验收 / 要求整改（生成整改任务）/ 确认通过。
 * 与整改流程共用同一串行锁与事务原语；是否「还需整改」只问整改模块的派生口径。
 */

export const ACCEPT_ACTIONS = ['启动验收', '确认通过', '要求整改']

export type AcceptActionInput = {
  验收结论?: string
  整改内容?: string
  责任单位?: string
  整改期限?: string
}

function nowText(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function pushTimeline(row: EntryRow, event: FlowEvent): EntryRow {
  return { ...row, timeline: [...(Array.isArray(row.timeline) ? row.timeline : []), event] }
}

function nextRectId(): number {
  return listRows(RECT_KEY).reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function nextRectNo(): string {
  const max = listRows(RECT_KEY).reduce((max, row) => {
    const text = String(row.任务编号 ?? '')
    const num = Number(text.replace(/^RECT-/, ''))
    return Number.isFinite(num) ? Math.max(max, num) : max
  }, 0)
  return `RECT-${String(max + 1).padStart(4, '0')}`
}

export async function runAcceptAction(
  id: number,
  action: string,
  input: AcceptActionInput = {},
  operator = '值班管理员',
): Promise<ActionResult> {
  if (!ACCEPT_ACTIONS.includes(action as never)) {
    return { ok: false, message: `验收报告没有登记「${action}」这个动作` }
  }

  // 与整改动作同一把锁、同一事务：并发的验收/整改提交只有一个能进入，失败整体回退。
  return commitFlow([ACCEPT_KEY, RECT_KEY], () => {
    const rows = listRows(ACCEPT_KEY)
    const index = rows.findIndex((row) => Number(row.id) === id)
    if (index < 0) {
      return { ok: false, message: `没有找到编号为 ${id} 的验收报告` }
    }
    const current = rows[index]
    const status = String(current.status)
    const acceptanceNo = String(current.验收编号 ?? '')

    if (action === '启动验收') {
      if (status !== '待验收') {
        return { ok: false, message: `当前状态「${status}」不能启动验收，需先处于「待验收」` }
      }
      const updated = pushTimeline(
        {
          ...current,
          status: '验收中',
          验收状态: '验收中',
          pending: true,
          abnormal: false,
        },
        { from: status, to: '验收中', action, at: nowText(), operator },
      )
      const next = [...rows]
      next[index] = updated
      saveRows(ACCEPT_KEY, next)
      return { ok: true, message: '验收已启动，当前状态「验收中」' }
    }

    if (action === '要求整改') {
      if (status !== '验收中' && status !== '需整改') {
        return { ok: false, message: `当前状态「${status}」不能下发整改，需在「验收中」提出` }
      }
      if (rectProgress(acceptanceNo).overdue) {
        return {
          ok: false,
          message: '该验收存在「逾期未改」的历史整改任务，结论保留，不再下发新任务',
        }
      }
      const content = input.整改内容?.trim() ?? ''
      const unit = input.责任单位?.trim() ?? ''
      const deadline = input.整改期限?.trim() ?? ''
      if (!content || !unit || !deadline) {
        return { ok: false, message: '下发整改必须填写整改内容、责任单位和整改期限' }
      }

      const rectRows = listRows(RECT_KEY)
      const task: EntryRow = {
        id: nextRectId(),
        status: '待整改',
        pending: true,
        abnormal: false,
        任务编号: nextRectNo(),
        验收编号: acceptanceNo,
        整改内容: content,
        责任单位: unit,
        整改期限: deadline,
        整改措施: '',
        复核人: '',
        复核结论: '',
        整改状态: '待整改',
        timeline: [
          {
            from: '验收需整改',
            to: '待整改',
            action: '要求整改',
            at: nowText(),
            operator,
            note: `验收报告 ${acceptanceNo} 下发整改任务`,
          },
        ],
      }
      saveRows(RECT_KEY, [...rectRows, task])

      const updated = pushTimeline(
        {
          ...current,
          status: '需整改',
          验收状态: '需整改',
          整改意见: content,
          pending: true,
          abnormal: false,
        },
        {
          from: status,
          to: '需整改',
          action,
          at: nowText(),
          operator,
          note: `生成整改任务 ${String(task.任务编号)}`,
        },
      )
      const next = [...rows]
      next[index] = updated
      saveRows(ACCEPT_KEY, next)
      return { ok: true, message: `已下发整改任务 ${String(task.任务编号)}，等待责任单位整改` }
    }

    // 确认通过：必须等关联整改任务全部复核通过，遗留逾期同样不允许通过。
    const progress = rectProgress(acceptanceNo)
    if (progress.total > 0) {
      if (progress.overdue) {
        return {
          ok: false,
          message: '存在「逾期未改」的历史整改任务，结论保留，不能确认验收通过',
        }
      }
      if (progress.reviewed !== progress.total) {
        const left = progress.total - progress.reviewed
        return {
          ok: false,
          message: `还有 ${left} 项整改任务未完成复核（复核通过 ${progress.reviewed}/${progress.total}），暂不能确认通过`,
        }
      }
    }
    if (status === '验收通过') {
      return { ok: false, message: '验收报告已通过，不用重复确认' }
    }
    if (status !== '验收中' && status !== '需整改') {
      return { ok: false, message: `当前状态「${status}」不能确认通过` }
    }
    const conclusion = input.验收结论?.trim() ?? ''
    if (!conclusion) {
      return { ok: false, message: '确认通过必须填写验收结论' }
    }
    const updated = pushTimeline(
      {
        ...current,
        status: '验收通过',
        验收状态: '验收通过',
        验收结论: conclusion,
        pending: false,
        abnormal: false,
      },
      { from: status, to: '验收通过', action, at: nowText(), operator, note: conclusion },
    )
    const next = [...rows]
    next[index] = updated
    saveRows(ACCEPT_KEY, next)
    return { ok: true, message: '验收已确认通过' }
  })
}

/** 验收行上允许展示的动作：同样只依据整改模块的派生口径。 */
export function availableAcceptActions(row: EntryRow): string[] {
  const status = String(row.status)
  if (status === '待验收') return ['启动验收']
  if (status === '验收中') {
    return tasksByAcceptance(String(row.验收编号 ?? '')).length > 0
      ? [] // 验收中已生成过整改任务的情况不会出现；防御性留空
      : ['确认通过', '要求整改']
  }
  if (status === '需整改') {
    const progress = rectProgress(String(row.验收编号 ?? ''))
    if (progress.overdue) return [] // 历史逾期冻结，不再下发新任务
    const derived = derivedAcceptStatus(row)
    // 复核通过待确认：只能确认通过；其余在办状态可补发整改，但「确认通过」由服务端拦截。
    return derived === '复核通过' ? ['确认通过'] : ['要求整改']
  }
  return []
}

/**
 * 旧验收数据归一（幂等）：派生状态、待办/异常口径回写并落库，
 * 保证列表、详情链接、导出 CSV、运营概览看到的是同一个结论。
 */
export function migrateAcceptanceData(): void {
  const rows = listRows(ACCEPT_KEY)
  if (rows.length === 0) return
  let changed = false
  const next = rows.map((row) => {
    const derived = derivedAcceptStatus(row)
    const fixed: EntryRow = { ...row }
    if (fixed.验收状态 !== derived) {
      fixed.验收状态 = derived
      changed = true
    }
    const pending = derived !== '验收通过' && derived !== '已驳回' && derived !== '逾期未改'
    const abnormal = derived === '逾期未改' || String(fixed.status) === '已驳回'
    if (fixed.pending !== pending || fixed.abnormal !== abnormal) {
      fixed.pending = pending
      fixed.abnormal = abnormal
      changed = true
    }
    if (!Array.isArray(fixed.timeline)) {
      fixed.timeline = []
      changed = true
    }
    return fixed
  })
  if (changed) saveRows(ACCEPT_KEY, next)
}
