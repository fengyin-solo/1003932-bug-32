import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'geohazard-monitor-prevention:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  commitAll({ [key]: rows })
}

/**
 * 多模块事务提交：一次替换多个模块的数据并只写一次 localStorage。
 * 写入失败时缓存与存储都保持提交前的样子，调用方据此整体回退。
 */
export function commitAll(drafts: Record<string, EntryRow[]>): void {
  const before = allRows()
  // 先深拷贝再改缓存，保证抛错时外部拿到的引用没有被半成品污染。
  const snapshot = clone(before)
  const next: Record<string, EntryRow[]> = { ...before }
  for (const [key, rows] of Object.entries(drafts)) {
    next[key] = clone(rows)
  }
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    }
    cache = next
  } catch (error) {
    cache = snapshot
    throw error instanceof Error ? error : new Error('数据写入失败，已回退到提交前状态')
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

/** 清空内存缓存，下次读取重新从 localStorage 播种（模拟页面刷新）。 */
export function resetCache(): void {
  cache = null
}
