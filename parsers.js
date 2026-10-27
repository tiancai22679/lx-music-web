// parsers.js — 多平台歌单解析（纯 Node，复用 server.js 的 fetchText）
// 输入歌单链接 → 自动识别平台 → 返回 [{name, artist}]（与后端 /api/match 的 items 契约一致）
// 平台：网易云 ny / QQ音乐 tx / 千千 91q / 酷狗 kg / 酷我 kw / KKBOX / Apple Music / Spotify
// JSON 类（网易云/QQ/Spotify/Apple/KKBOX）直接解析内嵌数据；DOM 类（千千/酷狗/酷我）用正则提取。

'use strict'

// ---- 小工具 ----
function decodeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
}
function stripTags(s) {
  return decodeHtml(String(s == null ? '' : s).replace(/<[^>]*>/g, '')).trim()
}
// 从 src 中取出以 start 开头、到平衡的 open/close 之间的一段（用于截取 JS 数组/JSON）
function sliceBalanced(src, startIdx, open, close) {
  let i = src.indexOf(open, startIdx)
  if (i < 0) return null
  let depth = 0
  let inStr = false
  let q = ''
  for (let j = i; j < src.length; j++) {
    const c = src[j]
    if (inStr) {
      if (c === '\\') { j++; continue }
      if (c === q) inStr = false
      continue
    }
    if (c === '"' || c === "'" || c === '`') { inStr = true; q = c; continue }
    if (c === open) depth++
    else if (c === close) { depth--; if (depth === 0) return src.slice(i, j + 1) }
  }
  return null
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
function hdrs(extra) { return { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9', ...extra } }

// ---- 平台识别：返回 { plat, id, name }，不识别返回 null ----
function detect(url) {
  const u = String(url || '').trim()
  if (!u) return null
  let m
  if (/music\.163\.com/.test(u)) {
    m = u.match(/[?&]id=(\d+)/) || u.match(/\/playlist\/(\d+)/)
    if (m) return { plat: 'ny', id: m[1], name: '网易云音乐' }
    return null
  }
  // 汽水音乐 / 抖音音乐 分享歌单（短链 qishui.douyin.com/s/xxx 或 music.douyin.com/qishui/share/playlist）
  // 客户端歌单 API 签名/混淆拿不到，但分享页 SSR 把数据内嵌在 loaderData JSON 里，可直接取
  if (/qishui\.douyin\.com/.test(u) || (/music\.douyin\.com/.test(u) && /qishui\/share\/(?:playlist|song)/.test(u))) {
    return { plat: 'qs', id: u, name: '汽水音乐' }
  }
  if (/y\.qq\.com|qq\.com/.test(u)) {
    m = u.match(/disstid=(\d+)/) || u.match(/\/playlist\/(\d+)/)
    if (m) return { plat: 'tx', id: m[1], name: 'QQ音乐' }
  }
  if (/music\.91q\.com/.test(u)) {
    m = u.match(/\/songlist\/(\d+)/)
    if (m) return { plat: '91q', id: m[1], name: '千千音乐' }
  }
  if (/kugou\.com/.test(u)) {
    m = u.match(/\/special\/single\/(\d+)\.html/) || u.match(/\/songlist\/(\d+)/)
    if (m) return { plat: 'kg', id: m[1], name: '酷狗音乐' }
  }
  if (/kuwo\.cn/.test(u)) {
    m = u.match(/\/playlist_detail\/(\d+)/) || u.match(/\/playlist\/(\d+)/)
    if (m) return { plat: 'kw', id: m[1], name: '酷我音乐' }
  }
  if (/kma\.kkbox\.com/.test(u) && /\/charts\//.test(u)) {
    return { plat: 'kkbox', id: u, name: 'KKBOX' }
  }
  if (/music\.apple\.com/.test(u) && /\/playlist\//.test(u)) {
    m = u.match(/(pl\.[A-Za-z0-9]+)/)
    if (m) return { plat: 'apple', id: m[1], name: 'Apple Music' }
  }
  if (/open\.spotify\.com/.test(u)) {
    m = u.match(/\/playlist\/([A-Za-z0-9]+)/)
    if (m) return { plat: 'spotify', id: m[1], name: 'Spotify' }
  }
  return null
}

// ---- 各平台解析器 ----
async function parseNetease(id, fetchText) {
  const r = await fetchText(`https://music.163.com/api/playlist/detail?id=${id}`, {
    headers: hdrs({ Referer: 'https://music.163.com/', cookie: 'os=pc' }), timeout: 15000,
  })
  const j = JSON.parse(r.text)
  const result = j.result || j.playlist || {}
  const tracks = result.tracks || []
  const songs = tracks.map((t) => ({
    name: (t.name || '').trim(),
    artist: ((t.artists || []).map((a) => a.name).filter(Boolean).join('、') || (t.artist || '')).trim(),
  })).filter((s) => s.name)
  return { title: result.name || '', songs }
}

async function parseQQ(id, fetchText) {
  const payload = {
    comm: { ct: 24 },
    req_1: {
      module: 'music.srfDissInfo.aiDissInfo', method: 'uniform_get_Dissinfo',
      param: { disstid: Number(id) || id, onlysonglist: 1, song_begin: 0, song_num: 1000 },
    },
  }
  const url = 'https://u.y.qq.com/cgi-bin/musicu.fcg?data=' + encodeURIComponent(JSON.stringify(payload))
  const r = await fetchText(url, { headers: hdrs({ Referer: 'https://y.qq.com/' }), timeout: 15000 })
  const j = JSON.parse(r.text)
  const req = (j.req_1 && j.req_1.data) || {}
  const title = (req.dirinfo && req.dirinfo.title) || ''
  const songlist = req.songlist || []
  const songs = songlist.map((s) => ({
    name: (s.name || s.title || '').trim(),
    artist: ((s.singer || []).map((x) => x.name).filter(Boolean).join('、')).trim(),
  })).filter((s) => s.name)
  return { title, songs }
}

async function parseQianqian(id, fetchText) {
  const r = await fetchText(`https://music.91q.com/songlist/${id}`, { headers: hdrs(), timeout: 15000 })
  const html = r.text
  const blockRe = /<li class="pr t clearfix"[^>]*>([\s\S]*?)<\/li>/g
  const songs = []
  let bm
  while ((bm = blockRe.exec(html))) {
    const block = bm[1]
    const songM = block.match(/<div class="song-box"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/) ||
      block.match(/<div class="song[^"]*"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/)
    const artistMs = [...block.matchAll(/<div class="artist[^"]*"[^>]*>([\s\S]*?)<\/div>/g)]
    const song = songM ? stripTags(songM[1]) : ''
    let artist = ''
    if (artistMs.length) {
      artist = [...artistMs[0][1].matchAll(/<a[^>]*>([\s\S]*?)<\/a>/g)].map((a) => stripTags(a[1])).filter(Boolean).join('、')
    }
    if (song) songs.push({ name: song, artist })
  }
  let title = ''
  const h1 = html.match(/<h1[^>]*class="title"[^>]*>([\s\S]*?)<\/h1>/)
  if (h1) title = stripTags(h1[1])
  if (!title) {
    const lm = html.match(/listName:"([^"]+)"/) || html.match(/"listName":"([^"]+)"/) || html.match(/title:"([^"]+)"/)
    if (lm) title = decodeHtml(lm[1])
  }
  return { title, songs }
}

async function parseKugou(id, fetchText) {
  const r = await fetchText(`https://www.kugou.com/yy/special/single/${id}.html`, { headers: hdrs(), timeout: 15000 })
  const html = r.text
  const songs = []
  const re = /<span class="text"[^>]*>\s*<i>([\s\S]*?)<\/i>/g
  let m
  while ((m = re.exec(html))) {
    const text = stripTags(m[1])
    if (!text.includes(' - ')) continue
    const idx = text.indexOf(' - ')
    const artist = text.slice(0, idx).trim()
    const song = text.slice(idx + 3).trim()
    if (song) songs.push({ name: song, artist })
  }
  let title = ''
  const sp = html.match(/specialInfo\s*=\s*({[\s\S]*?})\s*;/)
  if (sp) { const nm = sp[1].match(/name\s*:\s*"([^"]+)"/); if (nm) title = decodeHtml(nm[1]) }
  if (!title) {
    const tm = html.match(/<title>([\s\S]*?)<\/title>/)
    if (tm) title = decodeHtml(tm[1]).split(/[_|]/)[0].trim()
  }
  return { title, songs }
}

async function parseKuwo(id, fetchText) {
  const r = await fetchText(`https://www.kuwo.cn/playlist_detail/${id}`, { headers: hdrs(), timeout: 15000 })
  const html = r.text
  const blockRe = /<li class="song_item[^"]*"[^>]*>([\s\S]*?)<\/li>/g
  const songs = []
  let bm
  while ((bm = blockRe.exec(html))) {
    const block = bm[1]
    const nameM = block.match(/<div class="song_name[^"]*"[^>]*>[\s\S]*?<a[^>]*class="name"[^>]*>([\s\S]*?)<\/a>/) ||
      block.match(/<div class="song_name[^"]*"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/)
    const artistMs = [...block.matchAll(/<div class="song_artist"[^>]*>([\s\S]*?)<\/div>/g)]
    const name = nameM ? stripTags(nameM[1]) : ''
    let artist = ''
    if (artistMs.length) {
      artist = [...artistMs[0][1].matchAll(/<span[^>]*>([\s\S]*?)<\/span>/g)].map((a) => stripTags(a[1])).filter(Boolean).join('、')
    }
    if (name) songs.push({ name, artist })
  }
  let title = ''
  const tm = html.match(/<title>([\s\S]*?)<\/title>/)
  if (tm) title = decodeHtml(tm[1]).split(/[_|]/)[0].trim()
  const warning = songs.length >= 20 ? '酷我页面首屏仅含约 20 首，歌单更大时可能未全量。' : null
  return { title, songs, warning }
}

async function parseKKBox(url, fetchText) {
  const r = await fetchText(url, { headers: hdrs({ 'Accept-Language': 'zh-TW,zh;q=0.9' }), timeout: 15000 })
  const html = r.text
  const key = 'var chart ='
  const kp = html.indexOf(key)
  if (kp < 0) throw new Error('未找到榜单数据')
  const arrText = sliceBalanced(html, kp, '[', ']')
  const chart = JSON.parse(arrText)
  const songs = chart.map((it) => ({
    name: (it.song_name || '').trim(),
    artist: (it.artist_name || '').trim(),
  })).filter((s) => s.name)
  let title = ''
  const tm = html.match(/<title>([\s\S]*?)<\/title>/)
  if (tm) title = decodeHtml(tm[1]).replace(/\s*-\s*KKBOX.*$/, '').trim()
  return { title, songs }
}

async function parseApple(id, url, fetchText) {
  const r = await fetchText(url, { headers: hdrs(), timeout: 20000 })
  const html = r.text
  const m = html.match(/id="serialized-server-data">([\s\S]*?)<\/script>/)
  if (!m) throw new Error('未找到内嵌数据')
  const data = JSON.parse(m[1])
  const sections = data.data[0].data.sections
  let title = ''
  if (sections && sections[0] && sections[0].items && sections[0].items[0]) title = sections[0].items[0].title || ''
  const songs = []
  for (const sec of sections) {
    for (const it of sec.items || []) {
      const name = it.title, artist = it.artistName
      if (typeof name === 'string' && name.trim() && typeof artist === 'string' && artist.trim()) {
        songs.push({ name: name.trim(), artist: artist.trim() })
      }
    }
  }
  return { title, songs }
}

async function parseSpotify(id, fetchText) {
  const r = await fetchText(`https://open.spotify.com/embed/playlist/${id}`, { headers: hdrs(), timeout: 15000 })
  const html = r.text
  let m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/) ||
    html.match(/<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/)
  if (!m) throw new Error('未找到内嵌数据')
  const data = JSON.parse(m[1])
  const entity = data.props.pageProps.state.data.entity
  const title = entity.name || ''
  const songs = (entity.trackList || []).map((t) => ({
    name: (t.title || '').trim(),
    artist: (t.subtitle || '').trim(),
  })).filter((s) => s.name)
  const warning = songs.length >= 100 ? 'Spotify embed 页对超大歌单可能截断（常见上限约 100 首）。' : null
  return { title, songs, warning }
}

// ---- 汽水音乐 / 抖音音乐 分享歌单 ----
// 分享页 SSR 把歌单数据内嵌在 <script> 的 loaderData JSON 中：
//   loaderData.playlist_page.playlistInfo -> { title, count_tracks, owner:{nickname} }
//   loaderData.playlist_page.medias[]      -> { entity:{ track:{ name, artists:[{name}] } } }
// 客户端歌单接口签名/混淆无法直连，但分享页 HTML 内含完整 JSON，故走「取页面内嵌 JSON」路线。
async function parseQishui(url, fetchText) {
  const r = await fetchText(url, {
    headers: hdrs({ Referer: 'https://music.douyin.com/', Accept: 'text/html,application/xhtml+xml' }),
    decompress: true,
    timeout: 20000,
  })
  const html = r.text || ''
  // 1) 取出含 loaderData 的 <script> 块
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1])
  const data = scripts.find((s) => s.includes('loaderData') && s.includes('playlistInfo'))
  if (!data) throw new Error('未找到内嵌歌单数据（分享页结构可能已变更或被风控拦截）')
  // 2) 从脚本块里提取根 JSON 对象（兼容 `window.x = {...}` 赋值前缀或纯 JSON）
  const json = extractRootJson(data)
  const ld = json && json.loaderData
  if (!ld) throw new Error('loaderData 解析失败')
  // 3) 在 JSON 内递归定位 playlistInfo 与 medias（路径随版本可能变化，故不写死）
  const pi = findObjByKey(ld, 'playlistInfo')
  const medias = findObjByKey(ld, 'medias')
  if (!pi || !Array.isArray(medias)) throw new Error('歌单信息缺失')
  const title = (pi.title || '').trim()
  const owner = ((pi.owner && (pi.owner.nickname || pi.owner.name)) || '').trim()
  const count = pi.count_tracks || medias.length
  const songs = []
  for (const m of medias) {
    const tr = (m && m.entity && m.entity.track) || null
    if (!tr) continue
    let name = '', artist = ''
    if (typeof tr === 'object') {
      name = tr.name || tr.title || ''
      const arts = tr.artists || tr.artist || []
      if (Array.isArray(arts)) artist = arts.map((a) => (typeof a === 'object' ? a.name : a)).filter(Boolean).join('、')
      else if (typeof arts === 'string') artist = arts
    } else if (typeof tr === 'string') {
      // 极少数情况下 track 是字符串化的 Python dict，做兜底正则提取
      name = pyGet(tr, ['title', 'name']) || ''
      artist = pyGet(tr, ['artist', 'author', 'singer']) || ''
    }
    name = (name || '').trim()
    if (name) songs.push({ name, artist: (artist || '').trim() })
  }
  if (!songs.length) throw new Error('未提取到歌曲')
  const warning = songs.length < count ? `汽水音乐仅返回 ${songs.length}/${count} 首（个别条目无音频元数据，已跳过）` : null
  return { title, owner, songs, warning }
}

// 从脚本文本里取出根 JSON 对象（去掉可能的 `window.x =` 赋值前缀，再按括号平衡截到根 `{...}`）
function extractRootJson(s) {
  let t = String(s || '').trim()
  t = t.replace(/^\s*(?:window\s*\.\s*)?(?:var|let|const)?\s*[A-Za-z_$][\w$]*\s*=\s*/, '')
  t = t.replace(/;+\s*$/, '')
  const start = t.indexOf('{')
  if (start < 0) return null
  let depth = 0, inStr = false, q = '', end = -1
  for (let i = start; i < t.length; i++) {
    const c = t[i]
    if (inStr) {
      if (c === '\\') { i++; continue }
      if (c === q) inStr = false
      continue
    }
    if (c === '"' || c === "'" || c === '`') { inStr = true; q = c; continue }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) { end = i; break } }
  }
  if (end < 0) return null
  try { return JSON.parse(t.slice(start, end + 1)) } catch (_) { return null }
}

// 递归在对象/数组里找第一个键名为 key 的对象值
function findObjByKey(o, key) {
  if (o == null || typeof o !== 'object') return null
  if (Array.isArray(o)) {
    for (const v of o) { const r = findObjByKey(v, key); if (r) return r }
    return null
  }
  if (Object.prototype.hasOwnProperty.call(o, key) && o[key] != null && typeof o[key] === 'object') return o[key]
  for (const k of Object.keys(o)) { const r = findObjByKey(o[k], key); if (r) return r }
  return null
}

// 从字符串化 Python dict 里取某个键的值（兜底；处理 ' 与 " 两种引号及转义）
function pyGet(s, keys) {
  for (const k of keys) {
    const re = new RegExp("(['\"])" + k + "\\1\\s*:\\s*(['\"])((?:\\\\.|[^\\2\\\\])*?)\\2")
    const m = s.match(re)
    if (m) return m[2].replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  return ''
}

// ---- 统一入口 ----
async function parse(url, fetchText) {
  const d = detect(url)
  if (!d) {
    return { ok: false, error: '未能识别平台。目前支持：网易云音乐、QQ音乐、千千音乐、酷狗、酷我、KKBOX、Apple Music、Spotify、汽水音乐（抖音）' }
  }
  // 解析器统一走「解压」版 fetchText（部分站点强制 gzip）；通用接口不受影响
  const ft = (u, o = {}) => fetchText(u, { ...o, decompress: true })
  try {
    let r
    switch (d.plat) {
      case 'ny': r = await parseNetease(d.id, ft); break
      case 'tx': r = await parseQQ(d.id, ft); break
      case '91q': r = await parseQianqian(d.id, ft); break
      case 'kg': r = await parseKugou(d.id, ft); break
      case 'kw': r = await parseKuwo(d.id, ft); break
      case 'kkbox': r = await parseKKBox(d.id, ft); break
      case 'apple': r = await parseApple(d.id, url, ft); break
      case 'spotify': r = await parseSpotify(d.id, ft); break
      case 'qs': r = await parseQishui(url, ft); break
      default: return { ok: false, error: '未知平台' }
    }
    const songs = (r.songs || []).map((s) => ({ name: s.name, artist: s.artist }))
    if (!songs.length) return { ok: false, error: d.name + '：未提取到歌曲', platform: d.plat }
    return {
      ok: true,
      platform: d.plat,
      platform_name: d.name,
      playlist_title: r.title || '',
      count: songs.length,
      songs,
      formatted: songs.map((s) => (s.artist ? `${s.name} - ${s.artist}` : s.name)),
      warning: r.warning || null,
    }
  } catch (e) {
    return { ok: false, error: d.name + ' 解析失败：' + (e && e.message ? e.message : e), platform: d.plat }
  }
}

module.exports = { detect, parse }
