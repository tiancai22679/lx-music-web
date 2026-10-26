// 前端渲染冒烟测试：用 jsdom 加载真实 index.html + app.js，桩掉 fetch，
// 断言榜单 chips、歌曲列表真的被渲染出来，且没有 JS 运行时错误。
//
// 背景：曾经出现过两个只有真实 DOM 渲染才能发现的问题：
//  1) ASI 陷阱（`state.searchList = null` 少分号 + 下一行以 `[` 开头）→ app.js 整体语法错误，
//     浏览器一行 JS 都不执行，页面只剩静态 HTML 骨架（"什么都不显示"），后端接口却全部正常。
//  2) 歌词竞态：`updateLyric` 把 `idx` 闭包捕获、却延迟 150ms 才读 `lyricLines[idx].text`，
//     期间换歌会清空 lyricLines → undefined.text → "reading 'text'"。
// 纯接口测试（curl /api/hot 返回 200）发现不了这两类问题，故加此测试。
//
// 运行：npm test
const fs = require('fs')
const path = require('path')
const { JSDOM, VirtualConsole } = require('jsdom')

const root = path.join(__dirname, '..')
const html = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '')
const appjs = fs.readFileSync(path.join(root, 'web/app.js'), 'utf8')

// 捕获未捕获异常（jsdom 通过 virtualConsole 抛出）
const jsErrors = []
const vc = new VirtualConsole()
vc.on('jsdomError', (e) => jsErrors.push(e.message || String(e)))

const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc, url: 'http://localhost/' })
const { window } = dom
window.AbortController = AbortController

let lyricPayload = { lyric: '[00:01.00]第一行歌词\n[00:05.00]第二行歌词' }
const requestedUrls = []
window.fetch = (url) => {
  requestedUrls.push(url)
  let body
  if (url.includes('/api/boards')) body = { boards: [{ id: '16', name: '热歌榜' }, { id: '93', name: '飙升榜' }] }
  else if (url.includes('/api/hot')) {
    body = {
      list: [
        { id: '1', name: '测试歌曲', singer: '某人', cover: 'http://x/y.jpg', duration: '3:30' },
        { id: '2', name: '另一首', singer: '谁', cover: '', duration: '4:00' },
      ],
    }
  } else if (url.includes('/api/lyric')) body = lyricPayload
  else if (url.includes('/api/sources')) {
    body = {
      sources: [
        { id: 'ny', name: '网易云音乐', type: 'native', actions: ['musicUrl'], qualitys: ['128k'] },
        { id: 'lx-official:kw', name: '酷我音乐', type: 'lx', script: 'lx-official', source: 'kw', actions: ['musicUrl'], builtin: true },
        { id: 'demo-x:kw', name: '酷我音乐', type: 'lx', script: 'demo-x', source: 'kw', actions: ['musicUrl'], builtin: false },
        { id: 'broken-x', name: 'broken-x', type: 'lx', script: 'broken-x', source: 'broken-x', actions: [], qualitys: [], builtin: false, failed: true, error: '初始化失败' },
      ],
    }
  } else if (url.includes('/api/source/test')) body = { ok: true, url: 'https://example.com/a.mp3', via: 'ny', ms: 12 }
  else if (url.includes('/api/song')) body = { url: 'https://example.com/a.mp3', via: 'ny', sourceName: '网易云音乐' }
  else body = {}
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const alertMsgs = []
// jsdom 没实现 HTMLMediaElement 的 load()/play()，会往 virtualConsole 抛 "Not implemented"，
// 这属于测试环境噪音，过滤掉，其余任何未捕获异常仍然要让测试失败
const realErrors = () => jsErrors.filter((m) => !/Not implemented/.test(m || ''))

// 追加探针，把内部函数/变量暴露出来（不改业务代码）
try {
  window.eval(appjs + '\n;window.__probe = { updateLyric, loadLyric, openSources, renderSourcePick, runSearch, refreshForSource, getPrefer: () => preferSource, getLyricLines: () => lyricLines }')
} catch (e) {
  console.log('EVAL THREW:', e.message)
  process.exit(1)
}

;(async () => {
  await wait(300)
  const doc = window.document
  const chips = doc.getElementById('boardChips').children.length
  const songs = doc.getElementById('songList').children.length
  const loadingHidden = doc.getElementById('listLoading').classList.contains('hidden')
  console.log('board chips rendered:', chips)
  console.log('song items rendered:', songs)
  console.log('loading hidden after load:', loadingHidden)

  // --- 歌词竞态回归测试 ---
  // 1) 载入歌词 → lyricLines 有内容
  await window.__probe.loadLyric('1')
  const lines = window.__probe.getLyricLines().length
  console.log('lyric lines parsed:', lines)
  // 2) 触发 updateLyric，它会延迟 150ms 才真正写 DOM
  window.__probe.updateLyric(30)
  // 3) 期间换歌：清空歌词（模拟 playCurrent 里的 lyricLines = []）
  lyricPayload = { lyric: '' }
  await window.__probe.loadLyric('2')
  // 4) 等那个延迟回调触发 —— 修复前这里会抛 "reading 'text'"
  await wait(400)

  const errBars = doc.querySelectorAll('.err-bar').length
  if (jsErrors.length) console.log('捕获到未捕获异常:', jsErrors)
  console.log('error banners in DOM:', errBars)

  // --- 音源管理面板：测试 / 删除按钮渲染规则 ---
  await window.__probe.openSources()
  await wait(100)
  const items = doc.querySelectorAll('#sourceList .source-item')
  const testBtns = doc.querySelectorAll('#sourceList button[data-act="test"]')
  const delBtns = doc.querySelectorAll('#sourceList button[data-act="del"]')
  console.log('音源条目:', items.length, '| 测试按钮:', testBtns.length, '| 删除按钮:', delBtns.length)
  const builtinHasDel = !!doc.querySelector('#sourceList .source-item button[data-act="del"][data-sid="lx-official"]')
  const userHasDel = !!doc.querySelector('#sourceList .source-item button[data-act="del"][data-sid="demo-x"]')
  const failedHasDel = !!doc.querySelector('#sourceList .source-item button[data-act="del"][data-sid="broken-x"]')
  const failedHasTest = !!doc.querySelector('#sourceList .source-item button[data-act="test"][data-id="broken-x"]')
  console.log('内置源不应有删除按钮:', builtinHasDel ? 'FAIL' : 'OK', '| 用户源应有删除按钮:', userHasDel ? 'OK' : 'FAIL')
  console.log('失败源应有删除按钮:', failedHasDel ? 'OK' : 'FAIL', '| 失败源不应有测试按钮:', failedHasTest ? 'FAIL' : 'OK')

  // --- UI 回归：按钮图标应渲染为内联 SVG，而不是跨平台字形不一的 emoji ---
  const iconBtns = ['searchBtn', 'sourceBtn', 'searchClose', 'sourceClose', 'playerClose', 'miniOpen', 'prevBtn', 'nextBtn', 'shuffleIcon']
  const missingIcons = iconBtns.filter((id) => {
    const el = doc.getElementById(id)
    return !el || !el.querySelector('svg.i')
  })
  console.log('缺少 SVG 图标的按钮:', missingIcons.length ? missingIcons.join(', ') : '无')

  // --- 播放器音源标签不应硬编码为「酷我音乐」---
  const srcDefault = doc.getElementById('playerSrc').textContent.trim()
  const srcLabelOk = srcDefault !== '酷我音乐'
  console.log('播放器音源默认文案:', JSON.stringify(srcDefault), srcLabelOk ? 'OK' : 'FAIL')

  // --- 手动指定音源：下拉框 + 顶栏 chip ---
  const sel = doc.getElementById('sourcePick')
  const optCount = sel.querySelectorAll('option').length
  const grpCount = sel.querySelectorAll('optgroup').length
  const hasAuto = !!sel.querySelector('option[value="auto"]')
  console.log('音源下拉: 选项', optCount, '| 分组', grpCount, '| 有自动项:', hasAuto ? 'OK' : 'FAIL')
  sel.value = 'demo-x:kw'
  sel.dispatchEvent(new window.Event('change'))
  const prefer = window.__probe.getPrefer()
  const chip = doc.getElementById('sourceChip').textContent
  console.log('选择后 prefer =', prefer, '| chip =', JSON.stringify(chip))
  const preferOk = prefer === 'demo-x:kw' && chip.indexOf('酷我') > -1

  // --- 回归：切换音源后，榜单与搜索必须带上 source 参数 ---
  // 背景：搜索/榜单接口此前完全没接收音源参数，导致选了洛雪音源后列表仍是网易云
  await wait(200)
  const afterSwitch = requestedUrls.filter((u) => u.includes('/api/boards') || u.includes('/api/hot'))
  const boardsWithSource = afterSwitch.every((u) => u.includes('source='))
  const lastHot = [...afterSwitch].reverse().find((u) => u.includes('/api/hot'))
  console.log('切换后列表请求数:', afterSwitch.length, '| 均带 source:', boardsWithSource ? 'OK' : 'FAIL')
  console.log('最近一次榜单请求:', lastHot)

  // 搜索也必须带 source
  requestedUrls.length = 0
  doc.getElementById('searchInput').value = '晴天'
  doc.getElementById('searchPanel').classList.remove('hidden')
  await window.__probe.runSearch('晴天')
  const searchUrl = requestedUrls.find((u) => u.includes('/api/search')) || '(无)'
  console.log('搜索请求:', searchUrl)
  const searchWithSource = searchUrl.includes('source=')

  // --- 回归：手动指定音源后「随机播放」必须带上 source ---
  // 背景：改 API.hot 签名时漏改了随机播放的调用点，切到酷我后榜单 id 为 16，
  // 后端却按默认引擎（网易）解析 → 一点随机播放就报「榜单获取失败」
  window.alert = (m) => { alertMsgs.push(String(m)) }
  requestedUrls.length = 0
  doc.getElementById('shuffleBtn').click()
  await wait(300)
  const shuffleUrls = requestedUrls.filter((u) => u.includes('/api/hot'))
  const shuffleLast = shuffleUrls[shuffleUrls.length - 1] || '(无)'
  const shuffleWithSource = shuffleUrls.length > 0 && shuffleUrls.every((u) => u.includes('source='))
  console.log('随机播放请求:', shuffleLast, '| 带 source:', shuffleWithSource ? 'OK' : 'FAIL')
  console.log('随机播放报错弹窗:', alertMsgs.length ? alertMsgs : '无')
  console.log('当前未捕获异常:', JSON.stringify(jsErrors))

  // --- 回归：切回「自动」应重新加载网易默认榜（榜单 id 空间不同） ---
  requestedUrls.length = 0
  sel.value = 'auto'
  sel.dispatchEvent(new window.Event('change'))
  await wait(300)
  const autoUrls = requestedUrls.filter((u) => u.includes('/api/hot'))
  const autoBoard = autoUrls[autoUrls.length - 1] || '(无)'
  const autoBoardOk = autoUrls.length > 0 && autoUrls.every((u) => u.includes('board=3778678'))
  console.log('切回自动后的榜单请求:', autoBoard, '| 用网易榜:', autoBoardOk ? 'OK' : 'FAIL')

  // --- 回归 D.2：榜单平台下拉可手动切换平台，且列表请求带对应 source ---
  requestedUrls.length = 0
  const platSel = doc.getElementById('boardPlatSelect')
  const platExists = !!platSel
  const platOpts = platSel ? platSel.querySelectorAll('option').length : 0
  const platHasNykw = platSel ? (!!platSel.querySelector('option[value="ny"]') && !!platSel.querySelector('option[value="kw"]')) : false
  platSel.value = 'kw'
  platSel.dispatchEvent(new window.Event('change'))
  await wait(300)
  const platBoardReq = requestedUrls.find((u) => u.includes('/api/boards')) || ''
  const platHotReq = [...requestedUrls].reverse().find((u) => u.includes('/api/hot')) || ''
  const platBoardOk = platBoardReq.includes('source=kw')
  const platHotOk = platHotReq.includes('source=kw')
  console.log('榜单平台下拉: 存在', platExists, '| 选项数', platOpts, '| 含网易/酷我', platHasNykw ? 'OK' : 'FAIL')
  console.log('平台切酷我-榜单请求:', platBoardReq)
  console.log('平台切酷我-榜单请求带source=kw:', platBoardOk ? 'OK' : 'FAIL')
  console.log('平台切酷我-歌曲请求:', platHotReq)
  console.log('平台切酷我-歌曲请求带source=kw:', platHotOk ? 'OK' : 'FAIL')
  const shuffleOk = shuffleWithSource && alertMsgs.length === 0
  console.log('诊断:', JSON.stringify({
    chips, songs, loadingHidden, lines, realErrors: realErrors().length, errBars,
    items: items.length, testBtns: testBtns.length, delBtns: delBtns.length,
    builtinHasDel, userHasDel, failedHasDel, failedHasTest,
    srcLabelOk, optCount, grpCount, hasAuto, preferOk,
    boardsWithSource, afterSwitch: afterSwitch.length, searchWithSource, shuffleOk, autoBoardOk,
    platExists, platOpts, platHasNykw, platBoardOk, platHotOk,
  }))

  const ok = chips > 0 && songs > 0 && loadingHidden && lines > 0 && realErrors().length === 0 && errBars === 0 &&
    items.length === 4 && testBtns.length === 3 && delBtns.length === 2 &&
    !builtinHasDel && userHasDel && failedHasDel && !failedHasTest &&
    srcLabelOk && optCount >= 4 && grpCount >= 2 && hasAuto && preferOk &&
    boardsWithSource && afterSwitch.length > 0 && searchWithSource && shuffleOk && autoBoardOk &&
    missingIcons.length === 0 && platExists && platOpts === 2 && platHasNykw && platBoardOk && platHotOk
  console.log(ok ? 'FRONTEND_RENDER_OK' : 'FRONTEND_RENDER_FAIL')
  if (!ok) process.exitCode = 1
})().catch((e) => { console.error('TEST ERROR', e); process.exit(1) })
