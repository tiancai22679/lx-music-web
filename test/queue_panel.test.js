// 播放列表面板测试：验证「播放列表」按钮能从播放器打开队列面板，
// 面板里能显示当前队列、管理顺序，并点击切歌。
const fs = require('fs')
const path = require('path')
const { JSDOM, VirtualConsole } = require('jsdom')

const root = path.join(__dirname, '..')
const html = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '')
const appjs = fs.readFileSync(path.join(root, 'web/app.js'), 'utf8')

const errs = []
const vc = new VirtualConsole()
vc.on('jsdomError', (e) => errs.push(e.message || String(e)))
const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc, url: 'http://localhost/' })
const { window } = dom
window.AbortController = AbortController
window.fetch = (url) => {
  let body = {}
  if (url.includes('/api/boards')) body = { boards: [{ id: '16', name: '热歌榜' }] }
  else if (url.includes('/api/hot')) body = {
    list: [
      { id: '1', name: 'AAA', singer: 'a', cover: '', duration: '1:00' },
      { id: '2', name: 'BBB', singer: 'b', cover: '', duration: '2:00' },
      { id: '3', name: 'CCC', singer: 'c', cover: '', duration: '3:00' },
    ],
  }
  else if (url.includes('/api/lyric')) body = { lyric: '' }
  else if (url.includes('/api/sources')) body = { sources: [{ id: 'ny', name: '网易云', type: 'native', actions: ['musicUrl'] }] }
  else if (url.includes('/api/song')) body = { url: 'https://x/a.mp3', via: 'ny', sourceName: '网易' }
  else body = {}
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
;(async () => {
  try { window.eval(appjs) } catch (e) { console.log('EVAL THREW', e.message); process.exit(1) }
  const doc = window.document
  await wait(400)
  let ok = true
  const check = (label, cond) => { console.log(label + ':', cond ? 'OK' : 'FAIL'); if (!cond) ok = false }

  const qPanel = doc.getElementById('queuePanel')
  const qList = doc.getElementById('queueList')
  const openBtn = doc.getElementById('playerQueueBtn')
  check('播放列表按钮存在', !!openBtn)
  check('面板初始隐藏', qPanel.classList.contains('hidden'))

  // 打开面板：应渲染 3 首且带队列控件
  openBtn.click()
  await wait(50)
  check('点击后面板显示', !qPanel.classList.contains('hidden'))
  const rows = () => [...qList.querySelectorAll('.song-item')]
  check('面板渲染 3 首', rows().length === 3)
  check('面板每行有队列控件', rows().every((li) => li.querySelectorAll('.qbtn').length === 3))

  // 点击第 2 行(BBB)切歌 → 当前播放高亮切到该行
  rows()[1].click()
  await wait(50)
  check('点击行后高亮该行', rows()[1].classList.contains('playing'))

  // 关闭面板
  doc.getElementById('queueClose').click()
  await wait(20)
  check('关闭后面板隐藏', qPanel.classList.contains('hidden'))

  const realErrs = errs.filter((m) => !/Not implemented/.test(m))
  check('无真实报错', realErrs.length === 0)
  if (realErrs.length) console.log('错误:', realErrs)
  console.log(ok ? 'QUEUE_PANEL_OK' : 'QUEUE_PANEL_FAIL')
  if (!ok) process.exitCode = 1
})().catch((e) => { console.error('TEST ERROR', e); process.exit(1) })
