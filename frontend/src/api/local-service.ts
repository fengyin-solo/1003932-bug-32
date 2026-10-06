import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, commitAll, listRows, resetRows } from '@/data/local-store'
import type { ActionPatch, ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 验收 → 整改的关联键与流程字段，集中在一处定义，列表、详情、验收三个页面共用同一口径。
const ACCEPTANCE_KEY = 'acceptance'
const RECTIFICATION_KEY = 'rectification'
const LINK_FIELD = '验收编号'
const RECT_PENDING_STATUSES = ['待整改', '整改中', '已整改']
const RECT_FLOW: Record<string, { timeField: string; message: string }> = {
  开始整改: { timeField: '整改开始时间', message: '整改任务已开始整改' },
  提交复核: { timeField: '复核提交时间', message: '整改任务已提交复核，等待确认' },
  确认复核: { timeField: '复核时间', message: '复核已确认，整改闭环' },
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function getEntry(key: string, id: number): EntryRow | undefined {
  return listRows(key).find((row) => Number(row.id) === id)
}

function finalStatuses(meta: ModuleMeta): string[] {
  return meta.finalStatuses ?? [meta.statuses[meta.statuses.length - 1]]
}

/** pending 统一按终态口径判定：终态（如已复核、逾期未改）一律不再算待处理。 */
export function isPendingStatus(meta: ModuleMeta, status: string): boolean {
  return !finalStatuses(meta).includes(status)
}

/** 动作门控：状态机的唯一判断点，页面渲染与动作提交都以这里为准。 */
export function availableActions(meta: ModuleMeta, row: EntryRow): string[] {
  const current = String(row.status)
  return meta.actions.filter((action) => {
    const sources = meta.actionSources?.[action]
    if (!sources) {
      return meta.actionTargets[action] !== current
    }
    return sources.includes(current)
  })
}

function nowText(): string {
  return new Date().toLocaleString('zh-CN', { hour12: false })
}

type PreparedAction = {
  // 一次动作可能同时改整改任务和关联验收单，全部放进来同事务提交。
  drafts: Record<string, EntryRow[]>
  // 涉及的行级锁，跨模块关联时同时锁住验收单与整改任务。
  lockKeys: string[]
  message: string
}

function lockKey(key: string, id: number): string {
  return `${key}:${id}`
}

function findIndex(rows: EntryRow[], id: number): number {
  return rows.findIndex((row) => Number(row.id) === id)
}

/** 纯准备阶段：只做校验、组装草稿，不碰缓存与 localStorage；任何一条不过就整体不提交。 */
function prepareAction(
  meta: ModuleMeta,
  id: number,
  action: string,
  patch: ActionPatch = {},
): PreparedAction {
  const target = meta.actionTargets[action]
  if (!target) {
    throw new Error(`${meta.entity}没有登记「${action}」这个动作`)
  }
  const rows = listRows(meta.key).map((row) => ({ ...row }))
  const index = findIndex(rows, id)
  if (index < 0) {
    throw new Error(`没有找到编号为 ${id} 的${meta.entity}`)
  }
  const current = String(rows[index].status)
  if (current === target) {
    throw new Error(`${meta.entity}已经是「${target}」，不用重复操作`)
  }
  const sources = meta.actionSources?.[action]
  if (sources && !sources.includes(current)) {
    // 逾期未改等历史终态会一直命中这里，当时的结论不被改写。
    throw new Error(`${meta.entity}当前为「${current}」，不能执行「${action}」`)
  }

  const fieldPatch: ActionPatch = {}
  if (meta.key === RECTIFICATION_KEY) {
    const flow = RECT_FLOW[action]
    if (!flow) {
      throw new Error(`整改任务不支持「${action}」`)
    }
    fieldPatch[flow.timeField] = nowText()
    if (action === '确认复核') {
      const reviewer = String(patch.复核人 ?? '').trim()
      if (!reviewer) {
        throw new Error('请填写复核人后再确认复核')
      }
      fieldPatch.复核人 = reviewer
      fieldPatch.复核结论 = String(patch.复核结论 ?? '').trim() || '复核通过'
    }
  }
  if (meta.key === ACCEPTANCE_KEY && action === '要求整改') {
    fieldPatch.要求整改时间 = nowText()
  }

  const becomesAbnormal = NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb))
  rows[index] = {
    ...rows[index],
    ...fieldPatch,
    status: target,
    pending: isPendingStatus(meta, target),
    abnormal: becomesAbnormal,
  }

  const drafts: Record<string, EntryRow[]> = { [meta.key]: rows }
  const lockKeys = [lockKey(meta.key, id)]
  let message = `${meta.entity}已${action}，当前状态「${target}」`

  if (meta.key === ACCEPTANCE_KEY && action === '要求整改') {
    const deadline = String(patch.整改期限 ?? '').trim()
    const result = applyRequirementToRectification(rows[index], deadline)
    if (result) {
      drafts[RECTIFICATION_KEY] = result.draft
      lockKeys.push(...result.lockKeys)
      message += result.note
    }
  }
  if (meta.key === RECTIFICATION_KEY) {
    const result = syncAcceptanceAfterReview(rows, rows[index])
    if (result) {
      drafts[ACCEPTANCE_KEY] = result.draft
      lockKeys.push(lockKey(ACCEPTANCE_KEY, result.acceptanceId))
      message += result.note
    }
  }

  return { drafts, lockKeys, message }
}

/** 验收单要求整改：把整改期限写回到同验收编号、仍在流程中的整改任务，逾期历史记录不动。 */
function applyRequirementToRectification(
  acceptanceRow: EntryRow,
  deadline: string,
): { draft: EntryRow[]; lockKeys: string[]; note: string } | null {
  const code = String(acceptanceRow[LINK_FIELD] ?? '')
  const rectRows = listRows(RECTIFICATION_KEY).map((row) => ({ ...row }))
  const lockKeys: string[] = []
  let written = 0
  for (const row of rectRows) {
    const linked = code !== '' && String(row[LINK_FIELD] ?? '') === code
    const inFlow = RECT_PENDING_STATUSES.includes(String(row.status))
    if (linked && inFlow && deadline) {
      row.整改期限 = deadline
      written += 1
    }
    if (linked && inFlow) {
      lockKeys.push(lockKey(RECTIFICATION_KEY, Number(row.id)))
    }
  }
  const note = deadline
    ? `，整改期限已写回 ${written} 条整改任务`
    : ''
  return { draft: rectRows, lockKeys, note }
}

/**
 * 确认复核后按关联口径回写验收单：
 * 同一验收编号下的整改任务全部已复核，验收单才从需整改回到验收中；
 * 只要还有在办或逾期未改的任务，验收单保持需整改，列表与详情看到的都是同一结论。
 */
function syncAcceptanceAfterReview(
  rectRows: EntryRow[],
  updated: EntryRow,
): { draft: EntryRow[]; acceptanceId: number; note: string } | null {
  const code = String(updated[LINK_FIELD] ?? '')
  if (!code) {
    return null
  }
  const linked = rectRows.filter((row) => String(row[LINK_FIELD] ?? '') === code)
  if (!linked.every((row) => String(row.status) === '已复核')) {
    return null
  }
  const acceptanceRows = listRows(ACCEPTANCE_KEY).map((row) => ({ ...row }))
  const index = acceptanceRows.findIndex(
    (row) => String(row[LINK_FIELD] ?? '') === code && String(row.status) === '需整改',
  )
  if (index < 0) {
    return null
  }
  acceptanceRows[index] = {
    ...acceptanceRows[index],
    status: '验收中',
    pending: isPendingStatus(moduleMeta(ACCEPTANCE_KEY), '验收中'),
  }
  return { draft: acceptanceRows, acceptanceId: Number(acceptanceRows[index].id), note: '，关联验收单已转回验收中' }
}

/** 同步事务入口：准备 + 一次落库，准备阶段任何校验失败都不会写入，天然整体回退。 */
export function runAction(key: string, id: number, action: string, patch: ActionPatch = {}): ActionResult {
  const meta = moduleMeta(key)
  try {
    const prepared = prepareAction(meta, id, action, patch)
    commitAll(prepared.drafts)
    return { ok: true, message: prepared.message }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : `${meta.entity}操作失败，已整体回退`,
    }
  }
}

// 行级在途锁：并发提交同一行（含跨模块关联行）时只放第一个动作进去。
const inflight = new Set<string>()
let actionChain: Promise<void> = Promise.resolve()

export function isActionInFlight(key: string, id: number): boolean {
  return inflight.has(lockKey(key, id))
}

/**
 * 并发安全的动作入口：先按锁键抢占（同一轮同步并发只有一个能抢到），
 * 再串行化到链路上重新读取最新状态并提交，后到的动作要么被锁挡住，要么被状态机挡住；
 * 任何失败都不产生半成品写入。
 */
export function submitAction(
  key: string,
  id: number,
  action: string,
  patch: ActionPatch = {},
): Promise<ActionResult> {
  const meta = moduleMeta(key)
  let prepared: PreparedAction
  try {
    prepared = prepareAction(meta, id, action, patch)
  } catch (error) {
    return Promise.resolve({
      ok: false,
      message: error instanceof Error ? error.message : `${meta.entity}操作失败，已整体回退`,
    })
  }
  const blockedBy = prepared.lockKeys.find((entry) => inflight.has(entry))
  if (blockedBy) {
    return Promise.resolve({ ok: false, message: '该记录正在处理中，请勿重复提交' })
  }
  prepared.lockKeys.forEach((entry) => inflight.add(entry))
  const task = actionChain.then((): ActionResult => {
    try {
      // 锁内按最新数据重新准备一次：上一个动作已改状态时由状态机拒绝重复推进。
      const latest = prepareAction(meta, id, action, patch)
      commitAll(latest.drafts)
      return { ok: true, message: latest.message }
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : `${meta.entity}操作失败，已整体回退`,
      }
    } finally {
      prepared.lockKeys.forEach((entry) => inflight.delete(entry))
    }
  })
  actionChain = task.then(
    () => undefined,
    () => undefined,
  )
  return task
}

/** 验收详情：按验收编号取关联整改任务，验收页与整改详情页共用这一个关联口径。 */
export function linkedRectifications(acceptanceCode: string): EntryRow[] {
  if (!acceptanceCode) {
    return []
  }
  return listRows(RECTIFICATION_KEY).filter(
    (row) => String(row[LINK_FIELD] ?? '') === acceptanceCode,
  )
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => isPendingStatus(meta, String(row.status))).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
