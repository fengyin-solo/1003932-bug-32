/**
 * 领域逻辑验证脚本：node scripts/verify-flow.mjs（内部用 esbuild 临时打包 TS）。
 * 覆盖：顺序推进、乱序拒绝、字段写回持久化、重复复核幂等、并发只有一个成功、
 * 失败整体回退、验收联动派生、历史逾期冻结。
 */
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { writeFileSync, rmSync } from 'node:fs'

// 内存版 localStorage（数据层用 window.localStorage，node 下把 window 指向全局）
const mem = new Map()
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => void mem.set(k, String(v)),
  removeItem: (k) => void mem.delete(k),
  clear: () => mem.clear(),
}
globalThis.window = globalThis

const result = await build({
  entryPoints: ['src/test/flow-harness.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  alias: { '@': new URL('../src/', import.meta.url).pathname },
})
const outPath = new URL('../.tmp-flow-test.mjs', import.meta.url)
writeFileSync(outPath, result.outputFiles[0].text)

const harness = await import(pathToFileURL(outPath.pathname).href)
await harness.run()
rmSync(outPath, { force: true })
