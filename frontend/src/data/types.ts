/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  /** 动作允许的源状态：状态机的唯一口径，不配置则沿用旧的「目标不同即可」行为。 */
  actionSources?: Record<string, string[]>
  /** 终态：进入后不再允许任何动作，pending 也按终态判定。 */
  finalStatuses?: string[]
  metrics: string[]
}

/** 动作执行时需要一并写回行数据的字段（如整改期限、复核人），与状态变更同事务提交。 */
export type ActionPatch = Record<string, string | number | boolean>

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
