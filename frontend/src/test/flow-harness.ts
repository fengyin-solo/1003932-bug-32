/* eslint-disable no-console */
import { __resetCacheForTest, allRows, listRows, saveRows } from '@/data/local-store'
import { SEED_ROWS } from '@/data/seed'
import {
  RECT_KEY,
  derivedAcceptStatus,
  listAcceptanceRows,
  migrateRectificationData,
  runRectAction,
  tasksByAcceptance,
  __resetBusy,
} from '@/data/rectification-flow'
import { migrateAcceptanceData, runAcceptAction } from '@/data/acceptance-flow'

let passed = 0
let failed = 0

function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name} ${extra}`)
  }
}

function seedFresh() {
  localStorage.clear()
  __resetCacheForTest()
  saveRows(RECT_KEY, JSON.parse(JSON.stringify(SEED_ROWS[RECT_KEY])))
  saveRows('acceptance', JSON.parse(JSON.stringify(SEED_ROWS.acceptance)))
  migrateRectificationData()
  migrateAcceptanceData()
  __resetBusy()
}

async function expectFail(name: string, p: Promise<{ ok: boolean }>) {
  const r = await p
  check(name, r.ok === false, JSON.stringify(r))
}

export async function run() {
  console.log('1) 顺序推进：待整改→整改中→已整改→已复核，字段同事务写回')
  seedFresh()
  let task = tasksByAcceptance('ACCE-0003')[0] // RECT-0001 待整改
  check('初始为待整改', String(task.status) === '待整改')
  let r = await runRectAction(task.id as number, '开始整改', { 整改期限: '2026-11-01', 整改措施: '清孔' })
  check('开始整改成功', r.ok, r.message)
  task = listRows(RECT_KEY).find((x) => x.id === task.id)!
  check('状态变整改中', String(task.status) === '整改中')
  check('期限已写回', String(task.整改期限) === '2026-11-01')
  check('措施已写回', String(task.整改措施) === '清孔')
  check('镜像状态同步', String(task.整改状态) === '整改中')
  check('时间线恰好追加一条', (task.timeline ?? []).length === 2)

  await expectFail(
    '缺复核人时提交复核被拒',
    runRectAction(task.id as number, '提交复核', { 复核人: '' }),
  )
  r = await runRectAction(task.id as number, '提交复核', { 复核人: '王复核' })
  check('提交复核成功', r.ok, r.message)
  task = listRows(RECT_KEY).find((x) => x.id === task.id)!
  check('状态变已整改（待复核）', String(task.status) === '已整改')
  check('复核人已写回', String(task.复核人) === '王复核')

  // 模拟刷新：丢弃内存缓存强制从 localStorage 重新播种，验证写回内容不丢
  __resetCacheForTest()
  const persistedTask = allRows().rectification.find((x) => x.id === task.id)!
  check('刷新后期限仍在', String(persistedTask.整改期限) === '2026-11-01')
  check('刷新后复核人仍在', String(persistedTask.复核人) === '王复核')
  check('刷新后状态仍为已整改', String(persistedTask.status) === '已整改')

  await expectFail(
    '缺复核结论时确认复核被拒',
    runRectAction(task.id as number, '确认复核', { 复核结论: '' }),
  )
  r = await runRectAction(task.id as number, '确认复核', { 复核结论: '合格' })
  check('确认复核成功', r.ok, r.message)
  task = listRows(RECT_KEY).find((x) => x.id === task.id)!
  check('状态变已复核', String(task.status) === '已复核')
  check('复核结论写回', String(task.复核结论) === '合格')
  const timelineLen = (task.timeline ?? []).length
  r = await runRectAction(task.id as number, '确认复核', { 复核结论: '又一条' })
  check('重复复核被拒', !r.ok, r.message)
  task = listRows(RECT_KEY).find((x) => x.id === task.id)!
  check('重复复核不追加结果', (task.timeline ?? []).length === timelineLen)
  check('原复核结论保留', String(task.复核结论) === '合格')

  console.log('2) 乱序动作被拒，状态不被改写')
  seedFresh()
  const waiting = tasksByAcceptance('ACCE-0003')[0]
  await expectFail(
    '待整改不能直接提交复核',
    runRectAction(waiting.id as number, '提交复核', { 复核人: '甲' }),
  )
  await expectFail(
    '待整改不能直接确认复核',
    runRectAction(waiting.id as number, '确认复核', { 复核结论: 'x' }),
  )
  check('状态仍是待整改', String(listRows(RECT_KEY).find((x) => x.id === waiting.id)!.status) === '待整改')

  console.log('3) 历史逾期未改冻结：任何动作拒绝，结论保留')
  seedFresh()
  const overdue = listRows(RECT_KEY).find((x) => String(x.status) === '逾期未改')!
  for (const action of ['开始整改', '提交复核', '确认复核']) {
    await expectFail(`逾期任务拒绝「${action}」`, runRectAction(overdue.id as number, action, {
      整改期限: '2026-12-01',
      复核人: '甲',
      复核结论: 'x',
    }))
  }
  check('逾期状态保留', String(listRows(RECT_KEY).find((x) => x.id === overdue.id)!.status) === '逾期未改')
  const overdueAccept = listAcceptanceRows().find((x) => x.验收编号 === 'ACCE-0007')!
  check('逾期验收派生为逾期未改', derivedAcceptStatus(overdueAccept) === '逾期未改')
  await expectFail(
    '逾期验收不能确认通过',
    runAcceptAction(overdueAccept.id as number, '确认通过', { 验收结论: '通过' }),
  )
  await expectFail(
    '逾期验收不能再下发整改',
    runAcceptAction(overdueAccept.id as number, '要求整改', {
      整改内容: 'x',
      责任单位: 'y',
      整改期限: '2026-12-01',
    }),
  )

  console.log('4) 验收联动：提交复核后不再显示需整改，全部复核后才允许通过')
  seedFresh()
  const accept4 = () => listAcceptanceRows().find((x) => x.验收编号 === 'ACCE-0004')!
  check('ACCE-0004 初始需整改（1整改中+1待复核）', derivedAcceptStatus(accept4()) === '需整改')
  const t2 = tasksByAcceptance('ACCE-0004').find((x) => String(x.status) === '整改中')!
  await runRectAction(t2.id as number, '提交复核', { 复核人: '周监测' })
  check('一项提交复核后派生为复核中（不再是需整改）', derivedAcceptStatus(accept4()) === '复核中')
  check('验收镜像已回写落库', String(accept4().验收状态) === '复核中')
  await expectFail(
    '复核中确认通过被拒',
    runAcceptAction(accept4().id as number, '确认通过', { 验收结论: '通过' }),
  )
  // ACCE-0004 的两项此时都处于「已整改（待复核）」，逐行取最新状态分别确认
  const pendingTasks = tasksByAcceptance('ACCE-0004').filter((x) => String(x.status) === '已整改')
  check('两项均已提交待复核', pendingTasks.length === 2, String(pendingTasks.length))
  for (const t of pendingTasks) {
    const rr = await runRectAction(t.id as number, '确认复核', { 复核结论: '合格' })
    check(`任务 ${String(t.任务编号)} 复核成功`, rr.ok, rr.message)
  }
  check('两项均复核后派生复核通过', derivedAcceptStatus(accept4()) === '复核通过')
  const rPass = await runAcceptAction(accept4().id as number, '确认通过', { 验收结论: '同意通过' })
  check('复核通过后验收可确认', rPass.ok, rPass.message)
  check('验收最终为验收通过', String(listAcceptanceRows().find((x) => x.验收编号 === 'ACCE-0004')!.status) === '验收通过')

  console.log('5) 并发提交：同一时刻只允许一个动作成功')
  seedFresh()
  const target = tasksByAcceptance('ACCE-0003')[0]
  __resetBusy()
  const slow = runRectAction(target.id as number, '开始整改', { 整改期限: '2026-11-01' })
  // 微任务队列中立即再发一个（锁在 await 边界已持有）
  const concurrent = runRectAction(target.id as number, '提交复核', { 复核人: '甲' })
  const [a, b] = await Promise.all([slow, concurrent])
  check('两个并发动作恰好一个成功', Number(a.ok) + Number(b.ok) === 1, `${a.ok}/${b.ok}`)
  const after = listRows(RECT_KEY).find((x) => x.id === target.id)!
  check('任务停在第一个动作的结果（整改中）', String(after.status) === '整改中')

  console.log('6) 失败整体回退：校验失败时验收回写也不会发生')
  seedFresh()
  const accept5Before = listAcceptanceRows().find((x) => x.验收编号 === 'ACCE-0005')!
  const mirrorBefore = String(accept5Before.验收状态)
  const reviewedTask = tasksByAcceptance('ACCE-0005')[0]
  await expectFail(
    '已复核任务再提交复核失败',
    runRectAction(reviewedTask.id as number, '提交复核', { 复核人: '乙' }),
  )
  const accept5After = listAcceptanceRows().find((x) => x.验收编号 === 'ACCE-0005')!
  check('验收镜像未被破坏', String(accept5After.验收状态) === mirrorBefore)
  check('整改任务无追加', (reviewedTask.timeline ?? []).length === 4)

  console.log('7) 迁移归一：旧占位数据对齐口径且不丢历史结论')
  localStorage.clear()
  __resetCacheForTest()
  saveRows(RECT_KEY, [
    {
      id: 99,
      status: '已整改',
      pending: false,
      abnormal: true,
      任务编号: 'RECT-0099',
      验收编号: 'ACCE-X1',
      整改期限: '2026-09-09',
      复核人: '',
      整改状态: '占位旧文案',
    } as never,
    {
      id: 100,
      status: '逾期未改',
      pending: true,
      abnormal: false,
      任务编号: 'RECT-0100',
      验收编号: 'ACCE-X2',
      整改状态: '占位旧文案',
    } as never,
  ])
  migrateRectificationData()
  const migrated = listRows(RECT_KEY)
  const m99 = migrated.find((x) => x.id === 99)!
  const m100 = migrated.find((x) => x.id === 100)!
  check('普通任务镜像对齐', String(m99.整改状态) === '已整改' && m99.pending === true && m99.abnormal === false)
  check('逾期任务结论冻结且口径修正', String(m100.整改状态) === '逾期未改' && m100.pending === false && m100.abnormal === true)
  check('缺失时间线补齐留痕', (m99.timeline ?? []).length === 1)

  console.log('8) 跨模块并发：整改与验收动作共用一把锁，恰好一个成功')
  seedFresh()
  const rTarget = tasksByAcceptance('ACCE-0003')[0]
  const aTarget = listAcceptanceRows().find((x) => x.验收编号 === 'ACCE-0001')! // 待验收
  const p1 = runRectAction(rTarget.id as number, '开始整改', { 整改期限: '2026-11-01' })
  const p2 = runAcceptAction(aTarget.id as number, '启动验收', {})
  const [c1, c2] = await Promise.all([p1, p2])
  check('整改/验收并发恰好一个成功', Number(c1.ok) + Number(c2.ok) === 1, `${c1.ok}/${c2.ok}`)

  console.log(`\n结果：${passed} 通过，${failed} 失败`)
  if (failed > 0) process.exitCode = 1
}
