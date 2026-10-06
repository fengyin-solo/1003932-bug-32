// 整改链路验证：localStorage shim + 转译后的 data/api 层，覆盖状态机、写回持久化、关联回写、重复/并发/事务。
const esbuild = require('/workspace/frontend/node_modules/esbuild')
const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('assert')

const SRC = '/workspace/frontend/src'
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'rect-test-'))

esbuild.buildSync({
  entryPoints: ['scripts/test-entry.ts'],
  outfile: path.join(OUT, 'bundle.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  absWorkingDir: '/workspace/frontend',
  alias: { '@': SRC },
})

const store = new Map()
global.window = {
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => {
      if (store.get('__fail__')) throw new Error('disk full')
      store.set(k, String(v))
    },
    removeItem: (k) => store.delete(k),
  },
}

const bundle = require(path.join(OUT, 'bundle.js'))
const svc = bundle.service
const dataStore = bundle.store
const { listEntries, runAction, submitAction, linkedRectifications, getEntry, availableActions, moduleMeta } = svc

let passed = 0
function check(name, cond, extra) {
  assert.ok(cond, name + (extra ? ` -> ${extra}` : ''))
  passed += 1
  console.log(`  ✓ ${name}`)
}
function findByCode(key, code, field = '验收编号') {
  return listEntries(key).items.find((r) => String(r[field]) === code)
}
function findById(key, id) {
  return getEntry(key, id)
}

async function main() {
  const rectMeta = moduleMeta('rectification')

  // 初始播种：ACCE-0002 需整改，关联 3 条在办任务（待整改/整改中/已整改）
  const r1 = findByCode('rectification', 'RECT-0001', '任务编号')
  const r2 = findByCode('rectification', 'RECT-0002', '任务编号')
  const r3 = findByCode('rectification', 'RECT-0003', '任务编号')
  const acc2 = findByCode('acceptance', 'ACCE-0002')
  check('初始验收单为需整改', acc2.status === '需整改', acc2.status)
  check('任务1待整改', r1.status === '待整改')

  // 1. 状态机门控：非法跳转一律拒绝
  check('待整改不能确认复核', runAction('rectification', r1.id, '确认复核', { 复核人: '张三' }).ok === false)
  check('已整改任务不能重复开始整改', runAction('rectification', r3.id, '开始整改').ok === false)
  check('已复核历史任务无可用动作', availableActions(rectMeta, findById('rectification', 4)).length === 0)
  check('逾期未改历史任务无可用动作', availableActions(rectMeta, findById('rectification', 5)).length === 0)
  check('逾期记录复核人保持空（历史结论保留）', findById('rectification', 5).status === '逾期未改')

  // 2. 开始整改
  const a1 = runAction('rectification', r1.id, '开始整改')
  check('开始整改成功', a1.ok, a1.message)
  check('开始整改写入开始时间', !!findById('rectification', r1.id)['整改开始时间'])
  check('状态变整改中', findById('rectification', r1.id).status === '整改中')

  // 提交复核缺源状态校验：整改中才能提交
  check('待整改态已不存在重复提交问题', runAction('rectification', r1.id, '开始整改').ok === false)

  // 3. 提交复核（r1、r2 到已整改），此时验收单仍需整改
  check('提交复核 r1', runAction('rectification', r1.id, '提交复核').ok)
  check('提交复核 r2', runAction('rectification', r2.id, '提交复核').ok)
  check('两条复核提交后验收单仍为需整改', findByCode('acceptance', 'ACCE-0002').status === '需整改')

  // 4. 确认复核必须填复核人
  const noReviewer = runAction('rectification', r1.id, '确认复核', { 复核人: '' })
  check('复核人为空被拒绝且状态不变', noReviewer.ok === false && findById('rectification', r1.id).status === '已整改')
  check('复核人未被污染', findById('rectification', r1.id)['复核人'] === '')

  // 5. 先确认 r1、r2：验收单仍需整改（还有 r3 已复核？—— r3 初始就是已整改待复核）
  check('确认复核 r1', runAction('rectification', r1.id, '确认复核', { 复核人: '李四', 复核结论: '合格' }).ok)
  check('复核人写回持久化', findById('rectification', r1.id)['复核人'] === '李四')
  check('复核时间写回', !!findById('rectification', r1.id)['复核时间'])
  check('重复确认复核不追加结果', runAction('rectification', r1.id, '确认复核', { 复核人: '王五' }).ok === false)
  check('首次复核人不被覆盖', findById('rectification', r1.id)['复核人'] === '李四')
  check('r2 确认复核', runAction('rectification', r2.id, '确认复核', { 复核人: '李四' }).ok)
  check('两条已复核时验收单仍需整改（r3 未复核）', findByCode('acceptance', 'ACCE-0002').status === '需整改')

  // 6. 最后一条 r3 确认复核：验收单同事务回到验收中
  const a3 = runAction('rectification', r3.id, '确认复核', { 复核人: '赵六' })
  check('最后一条复核成功', a3.ok, a3.message)
  check('验收单自动转回验收中', findByCode('acceptance', 'ACCE-0002').status === '验收中', findByCode('acceptance', 'ACCE-0002').status)
  check('关联查询口径一致：3条全已复核', linkedRectifications('ACCE-0002').every((r) => r.status === '已复核'))

  // 7. 验收中再次确认通过
  check('验收单确认通过', runAction('acceptance', acc2.id, '确认通过').ok)
  check('通过后不能再要求整改', runAction('acceptance', acc2.id, '要求整改', { 整改期限: '2026-12-01' }).ok === false)

  // 8. 期限写回验证：重置数据，把一条待整改任务关联到 ACCE-0001，启动验收并要求整改。
  store.clear()
  dataStore.resetCache()
  const rows2 = dataStore.listRows('rectification').map((r) => ({ ...r }))
  rows2[0]['验收编号'] = 'ACCE-0001'
  rows2[0].status = '待整改'
  dataStore.saveRows('rectification', rows2)
  const acc1b = svc.listEntries('acceptance').items.find((r) => r['验收编号'] === 'ACCE-0001')
  svc.runAction('acceptance', acc1b.id, '启动验收')
  const writeBack = svc.runAction('acceptance', acc1b.id, '要求整改', { 整改期限: '2027-01-15' })
  check('要求整改带期限成功', writeBack.ok, writeBack.message)
  const reloadedRaw = JSON.parse(store.get('geohazard-monitor-prevention:entries'))
  check('整改期限已写回并落 localStorage', reloadedRaw.rectification[0]['整改期限'] === '2027-01-15', reloadedRaw.rectification[0]['整改期限'])
  check('逾期历史记录期限不被覆盖', reloadedRaw.rectification[4]['整改期限'] === '2026-07-15')

  // 9. 刷新回显：缓存置空后重新读取（等价于刷新页面后从 localStorage 播种）
  dataStore.resetCache()
  check('刷新后期限回显不丢', svc.listEntries('rectification').items[0]['整改期限'] === '2027-01-15')

  // 10. 并发提交：同一行两个提交复核同时发出，只允许一个成功
  store.clear()
  dataStore.resetCache()
  const t1 = getEntry('rectification', 1)
  runAction('rectification', t1.id, '开始整改') // 置为整改中
  const [c1, c2] = await Promise.all([
    submitAction('rectification', t1.id, '提交复核'),
    submitAction('rectification', t1.id, '提交复核'),
  ])
  const oks = [c1, c2].filter((r) => r.ok).length
  check('并发提交只有一个成功', oks === 1, `c1=${c1.ok}/${c1.message} c2=${c2.ok}/${c2.message}`)
  check('状态只推进一格为已整改', getEntry('rectification', t1.id).status === '已整改')

  // 11. 事务整体回退：写入磁盘失败时，跨模块联动不改任何状态
  // 先把 r1、r2 推到已复核，让 r3 的确认本应联动验收单回验收中，再令落库失败。
  runAction('rectification', 1, '开始整改')
  runAction('rectification', 1, '提交复核')
  runAction('rectification', 1, '确认复核', { 复核人: '李四' })
  runAction('rectification', 2, '提交复核')
  runAction('rectification', 2, '确认复核', { 复核人: '李四' })
  const before3 = getEntry('rectification', 3)
  const beforeAcc = listEntries('acceptance').items.find((r) => r['验收编号'] === 'ACCE-0002')
  const beforeAccStatus = beforeAcc.status
  check('回退前提：验收单此时仍需整改', beforeAccStatus === '需整改', beforeAccStatus)
  store.set('__fail__', '1')
  const failed = runAction('rectification', 3, '确认复核', { 复核人: '钱七' })
  check('落库失败时动作返回失败', failed.ok === false, failed.message)
  check('整改任务状态整体回退', getEntry('rectification', 3).status === before3.status)
  check('验收单状态整体回退', listEntries('acceptance').items.find((r) => r['验收编号'] === 'ACCE-0002').status === beforeAccStatus)
  check('复核人未半写入', (getEntry('rectification', 3)['复核人'] || '') === '')
  store.delete('__fail__')

  console.log(`\n全部 ${passed} 项断言通过`)
}

main().catch((e) => {
  console.error('测试失败:', e.message)
  process.exit(1)
})
