// 播放队列管理测试：验证主列表（播放队列）的「上移/下移/移除」真的生效。
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

  const rows = () => [...doc.querySelectorAll('#songList .song-item')]
  const names = () => rows().map((li) => li.querySelector('.song-name').firstChild.textContent.trim())

  // 初始：3 首，顺序 AAA/BBB/CCC
  check('初始渲染 3 首', rows().length === 3)
  check('初始顺序 AAA/BBB/CCC', JSON.stringify(names()) === JSON.stringify(['AAA', 'BBB', 'CCC']))
  // 每行有 3 个队列控件（上移/下移/移除）
  check('每行有队列控件(3个)', rows().every((li) => li.querySelectorAll('.qbtn').length === 3))

  // 点第 2 行(BBB)的「上移」→ BBB 与 AAA 交换
  const btnUp = rows()[1].querySelector('[data-act="up"]')
  btnUp.click()
  await wait(50)
  check('BBB 上移后顺序 BBB/AAA/CCC', JSON.stringify(names()) === JSON.stringify(['BBB', 'AAA', 'CCC']))

  // 点第 3 行(CCC)的「下移」→ 越界不动
  rows()[2].querySelector('[data-act="down"]').click()
  await wait(50)
  check('末行下移不越界', JSON.stringify(names()) === JSON.stringify(['BBB', 'AAA', 'CCC']))

  // 点第 1 行(BBB)的「移除」→ 剩 AAA/CCC
  rows()[0].querySelector('[data-act="del"]').click()
  await wait(50)
  check('移除后剩 2 首', rows().length === 2)
  check('移除后顺序 AAA/CCC', JSON.stringify(names()) === JSON.stringify(['AAA', 'CCC']))

  const realErrs = errs.filter((m) => !/Not implemented/.test(m))
  check('无真实报错', realErrs.length === 0)
  if (realErrs.length) console.log('错误:', realErrs)
  console.log(ok ? 'QUEUE_OK' : 'QUEUE_FAIL')
  if (!ok) process.exitCode = 1
})().catch((e) => { console.error('TEST ERROR', e); process.exit(1) })
