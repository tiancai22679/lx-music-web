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
const reqs = []      // GET 请求
const posts = []     // POST 请求 [{url, body}]
const nyPlaylist = { list: [{ id: 'n1', name: '网易歌单曲A', singer: 'a', cover: '', duration: '3:00' }, { id: 'n2', name: '网易歌单曲B', singer: 'b', cover: '', duration: '4:00' }], source: 'ny', note: '' }
window.fetch = (url, opts) => {
  if (opts && opts.method === 'POST') {
    let body = {}
    try { body = JSON.parse(opts.body || '{}') } catch (_) {}
    posts.push({ url: String(url), body })
    if (url.includes('/api/match')) {
      const results = (body.items || []).map((it) => ({ ok: true, query: it, song: { id: 'm-' + encodeURIComponent(it.name), name: it.name, singer: it.artist || '匹配歌手', cover: '', duration: '3:30', source: 'ny' } }))
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ results, matched: results.length, total: results.length, source: 'ny' }) })
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
  }
  reqs.push(String(url))
  let body = {}
  if (url.includes('/api/boards')) body = { boards: [{ id: '3778678', name: '热歌榜' }] }
  else if (url.includes('/api/parse_playlist')) body = { ok: true, platform: 'tx', platform_name: 'QQ音乐', playlist_title: '测试歌单', count: 2, songs: [{ name: 'QQ曲A', artist: '歌手A' }, { name: 'QQ曲B', artist: '歌手B' }], formatted: ['QQ曲A - 歌手A', 'QQ曲B - 歌手B'], warning: null }
  else if (url.includes('/api/playlist')) body = nyPlaylist
  else if (url.includes('/api/hot')) body = { list: [{ id: '1', name: '歌A', singer: 's', cover: '', duration: '3:00' }] }
  else if (url.includes('/api/lyric')) body = { lyric: '' }
  else if (url.includes('/api/sources')) body = { sources: [{ id: 'ny', name: '网易云音乐', type: 'native', actions: ['musicUrl'] }] }
  else if (url.includes('/api/song')) body = { url: 'https://x/a.mp3', via: 'ny', sourceName: '网易云' }
  else body = {}
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const setVal = (el, v) => { el.value = v }
;(async () => {
  try { window.eval(appjs) } catch (e) { console.log('EVAL THREW', e.message); process.exit(1) }
  const doc = window.document
  await wait(300)
  const $ = (id) => doc.getElementById(id)
  let ok = true
  const check = (label, cond) => { console.log(label + ':', cond ? 'OK' : 'FAIL'); if (!cond) ok = false }

  // 前置：面板默认隐藏，按钮存在
  check('粘贴按钮存在', !!$('pasteOpenBtn'))
  check('面板默认隐藏', $('pastePanel').classList.contains('hidden'))

  // ---- 场景1：粘贴曲目文本 → POST /api/match → 匹配结果进主列表并播放 ----
  $('pasteOpenBtn').click()
  await wait(50)
  check('点按钮后面板打开', !$('pastePanel').classList.contains('hidden'))
  setVal($('pasteArea'), '01. 晴天 - 周杰伦\n2、稻香\n七里香 - 周杰伦\n\nhttps://y.qq.com/n/ryqq/playlist/7707261125')
  posts.length = 0
  $('pasteGo').click()
  await wait(400)
  const m = posts.find((p) => p.url.includes('/api/match'))
  check('触发 POST /api/match', !!m)
  if (m) {
    const items = m.body.items || []
    check('解析出 3 首曲目（URL 行与空行跳过）', items.length === 3)
    check('剥掉行首序号「01.」', items[0] && items[0].name === '晴天' && items[0].artist === '周杰伦')
    check('剥掉行首序号「2、」', items[1] && items[1].name === '稻香' && items[1].artist === '')
    check('第3首解析正确', items[2] && items[2].name === '七里香' && items[2].artist === '周杰伦')
  }
  check('匹配结果进主列表（3 首）', $('songList').children.length === 3)
  check('列表标题为「粘贴歌单」', $('listTitle').textContent === '粘贴歌单')
  check('播放器已展开', !$('player').classList.contains('hidden'))
  check('面板已关闭', $('pastePanel').classList.contains('hidden'))

  // ---- 场景2：粘贴网易云歌单链接 → 直接读取曲目 ----
  setVal($('pasteArea'), 'https://music.163.com/playlist?id=18271967084&userid=1')
  reqs.length = 0
  $('pasteGo').click()
  await wait(400)
  const nyReq = reqs.find((u) => u.includes('/api/playlist') && u.includes('id=18271967084')) || ''
  check('触发 /api/playlist?id=18271967084', !!nyReq)
  check('网易云链接请求带 platform=ny', nyReq.includes('platform=ny'))
  check('读取到的曲目进主列表（2 首）', $('songList').children.length === 2)
  check('列表标题为「网易云歌单」', $('listTitle').textContent === '网易云歌单')

  // ---- 场景3：只贴 QQ 歌单链接 → 解析出「曲名 - 歌手」列表回填输入框（不立即匹配）----
  posts.length = 0
  reqs.length = 0
  setVal($('pasteArea'), 'https://y.qq.com/n/ryqq/playlist/7707261125')
  $('pasteGo').click()
  await wait(400)
  check('QQ 链接触发 /api/parse_playlist', !!reqs.find((u) => u.includes('/api/parse_playlist')))
  const filled = $('pasteArea').value.split('\n').map((s) => s.trim()).filter(Boolean)
  check('解析列表回填到输入框（2 首）', filled.length === 2)
  check('回填为「曲名 - 歌手」格式', /QQ曲A - 歌手A/.test($('pasteArea').value))
  check('提示已解析', /已解析/.test($('pasteMsg').textContent))
  check('此步不触发匹配（先展示列表）', !posts.find((p) => p.url.includes('/api/match')))
  // 场景3b：列表已回填后再点一次 → 走文本逐首匹配播放
  posts.length = 0
  $('pasteGo').click()
  await wait(400)
  check('二次点击触发 /api/match', !!posts.find((p) => p.url.includes('/api/match')))
  check('匹配后进主列表（2 首）', $('songList').children.length === 2)

  // ---- 场景4：空输入 ----
  setVal($('pasteArea'), '   ')
  $('pasteGo').click()
  await wait(200)
  check('空输入提示格式说明', /没有可解析的曲目/.test($('pasteMsg').textContent))

  const realErrs = errs.filter((m) => !/Not implemented/.test(m))
  check('无真实报错', realErrs.length === 0)
  if (realErrs.length) console.log('错误:', realErrs)
  console.log(ok ? 'PASTE_OK' : 'PASTE_FAIL')
  if (!ok) process.exitCode = 1
})().catch((e) => { console.error('TEST ERROR', e); process.exit(1) })
