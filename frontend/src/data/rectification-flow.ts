import {
  listRows,
  restoreRows,
  saveRows,
  snapshotRows,
} from './local-store'
import type { ActionResult, EntryRow, FlowEvent } from './types'

/**
 * 整改跟踪领域：整改任务的状态、字段写入、与验收的联动，全部只走这一个模块，
 * 列表页、详情页、验收页不再各自判断「需不需要整改、是否已复核」。
 */

export const RECT_KEY = 'rectification'
export const ACCEPT_KEY = 'acceptance'

/** 唯一允许的推进口径：只能 待整改 → 整改中 → 已整改 → 已复核。 */
export const RECT_STATUSES = ['待整改', '整改中', '已整改', '已复核'] as const
export type RectStatus = (typeof RECT_STATUSES)[number]

/** 历史终态：逾期未改是当时的判定结论，冻结保留，不允许再推进。 */
export const RECT_FROZEN_STATUSES = ['逾期未改'] as const

export const RECT_ACTIONS = ['开始整改', '提交复核', '确认复核'] as const
const REQUIRED_STATUS: Record<string, RectStatus> = {
  开始整改: '待整改',
  提交复核: '整改中',
  确认复核: '已整改',
}

/** 验收页面看到的派生状态（验收状态列只展示这个，绝不自行判断）。 */
export const ACCEPT_DERIVED_STATUSES = [
  '待验收',
  '验收中',
  '需整改',
  '复核通过',
  '验收通过',
] as const

export type RectActionInput = {
  整改期限?: string
  整改措施?: string
  复核人?: string
  复核结论?: string
}

/** 串行化提交：整改/验收两个模块共用同一把锁，同一时刻只允许一个动作进入。 */
let inflight = false

export function isBusy(): boolean {
  return inflight
}

/**
 * 跨模块原子动作：先抢锁、快照整库，执行期间任一环节抛错，
 * 都恢复快照（整改任务 + 验收回写一起回退），不存在半截写入；
 * 业务校验失败返回 { ok: false }（此时尚未写入或已在内部恢复），同样不占用结果。
 */
export async function commitFlow(
  keys: string[],
  mutate: () => ActionResult | Promise<ActionResult>,
): Promise<ActionResult> {
  if (inflight) {
    return { ok: false, message: '有整改/验收动作正在提交，请稍后再试' }
  }
  inflight = true
  const snapshot = snapshotRows()
  try {
    const result = await mutate()
    if (!result.ok) restoreRows(snapshot, keys)
    return result
  } catch (error) {
    restoreRows(snapshot, keys)
    return { ok: false, message: error instanceof Error ? error.message : '操作失败，已整体回退' }
  } finally {
    inflight = false
  }
}

function nowText(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function rectPending(status: string): boolean {
  return status === '待整改' || status === '整改中' || status === '已整改'
}

function rectAbnormal(status: string): boolean {
  return RECT_FROZEN_STATUSES.includes(status as never)
}

/** 每个状态在页面上唯一可执行的动作；已复核/逾期未改没有后续动作。 */
export function nextAction(status: string): string | null {
  if (status === '待整改') return '开始整改'
  if (status === '整改中') return '提交复核'
  if (status === '已整改') return '确认复核'
  return null
}

export function listRectTasks(): EntryRow[] {
  return listRows(RECT_KEY)
}

export function findRectTask(id: number): EntryRow | undefined {
  return listRows(RECT_KEY).find((row) => Number(row.id) === id)
}

/** 按验收编号关联整改任务，验收页只通过这里取关联口径。 */
export function tasksByAcceptance(acceptanceNo: string): EntryRow[] {
  return listRows(RECT_KEY).filter((row) => String(row.验收编号 ?? '') === acceptanceNo)
}

export type AcceptProgress = {
  total: number
  reviewed: number
  submitting: number
  working: number
  waiting: number
  overdue: boolean
}

export function rectProgress(acceptanceNo: string): AcceptProgress {
  const tasks = tasksByAcceptance(acceptanceNo)
  const count = (s: string) => tasks.filter((t) => String(t.status) === s).length
  return {
    total: tasks.length,
    reviewed: count('已复核'),
    submitting: count('已整改'),
    working: count('整改中'),
    waiting: count('待整改'),
    overdue: tasks.some((t) => RECT_FROZEN_STATUSES.includes(String(t.status) as never)),
  }
}

/**
 * 验收状态的唯一派生口径：
 * 验收通过/已驳回（验收侧终态）原样保留；只要关联了整改任务，就按任务进度派生。
 * 历史逾期任务只作为异常提示，不回退已经通过的验收结论。
 */
export function derivedAcceptStatus(acceptance: EntryRow): string {
  const own = String(acceptance.status)
  if (own === '验收通过' || own === '已驳回') return own
  const progress = rectProgress(String(acceptance.验收编号 ?? ''))
  if (progress.total === 0) {
    // 无关联任务时以验收自身状态为准（待验收/验收中）
    return ACCEPT_DERIVED_STATUSES.includes(own as never) ? own : '待验收'
  }
  if (progress.overdue && progress.reviewed + progress.submitting + progress.working === 0) {
    return '逾期未改'
  }
  // 只要还有任务未提交复核，整改就没完成，验收仍是「需整改」；
  // 全部提交后进入「复核中」；全部复核通过才是「复核通过」。
  if (progress.waiting + progress.working > 0) return '需整改'
  if (progress.reviewed === progress.total) return '复核通过'
  return '复核中'
}

/** 把派生结论回写到验收行（验收状态镜像 + 待办/异常口径），保证刷新后不丢、不串口径。 */
function syncAcceptanceRow(row: EntryRow): EntryRow {
  const derived = derivedAcceptStatus(row)
  return {
    ...row,
    验收状态: derived,
    pending: derived !== '验收通过' && derived !== '已驳回' && derived !== '逾期未改',
    abnormal: derived === '逾期未改' || String(row.status) === '已驳回',
  }
}

export function listAcceptanceRows(): EntryRow[] {
  return listRows(ACCEPT_KEY).map(syncAcceptanceRow)
}

/**
 * 跨模块原子动作的内部实现见 commitFlow（串行锁 + 整库快照回退）。
 */

function fail(message: string): Promise<ActionResult> {
  return Promise.resolve({ ok: false, message })
}

/** 同步回写某一验收编号关联的验收行状态（与整改任务在同一事务内落库）。 */
function writeAcceptanceFor(acceptanceNo: string): void {
  const rows = listRows(ACCEPT_KEY)
  const next = rows.map((row) =>
    String(row.验收编号 ?? '') === acceptanceNo ? syncAcceptanceRow(row) : row,
  )
  saveRows(ACCEPT_KEY, next)
}

/**
 * 推进整改任务。唯一的整改写入口径：
 * - 只允许严格的前一状态触发对应动作，乱序/重复一律拒绝；
 * - 逾期未改是冻结的历史结论，任何动作都不接收；
 * - 期限在「开始整改」写入、复核人在「提交复核」写入、复核结论在「确认复核」写入，与状态同一事务落库；
 * - 成功恰好追加一条时间线，重复复核/失败不追加；
 * - 同一事务内回写关联验收，刷新后回显不丢。
 */
export async function runRectAction(
  id: number,
  action: string,
  input: RectActionInput = {},
  operator = '值班管理员',
): Promise<ActionResult> {
  if (inflight) {
    return fail('有整改/验收动作正在提交，请稍后再试')
  }
  const required = REQUIRED_STATUS[action]
  if (!required) {
    return fail(`整改任务没有登记「${action}」这个动作`)
  }
  // 推进口径只有一条直线：动作目标即当前状态在 RECT_STATUSES 中的下一个。
  const target = RECT_STATUSES[RECT_STATUSES.indexOf(required) + 1]
  const acceptanceNo = (() => {
    const row = findRectTask(id)
    return row ? String(row.验收编号 ?? '') : ''
  })()

  return commitFlow([RECT_KEY, ACCEPT_KEY], () => {
    const rows = listRows(RECT_KEY)
    const index = rows.findIndex((row) => Number(row.id) === id)
    if (index < 0) {
      return { ok: false, message: `没有找到编号为 ${id} 的整改任务` }
    }
    const current = rows[index]
    const status = String(current.status)

    if (RECT_FROZEN_STATUSES.includes(status as never)) {
      return {
        ok: false,
        message: `该任务已于 ${current.整改期限 || '当时'} 判定「${status}」，历史结论保留，不再推进`,
      }
    }
    if (status === '已复核') {
      return { ok: false, message: '该任务已复核，重复复核不追加结果' }
    }
    if (status !== required) {
      return {
        ok: false,
        message: `当前状态「${status}」不能执行「${action}」，需先处于「${required}」`,
      }
    }

    // 字段写入口径：与动作绑定的必填项在这里统一校验、统一落库。
    if (action === '开始整改' && !input.整改期限?.trim()) {
      return { ok: false, message: '开始整改前必须填写整改期限' }
    }
    if (action === '提交复核' && !input.复核人?.trim()) {
      return { ok: false, message: '提交复核前必须指定复核人' }
    }
    if (action === '确认复核' && !input.复核结论?.trim()) {
      return { ok: false, message: '确认复核必须填写复核结论' }
    }

    const timeline = Array.isArray(current.timeline) ? [...current.timeline] : []
    const noteParts: string[] = []
    const updated: EntryRow = { ...current, status: target }
    if (action === '开始整改') {
      updated.整改期限 = input.整改期限!.trim()
      if (input.整改措施?.trim()) updated.整改措施 = input.整改措施.trim()
      noteParts.push(`期限 ${updated.整改期限}`)
    }
    if (action === '提交复核') {
      updated.复核人 = input.复核人!.trim()
      if (input.整改措施?.trim()) updated.整改措施 = input.整改措施.trim()
      noteParts.push(`复核人：${updated.复核人}`)
    }
    if (action === '确认复核') {
      updated.复核结论 = input.复核结论!.trim()
      noteParts.push(updated.复核结论)
    }
    // 业务镜像字段与运行态状态同一口径写入，列表/详情不会再各看各的。
    updated.整改状态 = target
    updated.pending = rectPending(target)
    updated.abnormal = false

    const event: FlowEvent = {
      from: status,
      to: target,
      action,
      at: nowText(),
      operator,
      note: noteParts.join('；'),
    }
    timeline.push(event)
    updated.timeline = timeline

    const nextRows = [...rows]
    nextRows[index] = updated
    saveRows(RECT_KEY, nextRows)
    if (acceptanceNo) writeAcceptanceFor(acceptanceNo)

    return { ok: true, message: `整改任务已${action}，当前状态「${target}」` }
  })
}

/**
 * 旧数据一次性归一（幂等）：
 * 历史逾期记录冻结保留；其余任务只把镜像字段、待办/异常口径与状态对齐，
 * 缺时间线的补一条历史留痕，绝不改动当时结论。
 */
export function migrateRectificationData(): void {
  const rows = listRows(RECT_KEY)
  if (rows.length === 0) return
  let changed = false
  const next = rows.map((row) => {
    const status = String(row.status)
    const fixed: EntryRow = { ...row }
    if (RECT_STATUSES.includes(status as never) || RECT_FROZEN_STATUSES.includes(status as never)) {
      if (fixed.整改状态 !== status) {
        fixed.整改状态 = status
        changed = true
      }
      const pending = rectPending(status)
      const abnormal = rectAbnormal(status)
      if (fixed.pending !== pending || fixed.abnormal !== abnormal) {
        fixed.pending = pending
        fixed.abnormal = abnormal
        changed = true
      }
      if (!Array.isArray(fixed.timeline) || fixed.timeline.length === 0) {
        fixed.timeline = [
          {
            from: '验收需整改',
            to: status,
            action: status === '逾期未改' ? '逾期判定' : '历史数据迁移',
            at: '迁移前',
            operator: '系统',
            note: '历史记录迁移，保留当时结论',
          },
        ]
        changed = true
      }
    }
    return fixed
  })
  if (changed) saveRows(RECT_KEY, next)
}

/** 列表/详情/验收三处共用的状态徽标配色。 */
export function rectBadgeClass(status: string): string {
  switch (status) {
    case '待整改':
      return 'amber'
    case '整改中':
      return 'blue'
    case '已整改':
      return 'violet'
    case '已复核':
      return 'green'
    case '逾期未改':
      return 'red'
    default:
      return 'gray'
  }
}

export function acceptBadgeClass(derived: string): string {
  switch (derived) {
    case '待验收':
      return 'gray'
    case '验收中':
      return 'blue'
    case '需整改':
      return 'amber'
    case '复核中':
      return 'violet'
    case '复核通过':
      return 'green'
    case '验收通过':
      return 'green'
    case '已驳回':
      return 'red'
    case '逾期未改':
      return 'red'
    default:
      return 'gray'
  }
}

/** 整改列表的检索：只按业务列过滤，状态/时间线不参与文本匹配。 */
export function filterRectTasks(filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  return listRows(RECT_KEY).filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

/** 仅供测试/重置后联动：清空内存锁。 */
export function __resetBusy(): void {
  inflight = false
}
