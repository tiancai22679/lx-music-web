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
  if (url.includes('/api/boards')) body = { boards: [{ id: '3778678', name: '热歌榜' }, { id: '19723756', name: '飙升榜' }] }
  else if (url.includes('/api/playlists')) body = { playlists: [{ id: '999', name: '测试歌单A', cover: 'http://x/a.jpg', playCount: 12345, creator: 'me' }, { id: '888', name: '测试歌单B', cover: '', playCount: 0, creator: '' }] }
  else if (url.includes('/api/playlist')) body = { list: [{ id: '1', name: '歌A', singer: 's', cover: '', duration: '3:00' }, { id: '2', name: '歌B', singer: 's2', cover: '', duration: '4:00' }], source: 'ny', note: '' }
  else if (url.includes('/api/hot')) body = { list: [{ id: '1', name: '歌A', singer: 's', cover: '', duration: '3:00' }, { id: '2', name: '歌B', singer: 's2', cover: '', duration: '4:00' }] }
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
  console.log('初始歌曲数:', doc.getElementById('songList').children.length)
  // 切到歌单 tab
  doc.getElementById('tabPlaylist').click()
  await wait(300)
  const cards = doc.getElementById('playlistGrid').children.length
  console.log('歌单卡片数:', cards)
  const firstCard = doc.getElementById('playlistGrid').children[0]
  console.log('第一张卡片存在:', !!firstCard, '| tag:', firstCard && firstCard.tagName)

  // 回归：先把榜单平台切到酷我，再点歌单 —— 歌单必须仍走网易云引擎（歌单 id 是网易云 id）
  const platSel = doc.getElementById('boardPlatSelect')
  platSel.value = 'kw'
  platSel.dispatchEvent(new window.Event('change'))
  await wait(200)
  reqs.length = 0
  const playlistId = firstCard.dataset.id
  // 点击第一张歌单卡片
  firstCard.click()
  await wait(300)
  console.log('点击歌单后歌曲数:', doc.getElementById('songList').children.length)
  console.log('listTitle:', doc.getElementById('listTitle').textContent)
  const playlistReq = reqs.find((u) => u.includes('/api/playlist') && u.includes('id=' + playlistId)) || ''
  const usesNy = playlistReq.includes('platform=ny')
  const usesKw = playlistReq.includes('platform=kw')
  console.log('歌单取歌请求:', playlistReq)
  console.log('歌单在酷我榜单平台下仍走所选歌单平台(platform=ny):', usesNy && !usesKw ? 'OK' : 'FAIL')
  console.log('错误:', errs.filter((m) => !/Not implemented/.test(m)))
  const ok = cards > 0 && doc.getElementById('songList').children.length > 0 && usesNy && !usesKw
  console.log(ok ? 'PLAYLIST_CLICK_OK' : 'PLAYLIST_CLICK_FAIL')
  if (!ok) process.exitCode = 1
})().catch((e) => { console.error('TEST ERROR', e); process.exit(1) })
