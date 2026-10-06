/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  /** 状态流转时间线：整改模块用，每次成功推进恰好追加一条。 */
  timeline?: FlowEvent[]
  [field: string]: string | number | boolean | FlowEvent[] | undefined
}

/** 一次成功的状态流转留痕，重复/失败动作不追加。 */
export type FlowEvent = {
  from: string
  to: string
  action: string
  at: string
  operator: string
  note?: string
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
  metrics: string[]
}

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
