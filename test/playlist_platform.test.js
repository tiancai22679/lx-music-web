const fs = require('fs')
const path = require('path')
const { JSDOM, VirtualConsole } = require('jsdom')
const root = path.join(__dirname, '..')
const html = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '')
const appjs = fs.readFileSync(path.join(root, 'web/app.js'), 'utf8')
const vc = new VirtualConsole()
const errs = []
vc.on('jsdomError', (e) => errs.push(e.message || String(e)))
const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc, url: 'http://localhost/' })
const { window } = dom
window.AbortController = AbortController
const reqs = []
window.fetch = (url) => {
  reqs.push(url)
  let body = {}
  if (url.includes('/api/boards')) body = { boards: [{ id: '3778678', name: '热歌榜' }] }
  else if (url.includes('/api/playlists')) body = { playlists: [{ id: '999', name: '测试歌单A', cover: '', playCount: 123, creator: 'me' }] }
  else if (url.includes('/api/playlist')) body = { list: [{ id: '1', name: '歌A', singer: 's', cover: '', duration: '3:00' }], source: 'ny', note: '' }
  else if (url.includes('/api/hot')) body = { list: [{ id: '1', name: '歌A', singer: 's', cover: '', duration: '3:00' }] }
  else if (url.includes('/api/lyric')) body = { lyric: '' }
  else if (url.includes('/api/sources')) body = { sources: [{ id: 'ny', name: '网易云音乐', type: 'native', actions: ['musicUrl'] }] }
  else if (url.includes('/api/song')) body = { url: 'https://x/a.mp3', via: 'ny', sourceName: '网易云' }
  else body = {}
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
;(async () => {
  try { window.eval(appjs) } catch (e) { console.log('EVAL THREW', e.message); process.exit(1) }
  const doc = window.document
  await wait(300)
  // 切到歌单 tab
  doc.getElementById('tabPlaylist').click()
  await wait(300)
  const sel = doc.getElementById('playlistPlatSelect')
  const note = doc.getElementById('playlistPlatNote')

  // 默认网易云：不应显示受限提示
  const defaultNy = reqs.find((u) => u.includes('/api/playlists') && u.includes('platform=ny')) || reqs.find((u) => u.includes('/api/playlists'))
  console.log('默认网易云歌单请求:', defaultNy)
  console.log('默认网易云不显示受限提示:', note.classList.contains('hidden') ? 'OK' : 'FAIL')
  const nyHasPlat = defaultNy.includes('platform=ny') || !defaultNy.includes('platform=')
  console.log('默认请求带 platform=ny:', nyHasPlat ? 'OK' : 'FAIL')

  // 切到 QQ 音乐
  reqs.length = 0
  sel.value = 'tx'
  sel.dispatchEvent(new window.Event('change'))
  await wait(300)
  const txReq = reqs.find((u) => u.includes('/api/playlists') && u.includes('platform=tx')) || ''
  console.log('切 QQ 后歌单请求:', txReq)
  console.log('切 QQ 触发 /api/playlists?platform=tx:', txReq ? 'OK' : 'FAIL')
  console.log('切 QQ 显示受限提示:', !note.classList.contains('hidden') && /QQ音乐/.test(note.textContent) ? 'OK' : 'FAIL')

  // 切到酷狗
  reqs.length = 0
  sel.value = 'kg'
  sel.dispatchEvent(new window.Event('change'))
  await wait(300)
  const kgReq = reqs.find((u) => u.includes('/api/playlists') && u.includes('platform=kg')) || ''
  console.log('切酷狗后歌单请求:', kgReq)
  console.log('切酷狗触发 /api/playlists?platform=kg:', kgReq ? 'OK' : 'FAIL')
  console.log('切酷狗显示受限提示含“酷狗”:', !note.classList.contains('hidden') && /酷狗/.test(note.textContent) ? 'OK' : 'FAIL')

  // 切回网易云：提示应消失
  sel.value = 'ny'
  sel.dispatchEvent(new window.Event('change'))
  await wait(300)
  console.log('切回网易云隐藏提示:', note.classList.contains('hidden') ? 'OK' : 'FAIL')

  const realErrs = errs.filter((m) => !/Not implemented/.test(m))
  console.log('错误:', realErrs)
  const ok = txReq && kgReq && note.textContent && realErrs.length === 0
  console.log(ok ? 'PLAYLIST_PLATFORM_OK' : 'PLAYLIST_PLATFORM_FAIL')
  if (!ok) process.exitCode = 1
})().catch((e) => { console.error('TEST ERROR', e); process.exit(1) })
