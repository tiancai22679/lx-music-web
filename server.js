// lx-music-web 后端：参考洛雪音乐(LX Music)音源架构，纯 Node 实现酷我(kw)音源
// 搜索 / 热歌榜(榜单) / 取播放地址 / 封面 / 音频代理 / 歌词
// 纯 Node 标准库，无 npm 依赖；自动识别 HTTPS_PROXY 走代理（沙箱用），生产无代理则直连。

const http = require('http')
const https = require('https')
const zlib = require('zlib')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { URL } = require('url')
const dns = require('dns')
const parsers = require('./parsers')
if (dns.setDefaultResultOrder) dns.setDefaultResultOrder('ipv4first')

const PORT = process.env.PORT || 3005
const WEB_DIR = path.join(__dirname, 'web')

// ---------- 代理感知的 HTTP 请求 ----------
const PROXY = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || ''
const USE_PROXY = !!PROXY
if (USE_PROXY) console.log('使用代理:', PROXY)

function doRequestOnce(url, viaProxy, { method = 'GET', headers = {}, timeout = 15000, follow = true, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const isHttps = u.protocol === 'https:'
    const lib = isHttps ? https : http
    const onResponse = (res) => {
      if (follow && (res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        res.resume()
        const next = new URL(res.headers.location, url).toString()
        return resolve(doRequestOnce(next, viaProxy, { method, headers, follow, timeout, body }))
      }
      resolve(res)
    }
    const send = (req) => {
      req.setTimeout(timeout, () => req.destroy(new Error('timeout')))
      req.on('error', reject)
      if (body) req.write(body)
      req.end()
    }
    if (!viaProxy) {
      // 直连（生产路由器 / 当前沙箱均可直连）
      send(lib.request({
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        method,
        autoSelectFamily: true,
        headers: { 'User-Agent': 'Mozilla/5.0', ...headers },
      }, onResponse))
    } else if (!isHttps) {
      const pu = new URL(PROXY)
      send(lib.request({
        host: pu.hostname,
        port: pu.port || 8080,
        method,
        path: url,
        headers: { 'User-Agent': 'Mozilla/5.0', ...headers },
      }))
    } else {
      const pu = new URL(PROXY)
      const conn = http.request({
        host: pu.hostname,
        port: pu.port || 8080,
        method: 'CONNECT',
        path: `${u.hostname}:${u.port || 443}`,
        headers: { Host: `${u.hostname}:${u.port || 443}` },
      })
      conn.on('connect', (cres, socket) => {
        if (cres.statusCode !== 200) {
          socket.destroy()
          return reject(new Error('proxy CONNECT failed ' + cres.statusCode))
        }
        const req = https.request(
          { socket, host: u.hostname, servername: u.hostname, path: u.pathname + u.search, method, headers: { 'User-Agent': 'Mozilla/5.0', ...headers } },
          onResponse
        )
        req.on('error', reject)
        if (body) req.write(body)
        req.end()
      })
      conn.on('error', reject)
      conn.end()
    }
  })
}

// 默认直连；若直连失败且设置了代理，则回退到代理（兼容沙箱/生产两种环境）
// 网络层重试：仅在“拿不到响应”的连接级错误时重试（4xx/5xx 视为已拿到响应，不重试）
async function makeRequest(url, opts = {}) {
  const attemptOnce = (viaProxy) => doRequestOnce(url, viaProxy, opts)
  const max = 3
  let lastErr
  for (let i = 0; i < max; i++) {
    try {
      return await attemptOnce(false)
    } catch (e) {
      lastErr = e
      if (USE_PROXY) {
        try {
          console.warn('[net] 直连失败，回退代理:', e.message, '->', url)
          return await attemptOnce(true)
        } catch (e2) {
          lastErr = e2
        }
      }
      if (i < max - 1) {
        console.warn(`[net] 请求失败(${i + 1}/${max}):`, lastErr.message, '->', url)
        await new Promise((r) => setTimeout(r, 300 * (i + 1)))
      }
    }
  }
  throw lastErr
}
process.on('uncaughtException', (e) => console.error('[uncaught]', e.message))

// 取文本/二进制响应
async function fetchText(url, opts = {}) {
  const timeout = opts.timeout || 15000
  // 硬超时：DNS/TCP 建连阶段 socket 尚未分配，req.setTimeout 不生效，这里兜底
  const guard = new Promise((_, reject) => {
    const t = setTimeout(() => reject(new Error('请求超时(' + timeout + 'ms)')), timeout + 3000)
    t.unref && t.unref()
  })
  const res = await Promise.race([makeRequest(url, opts), guard])
  const chunks = []
  await new Promise((resolve) => {
    res.on('data', (c) => chunks.push(c))
    res.on('end', resolve)
    res.on('error', resolve)
  })
  const buf = Buffer.concat(chunks)
  // 仅在 opts.decompress 时解压（供歌单解析器用）：部分站点（如千千/酷狗）强制返回 gzip，
  // 不解压则 toString 乱码。默认不解压，保持通用接口（搜索/榜单/取址/封面）原样、零开销。
  let out = buf
  if (opts.decompress) {
    const enc = String(res.headers['content-encoding'] || '').toLowerCase()
    try {
      if (enc === 'br') out = zlib.brotliDecompressSync(buf)
      else if (enc === 'deflate') out = zlib.inflateSync(buf)
      else if (enc === 'gzip' || (buf.length > 1 && buf[0] === 0x1f && buf[1] === 0x8b)) out = zlib.gunzipSync(buf)
    } catch (_) { /* 非压缩内容则原样返回 */ }
  }
  return { status: res.statusCode, headers: res.headers, body: out, text: out.toString('utf8') }
}

// ---------- 酷我 wbd 加密 (AES-128-ECB / PKCS7) ----------
const KW_KEY = Buffer.from('cFcnPcf6Kb85RC1y3V6M5A==', 'base64')
const KW_APPID = 'y67sprxhhpws'
function aesEcb(buf, key) {
  const c = crypto.createCipheriv('aes-128-ecb', key, Buffer.alloc(0))
  c.setAutoPadding(false)
  return Buffer.concat([c.update(buf), c.final()])
}
function aesEcbDec(buf, key) {
  const d = crypto.createDecipheriv('aes-128-ecb', key, Buffer.alloc(0))
  d.setAutoPadding(false)
  return Buffer.concat([d.update(buf), d.final()])
}
function pkcs7pad(buf) {
  const n = 16 - (buf.length % 16)
  return Buffer.concat([buf, Buffer.alloc(n, n)])
}
function wbdBuildParam(obj) {
  const enc = aesEcb(pkcs7pad(Buffer.from(JSON.stringify(obj), 'utf8')), KW_KEY).toString('base64')
  const t = Date.now()
  const sign = crypto.createHash('md5').update(KW_APPID + enc + String(t)).digest('hex').toUpperCase()
  return `data=${encodeURIComponent(enc)}&time=${t}&appId=${KW_APPID}&sign=${sign}`
}
function wbdDecode(txt) {
  let buf = aesEcbDec(Buffer.from(decodeURIComponent(txt), 'base64'), KW_KEY)
  const pad = buf[buf.length - 1]
  if (pad > 0 && pad <= 16) buf = buf.slice(0, buf.length - pad)
  return JSON.parse(buf.toString('utf8'))
}

// ---------- 酷我音源 ----------
function kwSearchUrl(keyword, limit) {
  return (
    'http://search.kuwo.cn/r.s?client=kt&all=' +
    encodeURIComponent(keyword) +
    `&pn=0&rn=${limit}&uid=794762570&ver=kwplayer_ar_9.2.2.1&vipver=1&show_copyright_off=1&newver=1&ft=music&cluster=0&strategy=2012&encoding=utf8&rformat=json&vermerge=1&mobi=1&issubtitle=1`
  )
}
const kw = {
  async search(keyword, limit = 50) {
    const url = kwSearchUrl(keyword, limit)
    const r = await fetchText(url, { timeout: 12000 })
    if (r.status !== 200) throw new Error('search HTTP ' + r.status)
    const j = JSON.parse(r.text)
    const list = (j.abslist || []).map((it) => {
      const rid = String(it.MUSICRID || '').replace('MUSIC_', '')
      return {
        id: rid,
        name: decodeHtml(it.SONGNAME || ''),
        singer: decodeHtml(it.ARTIST || ''),
        album: decodeHtml(it.ALBUM || ''),
        duration: fmtDur(parseInt(it.DURATION) || 0),
        // hts_MVPIC 是完整 https 封面地址（img2.kuwo.cn），最可靠
        cover: it.hts_MVPIC || '',
        source: 'kw',
      }
    })
    return list.filter((s) => s.id)
  },

  async hot(bangid = '16', limit = 100) {
    const body = {
      uid: '',
      devId: '',
      sFrom: 'kuwo_sdk',
      user_type: 'AP',
      carSource: 'kwplayercar_ar_6.0.1.0_apk_keluze.apk',
      id: String(bangid),
      pn: 0,
      rn: limit,
    }
    const url = 'https://wbd.kuwo.cn/api/bd/bang/bang_info?' + wbdBuildParam(body)
    const r = await fetchText(url, { timeout: 12000 })
    if (r.status !== 200) throw new Error('hot HTTP ' + r.status)
    const j = wbdDecode(r.text)
    if (j.code !== 200) throw new Error('hot code ' + j.code)
    return (j.data.musiclist || []).map((it) => ({
      id: String(it.id),
      name: decodeHtml(it.name || ''),
      singer: decodeHtml(it.artist || ''),
      album: decodeHtml(it.album || ''),
      duration: fmtDur(parseInt(it.duration) || 0),
      cover: it.pic || '',
      source: 'kw',
    }))
  },

  async songUrl(rid) {
    const url = `http://antiserver.kuwo.cn/anti.s?format=mp3&rid=MUSIC_${rid}&type=convert_url&response=url`
    const r = await fetchText(url, { timeout: 12000 })
    if (r.status !== 200) throw new Error('songUrl HTTP ' + r.status)
    const txt = r.text.trim()
    if (!/^https?:\/\//.test(txt)) throw new Error('songUrl invalid: ' + txt.slice(0, 40))
    return txt
  },

  async fillCover(song) {
    if (song.cover) return
    if (!song.name) return
    // musicInfo(www.kuwo.cn) 当前不稳定(301/HTML)，改用关键词搜索回退取 hts_MVPIC 封面
    try {
      const r = await fetchText(kwSearchUrl(song.name, 20), { timeout: 10000 })
      if (r.status !== 200) return
      const j = JSON.parse(r.text)
      const abs = j.abslist || []
      const exact = abs.find((it) => String(it.MUSICRID || '').replace('MUSIC_', '') === String(song.id))
      const pick = exact || abs.find((it) => it.hts_MVPIC)
      if (pick && pick.hts_MVPIC) song.cover = pick.hts_MVPIC
    } catch (_) {}
  },

  async lyric(rid) {
    try {
      const url = `http://mlyric.kuwo.cn/mobi.s?f=web&type=lyric&lrcx=1&rid=${rid}&encode=utf8`
      const r = await fetchText(url, { timeout: 8000 })
      if (r.status !== 200) return ''
      const buf = r.body
      if (buf.toString('utf8', 0, 10).toLowerCase() !== 'tp=content') return ''
      const sep = buf.indexOf('\r\n\r\n')
      if (sep < 0) return ''
      const deflated = buf.subarray(sep + 4)
      const lrcData = zlib.inflateSync(deflated) // -> base64 字符串
      const bufStr = Buffer.from(lrcData.toString('utf8'), 'base64')
      const key = Buffer.from('yeelion')
      const out = Buffer.alloc(bufStr.length)
      for (let i = 0; i < bufStr.length; i++) out[i] = bufStr[i] ^ key[i % key.length]
      let lrc = out.toString('utf8')
      // 去除逐字歌词时间标签 <start,dur>
      lrc = lrc.replace(/<(-?\d+),(-?\d+)(?:,-?\d+)?>/g, '')
      if (!/\[\d{1,2}:\d{1,2}/.test(lrc)) return ''
      return lrc
    } catch (_) {
      return ''
    }
  },
}

// ---------- 网易云音源（可播放）----------
// eapi 加密契约：data = `${url}-36cd479b6b5-${json}-36cd479b6b5-${md5}`
// digest = md5(`nobody${url}use${json}md5forencrypt`)，AES-128-ECB(带PKCS5填充) 后 hex 大写
const NY_EAPI_KEY = 'e82ckenh8dichen8'
const NY_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
function nyEapiParams(url, obj) {
  const text = typeof obj === 'object' ? JSON.stringify(obj) : String(obj)
  const digest = crypto.createHash('md5').update(`nobody${url}use${text}md5forencrypt`, 'utf8').digest('hex')
  const data = `${url}-36cd479b6b5-${text}-36cd479b6b5-${digest}`
  const c = crypto.createCipheriv('aes-128-ecb', Buffer.from(NY_EAPI_KEY, 'utf8'), null)
  const enc = Buffer.concat([c.update(Buffer.from(data, 'utf8')), c.final()])
  return enc.toString('hex').toUpperCase()
}
function nyTrack(it) {
  return {
    id: String(it.id),
    source: 'ny',
    name: decodeHtml(it.name || ''),
    singer: decodeHtml((it.artists || []).map((a) => a.name).join('、')),
    album: decodeHtml((it.album && it.album.name) || ''),
    duration: fmtDur(Math.round((it.duration || 0) / 1000)),
    cover: (it.album && it.album.picUrl) || it.picUrl || '',
    durationMs: it.duration || 0,
  }
}

const ny = {
  async search(keyword, limit = 100) {
    const out = []
    const seen = new Set()
    const pageSize = 50 // 网易云搜索单页上限 50，多页累加以支持更大结果数
    for (let off = 0; off < limit; off += pageSize) {
      const take = Math.min(pageSize, limit - off)
      const url = `https://music.163.com/api/search/get?s=${encodeURIComponent(keyword)}&type=1&limit=${take}&offset=${off}`
      const r = await fetchText(url, { headers: { 'User-Agent': NY_UA, Referer: 'https://music.163.com/' }, timeout: 12000 })
      const j = JSON.parse(r.text)
      const list = (j.result && j.result.songs) || []
      if (!list.length) break
      for (const it of list) {
        const id = String(it.id)
        if (seen.has(id)) continue
        seen.add(id)
        out.push(nyTrack(it))
      }
      if (list.length < take) break
    }
    return out
  },

  // 歌单搜索（type=1000）：用于「搜索歌单并一键加入播放列表」。
  // 固定走网易云——歌单 detail 接口已验证可用，可完整取歌播放；QQ/酷狗歌单曲目接口被平台封死，故不做。
  async searchPlaylist(keyword, limit = 20) {
    const url = `https://music.163.com/api/search/get?s=${encodeURIComponent(keyword)}&type=1000&limit=${Math.min(limit, 50)}&offset=0`
    const r = await fetchText(url, { headers: { 'User-Agent': NY_UA, Referer: 'https://music.163.com/' }, timeout: 12000 })
    const j = JSON.parse(r.text)
    const arr = (j.result && j.result.playlists) || []
    return arr.slice(0, limit).map((it) => ({
      id: String(it.id),
      name: decodeHtml(it.name || ''),
      cover: it.coverImgUrl || '',
      playCount: it.playCount || 0,
      creator: (it.creator && it.creator.nickname) || '',
      trackCount: it.trackCount || 0,
    }))
  },

  // 精选榜单：只展示用户常用的主流榜单，避免一次性吐出几十个冷门榜导致界面杂乱、
  // 文字在透明首页上对比度过低看不清；若接口返回的榜单里找不到精选名，则退回完整榜单保证不丢数据
  async boards() {
    const r = await fetchText('https://music.163.com/api/toplist/detail', { headers: { 'User-Agent': NY_UA, Referer: 'https://music.163.com/' }, timeout: 12000 })
    const j = JSON.parse(r.text)
    const list = j.list || []
    const curated = ['热歌榜', '飙升榜', '新歌榜', '原创榜', '抖音榜', '欧美榜', '华语榜', '电音榜', '说唱榜', '国风榜', '经典老歌榜', 'KTV榜']
    const idx = (name) => { const i = curated.indexOf(name); return i < 0 ? 999 : i }
    const remaining = new Map(list.map((it) => [it.name, it]))
    const out = []
    for (const name of curated) {
      if (remaining.has(name)) { out.push(remaining.get(name)); remaining.delete(name) }
    }
    if (!out.length) for (const it of list) if (remaining.has(it.name)) out.push(it)
    return out.map((it) => ({ id: String(it.id), name: it.name, count: it.trackCount || 0 }))
  },

  // 热门歌单：官方「歌单广场」按热度排序（cat=全部、order=hot），无需登录
  async playlists(limit = 20) {
    const cat = encodeURIComponent('全部')
    const url = `https://music.163.com/api/playlist/list?cat=${cat}&type=hot&order=hot&offset=0&total=true&limit=${limit}`
    const r = await fetchText(url, { headers: { 'User-Agent': NY_UA, Referer: 'https://music.163.com/' }, timeout: 15000 })
    const j = JSON.parse(r.text)
    const arr = j.playlists || []
    if (!arr.length) return []
    return arr.slice(0, limit).map((it) => ({
      id: String(it.id),
      name: decodeHtml(it.name || ''),
      cover: it.coverImgUrl || '',
      playCount: it.playCount || 0,
      creator: (it.creator && it.creator.nickname) || '',
      desc: decodeHtml(it.description || ''),
    }))
  },

  async hot(boardId = '3778678', limit = 100) {
    // 必须带 os=pc cookie：匿名请求 playlist/detail 只回前 10 首预览，带上后回完整曲目列表
    const r = await fetchText(`https://music.163.com/api/playlist/detail?id=${boardId}`, { headers: { 'User-Agent': NY_UA, Referer: 'https://music.163.com/', cookie: 'os=pc' }, timeout: 15000 })
    const j = JSON.parse(r.text)
    const pl = j.result
    if (!pl) throw new Error('歌单获取失败')
    // detail 经常只返回前一小批 tracks（个别歌单仅 10 首，且 trackCount 可能缺失），
    // 故以 track/all 分页作为权威补齐来源，按 id 去重，拉满至 limit 或来源耗尽为止
    let tracks = (pl.tracks || []).map(nyTrack)
    const seen = new Set(tracks.map((t) => t.id))
    const total = pl.trackCount || 0
    let offset = tracks.length
    while (tracks.length < limit) {
      if (total && tracks.length >= total) break
      const pageSize = Math.min(500, limit - tracks.length)
      const pr = await fetchText(`https://music.163.com/api/playlist/track/all?id=${boardId}&offset=${offset}&limit=${pageSize}`, { headers: { 'User-Agent': NY_UA, Referer: 'https://music.163.com/', cookie: 'os=pc' }, timeout: 15000 })
      const pj = JSON.parse(pr.text)
      const songs = (pj.songs || []).map(nyTrack)
      if (!songs.length) break
      for (const s of songs) { if (seen.has(s.id)) continue; seen.add(s.id); tracks.push(s) }
      offset += songs.length
    }
    return tracks.slice(0, limit)
  },

  async lyric(id) {
    try {
      const r = await fetchText(`https://music.163.com/api/song/lyric?id=${id}&lv=1&kv=1&tv=-1`, { headers: { 'User-Agent': NY_UA, Referer: 'https://music.163.com/' }, timeout: 10000 })
      const j = JSON.parse(r.text)
      const lrc = (j.lrc && j.lrc.lyric) || ''
      if (!lrc || !/\[\d{1,2}:\d{2}/.test(lrc)) return ''
      return lrc
    } catch (_) {
      return ''
    }
  },

  async pic(id) {
    try {
      const r = await fetchText(`https://music.163.com/api/song/detail?ids=[${id}]`, { headers: { 'User-Agent': NY_UA, Referer: 'https://music.163.com/' }, timeout: 10000 })
      const j = JSON.parse(r.text)
      const s = j.songs && j.songs[0]
      return (s && s.album && s.album.picUrl) || ''
    } catch (_) {
      return ''
    }
  },

  // 取播放地址：eapi /api/song/enhance/player/url
  async songUrl(id, br = 128000) {
    const url = 'https://interface3.music.163.com/eapi/song/enhance/player/url'
    const params = nyEapiParams('/api/song/enhance/player/url', { ids: `[${id}]`, br })
    const r = await fetchText(url, {
      method: 'POST',
      headers: { 'User-Agent': NY_UA, Referer: 'https://music.163.com/', 'content-type': 'application/x-www-form-urlencoded', cookie: 'os=pc' },
      body: 'params=' + encodeURIComponent(params),
      timeout: 15000,
    })
    const j = JSON.parse(r.text)
    const d = j.data && j.data[0]
    if (!d || !d.url) throw new Error('该歌曲需会员或不可播放')
    return d.url
  },

  // 详情：拿封面 + 名称（用于跨源匹配）
  async detail(id) {
    const r = await fetchText(`https://music.163.com/api/song/detail?ids=[${id}]`, { headers: { 'User-Agent': NY_UA, Referer: 'https://music.163.com/' }, timeout: 10000 })
    const j = JSON.parse(r.text)
    const s = j.songs && j.songs[0]
    if (!s) return null
    return {
      id: String(s.id),
      name: decodeHtml(s.name || ''),
      singer: decodeHtml((s.artists || []).map((a) => a.name).join('、')),
      album: decodeHtml((s.album && s.album.name) || ''),
      cover: (s.album && s.album.picUrl) || '',
      duration: fmtDur(Math.round((s.duration || 0) / 1000)),
    }
  },
}

// 榜单列表（65 个）体积不小且几乎不变：缓存 10 分钟，
// 避免每次 /api/hot 都为了取榜单名而额外拉一次 toplist/detail
let nyBoardsCache = { at: 0, data: [] }
async function nyBoards() {
  if (nyBoardsCache.data.length && Date.now() - nyBoardsCache.at < 10 * 60 * 1000) return nyBoardsCache.data
  const data = await ny.boards()
  if (data && data.length) nyBoardsCache = { at: Date.now(), data }
  return nyBoardsCache.data
}

// ---------- 洛雪自定义源脚本运行时 ----------
const lxRuntime = require('./lxsource')
const SOURCES_DIR = path.join(__dirname, 'sources')
const USER_SOURCES_DIR = process.env.SOURCE_DIR || path.join(__dirname, 'data', 'sources')
const lxSources = new Map() // id -> { meta, runtime, sources }
const lxFailed = new Map()  // id -> { meta, error }  初始化失败的脚本（仍需能在界面删除）

// 在内存里加载并初始化一段脚本代码（不落盘），返回 null 表示初始化失败
async function bootFromCode(code, meta) {
  try {
    const rt = lxRuntime.loadLxSource(code, meta)
    const ready = await rt.ready
    if (!ready.status) return { ok: false, error: ready.error || '初始化失败' }
    return { ok: true, meta, runtime: rt, sources: ready.sources }
  } catch (e) {
    return { ok: false, error: '脚本执行异常: ' + e.message }
  }
}
async function bootLxSource(file, meta) {
  try {
    const code = fs.readFileSync(file, 'utf8')
    const booted = await bootFromCode(code, meta)
    if (!booted.ok) {
      console.warn(`[lx源] ${meta.id} 初始化失败: ${booted.error}`)
      lxFailed.set(meta.id, { meta, error: booted.error })
      lxSources.delete(meta.id)
      return null
    }
    const entry = { meta, runtime: booted.runtime, sources: booted.sources }
    lxSources.set(meta.id, entry)
    lxFailed.delete(meta.id)
    console.log(`[lx源] 已加载 ${meta.id} (${meta.name}) -> ${Object.keys(entry.sources).join(',')}`)
    return entry
  } catch (e) {
    console.warn(`[lx源] ${meta.id} 加载异常: ${e.message}`)
    lxFailed.set(meta.id, { meta, error: e.message })
    lxSources.delete(meta.id)
    return null
  }
}
async function bootAllLxSources() {
  try {
    if (fs.existsSync(SOURCES_DIR)) {
      for (const f of fs.readdirSync(SOURCES_DIR)) {
        if (!f.endsWith('.js')) continue
        const id = f.replace(/\.js$/, '')
        await bootLxSource(path.join(SOURCES_DIR, f), { id, name: id, builtin: true })
      }
    }
    if (fs.existsSync(USER_SOURCES_DIR)) {
      for (const f of fs.readdirSync(USER_SOURCES_DIR)) {
        if (!f.endsWith('.js')) continue
        // id 与文件名保持一致（与导入时的 id 规则相同），否则重启后 id 变化会导致删除找不到文件
        const id = f.replace(/\.js$/, '')
        await bootLxSource(path.join(USER_SOURCES_DIR, f), { id, name: id, builtin: false })
      }
    }
  } catch (e) {
    console.warn('[lx源] 初始化异常:', e.message)
  }
}

// 常用榜单
const BOARDS = [
  { id: '16', name: '热歌榜' },
  { id: '93', name: '飙升榜' },
  { id: '17', name: '新歌榜' },
  { id: '158', name: '抖音热歌榜' },
  { id: '104', name: '华语榜' },
  { id: '22', name: '欧美榜' },
  { id: '182', name: '粤语榜' },
  { id: '183', name: '日语榜' },
  { id: '184', name: '韩语榜' },
  { id: '26', name: '经典怀旧榜' },
  { id: '186', name: 'ACG神曲榜' },
  { id: '64', name: '影视金曲榜' },
]

// ---------- 工具 ----------
function decodeHtml(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)))
    .replace(/&apos;/g, "'")
}
function fmtDur(sec) {
  if (!sec || isNaN(sec)) return '0:00'
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

// ---------- 媒体代理（纠正 MIME / 支持 Range / 流式）----------
// req 显式传入以可靠读取客户端 Range；上游连接级失败由 makeRequest 自动重试
function proxyMedia(req, res, u, { isAudio }) {
  const ct = isAudio ? 'audio/mpeg' : 'image/jpeg'
  const fwd = { 'User-Agent': 'Mozilla/5.0' }
  if (isAudio && req.headers.range) fwd.range = req.headers.range
  if (!isAudio && req.headers.referer) fwd.referer = req.headers.referer
  return makeRequest(u, { headers: fwd, timeout: isAudio ? 60000 : 30000, follow: true })
    .then((r) => {
      if (res.headersSent) {
        r.resume()
        return
      }
      const upCt = String(r.headers['content-type'] || '')
      // 上游返回 HTML（多半是版权提示页/登录页）时不能当音频流给前端
      if (isAudio && /text\/html|application\/json/i.test(upCt)) {
        r.resume()
        res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: '上游返回的不是音频（' + upCt + '），该歌曲可能需要会员或已被平台限制' }))
        return
      }
      const hdrs = {
        'content-type': ct,
        'accept-ranges': 'bytes',
        'cache-control': isAudio ? 'no-store' : 'public, max-age=3600',
      }
      // 透传上游的关键响应头，保证浏览器 Range/缓存/校验正常工作
      for (const k of ['content-range', 'content-length', 'etag', 'last-modified']) {
        if (r.headers[k]) hdrs[k] = r.headers[k]
      }
      res.writeHead(r.statusCode || 200, hdrs)
      r.on('error', () => r.resume())
      res.on('error', () => r.resume())
      r.pipe(res)
    })
    .catch((e) => {
      console.error('[media] proxy error:', e.message)
      if (!res.headersSent) {
        res.writeHead(502)
        res.end('proxy error: ' + e.message)
      }
    })
}

// ---------- 静态资源 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
}
function serveStatic(req, res, filePath) {
  fs.stat(filePath, (err, st) => {
    if (err) { res.writeHead(404); res.end('not found'); return }
    // ETag：内容不变时浏览器复验命中 304（不重传 body），加快重复访问；改动后（size/mtime 变）自动失效
    const etag = `W/"${st.size}-${Math.floor(st.mtimeMs)}"`
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag, 'cache-control': 'no-cache' })
      res.end()
      return
    }
    fs.readFile(filePath, (err2, data) => {
      if (err2) { res.writeHead(404); res.end('not found'); return }
      res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] || 'application/octet-stream', etag, 'cache-control': 'no-cache' })
      res.end(data)
    })
  })
}

// ---------- 跨源匹配：把歌曲匹配到另一个平台的同名版本 ----------
function normTitle(s) {
  return String(s || '').replace(/[\s\-_()（）【】《》\[\]「」"'’,，。.、:：!！?？~～+]/g, '').toLowerCase()
}
// 支持跨源匹配的平台（其余平台的搜索接口已下线，无法跨源）
const MATCH_PLATFORMS = { ny: ny, kw: kw }
async function matchToPlatform(platform, name, singer) {
  if (!name) return null
  const impl = MATCH_PLATFORMS[platform]
  if (!impl) return null
  let list = []
  try {
    list = await impl.search([name, singer].filter(Boolean).join(' '), 12)
  } catch (_) {
    return null
  }
  const n = normTitle(name)
  const ns = normTitle(singer)
  let best = null
  let bestScore = 0
  for (const s of list) {
    const sn = normTitle(s.name)
    let score = 0
    if (sn === n) score += 100
    else if (sn.includes(n) || n.includes(sn)) score += 45
    if (ns && normTitle(s.singer).includes(ns)) score += 30
    if (score > bestScore) { bestScore = score; best = s }
  }
  return bestScore >= 45 ? best : null
}
const matchNetease = (name, singer) => matchToPlatform('ny', name, singer)

// 按洛雪源脚本的约定构造 musicInfo
function buildMusicInfo(source, { id, name, singer }) {
  switch (source) {
    case 'kw': return { songmid: String(id) }
    case 'wy': return { songmid: String(id) }
    case 'tx': return { songmid: String(id), strMediaMid: '' }
    case 'kg': return { hash: String(id), albumId: '' }
    case 'mg': return { songmid: String(id) }
    default: return { songmid: String(id), name, singer }
  }
}

// ---------- 音源选择参数解析 ----------
// 前端传值形如：'auto' | 'ny' | 'kw' | 'lx-mvnuzu5e:kw'（与 /api/sources 的 id 一致）
// 洛雪脚本按协议只实现 musicUrl/lyric/pic，绝大多数不提供搜索与榜单，
// 所以「列表数据（搜索结果 / 榜单）」需要映射到可用的原生引擎，并如实告知前端发生了回退。
const LIST_NATIVE = { ny: 'ny', wy: 'ny', kw: 'kw', kg: 'ny', tx: 'ny', mg: 'ny', qs: 'ny' }
const PLAT_LABEL = { ny: '网易云', wy: '网易云', kw: '酷我', kg: '酷狗', tx: 'QQ音乐', mg: '咪咕', qs: '汽水音乐' }
function parseSourceParam(raw) {
  const key = String(raw || '').trim()
  if (!key || key === 'auto') return { key: 'auto', kind: 'auto', plat: 'ny' }
  if (key.includes(':')) {
    const [sid, plat] = key.split(':')
    const entry = lxSources.get(sid)
    const info = entry ? sourceMeta(entry, plat) : null
    if (!entry || !info) return { key, kind: 'missing', plat }
    return { key, kind: 'lx', script: sid, entry, plat, info }
  }
  return { key, kind: 'native', plat: key }
}
const listNative = (plat) => LIST_NATIVE[plat] || 'ny'
// 列表数据是否并非来自用户所选平台（= 发生了回退）
const isListFallback = (pref, plat) => pref.kind !== 'auto' && plat !== pref.plat

// 只保留脚本取址需要的关键字段，避免把整条搜索结果塞进播放请求
const RAW_KEEP = ['songmid', 'id', 'hash', 'albumId', 'strMediaMid', 'copyrightId', 'albumAudioId', 'name', 'singer', 'albumName', 'album']
function pickMusicInfo(it) {
  const o = {}
  for (const k of RAW_KEEP) if (it && it[k] != null) o[k] = it[k]
  return o
}
// 洛雪脚本 musicSearch 的返回结构：{ list: [{ name, singer, albumName, interval, songmid, img, ... }], total, limit, page }
function normalizeLxSearch(res, plat) {
  const arr = Array.isArray(res) ? res : (res && Array.isArray(res.list) ? res.list : [])
  const strip = (s) => String(s == null ? '' : s).replace(/<[^>]*>/g, '').trim()
  const out = []
  for (const it of arr) {
    if (!it) continue
    const singer = Array.isArray(it.singer) ? it.singer.map(strip).join('、') : it.singer
    const id = it.songmid || it.id || it.hash || it.songId || it.copyrightId || it.albumAudioId || ''
    if (!id) continue
    const interval = it.interval || it.duration || ''
    out.push({
      id: String(id),
      source: plat,
      name: strip(it.name),
      singer: strip(singer),
      album: strip(it.albumName || it.album || ''),
      duration: /^\d+$/.test(String(interval)) ? fmtDur(Math.round(Number(interval))) : strip(interval),
      cover: it.img || it.pic || it.picUrl || '',
      raw: pickMusicInfo(it),
    })
  }
  return out
}

// 用「指定的音源条目」取播放地址。
// entryKey 形如 'ny' / 'kw' / '脚本id:音源名'（与 /api/sources 返回的 id 一致）
async function resolveViaEntry(entryKey, song) {
  const { id, source, name, singer, raw } = song
  if (entryKey === 'ny') {
    let nid = id
    if (source !== 'ny') {
      const m = await matchToPlatform('ny', name, singer)
      if (!m) throw new Error('无法在网易云匹配到同名歌曲')
      nid = m.id
    }
    return { url: await ny.songUrl(nid), via: 'ny', sourceName: '网易云音乐' }
  }
  if (entryKey === 'kw') {
    // 酷我原生取址已被官方关闭，只能借助洛雪脚本
    let kid = id
    if (source !== 'kw') {
      const m = await matchToPlatform('kw', name, singer)
      if (!m) throw new Error('无法在酷我匹配到同名歌曲')
      kid = m.id
    }
    let lastErr = null
    for (const [sid, entry] of lxSources) {
      const info = sourceMeta(entry, 'kw')
      if (!info || !(info.actions || []).includes('musicUrl')) continue
      try {
        const url = await entry.runtime.call('musicUrl', 'kw', { musicInfo: { songmid: String(kid) }, type: '128k' })
        return { url, via: sid + '/kw', sourceName: info.name || '酷我音乐' }
      } catch (e) {
        lastErr = e
      }
    }
    throw lastErr || new Error('没有可用的酷我取址音源（需导入洛雪源脚本）')
  }
  const [sid, src] = entryKey.split(':')
  const entry = lxSources.get(sid)
  if (!entry) throw new Error('音源脚本不存在：' + sid)
  const info = sourceMeta(entry, src)
  if (!info) throw new Error('脚本内不存在音源：' + src)
  if (!(info.actions || []).includes('musicUrl')) throw new Error('该音源不支持取址')
  let sid2 = id
  // 网易云(ny) 与 网易(wy) 是同一套 songmid，id 可直接互用，无需跨源匹配
  const sameIdSpace = (a, b) => a === b || ((a === 'wy' || a === 'ny') && (b === 'wy' || b === 'ny'))
  // 列表项自带的脚本原始字段（hash / strMediaMid / albumId ...）只有在其所属平台与目标音源一致时才能直接用
  const rawUsable = raw && typeof raw === 'object' && raw._p && sameIdSpace(raw._p, src)
  if (!rawUsable && source !== src && !sameIdSpace(source, src)) {
    const m = await matchToPlatform(src, name, singer)
    if (!m) throw new Error('无法在 ' + src + ' 匹配到同名歌曲')
    sid2 = m.id
  }
  let musicInfo
  if (rawUsable) {
    musicInfo = { ...raw }
    delete musicInfo._p
    musicInfo.name = name
    musicInfo.singer = singer
  } else {
    musicInfo = buildMusicInfo(src, { id: sid2, name, singer })
  }
  const q = (info.qualitys && info.qualitys[0]) || '128k'
  const url = await entry.runtime.call('musicUrl', src, { musicInfo, type: q })
  return { url, via: sid + '/' + src, sourceName: info.name || src }
}

// 取播放地址：指定音源 -> 原生音源 -> 洛雪源脚本 -> 跨源匹配
async function resolveSongUrl({ id, source, name, singer, prefer, raw }) {
  const errors = []
  // 0) 用户手动指定的音源优先
  if (prefer && prefer !== 'auto') {
    try {
      const r = await resolveViaEntry(prefer, { id, source, name, singer, raw })
      if (r && r.url) return r
      errors.push('指定音源(' + prefer + '):未取到地址')
    } catch (e) {
      errors.push('指定音源(' + prefer + '):' + e.message)
    }
  }
  if (source === 'ny') {
    try {
      return { url: await ny.songUrl(id), via: 'ny', sourceName: '网易云音乐' }
    } catch (e) {
      errors.push('网易:' + e.message)
    }
  }
  for (const [sid, entry] of lxSources) {
    const info = sourceMeta(entry, source)
    if (!info || !(info.actions || []).includes('musicUrl')) continue
    try {
      const musicInfo = buildMusicInfo(source, { id, name, singer })
      const url = await entry.runtime.call('musicUrl', source, { musicInfo, type: '128k' })
      return { url, via: sid + '/' + source, sourceName: info.name || source }
    } catch (e) {
      errors.push(`${sid}/${source}:${e.message}`)
    }
  }
  if (source !== 'ny' && name) {
    try {
      const m = await matchNetease(name, singer)
      if (m) return { url: await ny.songUrl(m.id), via: 'ny(跨源匹配)', sourceName: '网易云音乐(跨源匹配)' }
      errors.push('跨源匹配未命中')
    } catch (e) {
      errors.push('跨源匹配:' + e.message)
    }
  }
  throw new Error(errors.join(' | ') || '暂无可用音源')
}

// 各音源的测试样本（用于"测试"按钮验证取址能力是否可用）
// 同一首歌在不同平台的 id 形态不同，这里给出该平台可用的 id
const SOURCE_SAMPLES = {
  kw: { ids: { songmid: '228908' }, name: '晴天', singer: '周杰伦' },
  wy: { ids: { songmid: '5257138' }, name: '屋顶', singer: '周杰伦' },
  tx: { ids: { songmid: '001fsNdn1zuZnA', strMediaMid: '000ao2Na47ZtsG' }, name: '我不难过', singer: '张芸京' },
  kg: { ids: { hash: 'b3a52a7a958bf0aed0ebfba2e9a818b7', albumId: '966846' }, name: '晴天', singer: '周杰伦' },
  mg: { ids: { songmid: '6000000001372634' }, name: '样本', singer: '样本' },
}
// 未知平台的兜底：依次尝试不同 id 形态（很多源只认其中一种）
const GENERIC_ID = '5257138'
function candidateMusicInfos(src) {
  const s = SOURCE_SAMPLES[src]
  const list = []
  if (s) list.push(s.ids)
  list.push({ songmid: GENERIC_ID })
  list.push({ songId: GENERIC_ID })
  list.push({ id: GENERIC_ID })
  list.push({ songmid: GENERIC_ID, strMediaMid: '000ao2Na47ZtsG' })
  list.push({ hash: 'b3a52a7a958bf0aed0ebfba2e9a818b7', albumId: '966846' })
  return list
}
// 洛雪源脚本注册结构：官方是 sources[src] = apiInfo.info（扁平），部分社区脚本写成 sources[src].info
function sourceMeta(entry, src) {
  const raw = entry.sources[src]
  if (!raw) return null
  return raw.info && typeof raw.info === 'object' ? raw.info : raw
}

// 导入去重：同一份脚本只保留一份，避免音源列表被重复条目刷屏
function findExistingScript(code) {
  if (!fs.existsSync(USER_SOURCES_DIR)) return null
  const hash = crypto.createHash('md5').update(code).digest('hex')
  for (const f of fs.readdirSync(USER_SOURCES_DIR)) {
    if (!f.endsWith('.js')) continue
    try {
      const c = fs.readFileSync(path.join(USER_SOURCES_DIR, f), 'utf8')
      if (crypto.createHash('md5').update(c).digest('hex') === hash) return f.replace(/\.js$/, '')
    } catch (_) {}
  }
  return null
}

// ---------- API 路由 ----------
function sendJSON(res, obj, code = 200) {
  const s = JSON.stringify(obj)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(s)
}
async function readBody(req) {
  let raw = ''
  for await (const chunk of req) raw += chunk
  try { return JSON.parse(raw || '{}') } catch (_) { return {} }
}

async function handleApi(req, res, pathname, query) {
  try {
    // 列表类接口统一支持 source（'auto' | 'ny' | 'kw' | '脚本id:音源名'），
    // 没有传时等价于 'auto' -> 用网易云兜底，保证列表永远有数据
    if (pathname === '/api/boards') {
      const pref = parseSourceParam(query.get('source') || query.get('from') || 'auto')
      const plat = listNative(pref.plat)
      let boards = []
      let note = ''
      try {
        boards = plat === 'kw' ? BOARDS.map((b) => ({ ...b })) : await nyBoards()
      } catch (_) {
        boards = []
      }
      if (!boards.length && plat !== 'ny') {
        // 目标引擎拿不到榜单：回退网易云，并如实告知
        boards = await nyBoards().catch(() => [])
        note = `${PLAT_LABEL[pref.plat] || pref.plat}榜单不可用，已回退网易云`
        if (!boards.length) boards = BOARDS.map((b) => ({ ...b }))
      }
      if (!boards.length) boards = BOARDS.map((b) => ({ ...b }))
      if (pref.kind === 'lx') {
        // 洛雪协议里没有「榜单」动作，脚本只提供取址能力
        note = note || `该脚本未提供榜单接口，榜单来自${PLAT_LABEL[plat] || plat}，播放仍用所选音源`
      } else if (isListFallback(pref, plat)) {
        note = note || `${PLAT_LABEL[pref.plat] || pref.plat}无榜单接口，榜单来自${PLAT_LABEL[plat] || plat}`
      }
      return sendJSON(res, {
        boards: boards.map((b) => ({ ...b, source: plat, from: plat })),
        source: plat,
        via: 'native:' + plat,
        requested: pref.key,
        fallback: isListFallback(pref, plat),
        note,
      })
    }
    // ---------- 第三方平台「热门歌单」列表（仅网易云/QQ/酷狗可免登录抓取） ----------
    async function qqPlaylists(limit = 20) {
      const url = 'https://c.y.qq.com/splcloud/fcgi-bin/fcg_get_diss_by_tag.fcg?g_tk=5381&loginUin=0&hostUin=0'
        + '&format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq&needNewCode=0'
        + '&categoryId=10000000&sortId=5&sin=0&ein=' + (limit - 1) + '&rnd=0.1'
      const r = await fetchText(url, { headers: { Referer: 'https://y.qq.com/portal/playlist.html', 'User-Agent': NY_UA }, timeout: 15000 })
      const j = JSON.parse(r.text)
      const list = (j.data && j.data.list) || []
      return list.slice(0, limit).map((it) => ({
        id: String(it.dissid),
        name: decodeHtml(it.dissname || ''),
        cover: (it.imgurl || '').replace('http://', 'https://'),
        playCount: it.listennum || 0,
        creator: (it.creator && it.creator.name) || '',
      }))
    }
    async function kgPlaylists(limit = 20) {
      const url = 'http://mobilecdnbj.kugou.com/api/v3/tag/specialList?plat=0&page=1&tagid=0&pagesize=' + limit + '&ugc=1&sort=2&with_cover=1'
      const r = await fetchText(url, { headers: { Referer: 'https://www.kugou.com/', 'User-Agent': NY_UA }, timeout: 15000 })
      const j = JSON.parse(r.text)
      const list = (j.data && j.data.info) || []
      return list.slice(0, limit).map((it) => ({
        id: String(it.specialid),
        name: decodeHtml(it.specialname || ''),
        cover: (it.imgurl || '').replace(/\{size\}/g, '400'),
        playCount: it.playcount || 0,
        creator: it.username || '',
      }))
    }
    // 歌单歌曲详情：网易云可用；QQ/酷狗的歌曲详情接口多为签名/风控保护，多数情况下会失败
    async function qqPlaylistSongs(disstid, limit = 100) {
      const url = 'https://c.y.qq.com/v8/fcg-bin/fcg_v8_playlist_cp.fcg?type=1&disstid=' + disstid
        + '&format=json&g_tk=5381&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq&needNewCode=0&uin=0&hostUin=0'
      const r = await fetchText(url, { headers: { Referer: 'https://y.qq.com/portal/playlist.html', 'User-Agent': NY_UA }, timeout: 15000 })
      const j = JSON.parse(r.text)
      if (j.code !== 0) throw new Error('qq playlist code ' + j.code)
      const cd = (j.data && j.data.cdlist && j.data.cdlist[0]) || null
      if (!cd) throw new Error('qq playlist empty')
      return (cd.songlist || []).slice(0, limit).map((s) => ({
        id: String(s.songmid),
        name: decodeHtml(s.songname || ''),
        singer: decodeHtml((s.singer || []).map((x) => x.name).join('/')),
        album: decodeHtml(s.albumname || ''),
        duration: fmtDur(parseInt(s.interval) || 0),
        cover: '',
        source: 'tx',
      }))
    }
    async function kgPlaylistSongs(specialid, limit = 100) {
      const url = 'http://mobilecdnbj.kugou.com/api/v3/special/songList?specialid=' + specialid + '&page=1&pagesize=' + limit + '&plat=0&version=9108&area_code=1'
      const r = await fetchText(url, { headers: { Referer: 'https://www.kugou.com/', 'User-Agent': NY_UA }, timeout: 15000 })
      const j = JSON.parse(r.text)
      const list = (j.data && j.data.info) || []
      return list.slice(0, limit).map((it) => ({
        id: String(it.hash),
        name: decodeHtml(it.songname || ''),
        singer: decodeHtml(it.singername || ''),
        album: decodeHtml(it.album_name || ''),
        duration: fmtDur(parseInt(it.duration) || 0),
        cover: (it.imgurl || '').replace(/\{size\}/g, '400'),
        source: 'kg',
      }))
    }

    if (pathname === '/api/playlists') {
      const plat = query.get('platform') || 'ny'
      const limit = Math.min(parseInt(query.get('limit')) || 20, 40)
      let list = [], note = '', source = plat
      try {
        if (plat === 'tx') list = await qqPlaylists(limit)
        else if (plat === 'kg') list = await kgPlaylists(limit)
        else list = await ny.playlists(limit)
      } catch (_) { list = [] }
      if (!list.length) {
        // 该平台歌单接口受限，回退网易云并如实说明
        try { list = await ny.playlists(limit) } catch (_) {}
        if (list.length) { note = (plat === 'tx' ? 'QQ音乐' : plat === 'kg' ? '酷狗' : plat) + '歌单接口受限，已回退网易云'; source = 'ny' }
      }
      return sendJSON(res, { playlists: list, source, note })
    }
    if (pathname === '/api/playlist') {
      const id = query.get('id')
      const plat = query.get('platform') || 'ny'
      const limit = Math.min(parseInt(query.get('limit')) || 1000, 2000)
      let list = [], note = '', source = plat
      try {
        if (plat === 'ny') list = await ny.hot(id, limit)
        else if (plat === 'tx') list = await qqPlaylistSongs(id, limit)
        else if (plat === 'kg') list = await kgPlaylistSongs(id, limit)
        else list = await ny.hot(id, limit)
      } catch (e) {
        note = (plat === 'tx' ? 'QQ音乐' : plat === 'kg' ? '酷狗' : plat) + '歌单歌曲接口受限，暂无法播放'
        list = []
      }
      return sendJSON(res, { list, source, note })
    }
    // ---------- 粘贴歌单链接：多平台解析 → [{name, artist}] ----------
    // 解析网易云/QQ/千千/酷狗/酷我/KKBOX/Apple/Spotify 歌单链接，返回曲目（曲名+歌手），
    // 供前端把结果灌进 /api/match 逐首匹配播放。
    if (pathname === '/api/parse_playlist') {
      const url = (query.get('url') || '').trim()
      if (!url) return sendJSON(res, { ok: false, error: '缺少 url' }, 400)
      const result = await parsers.parse(url, fetchText)
      return sendJSON(res, result)
    }
    // ---------- 粘贴歌单/曲目：按「歌名+歌手」逐条搜索，返回每条的最匹配一首 ----------
    // QQ/酷狗歌单曲目接口被平台封死（签名/WAF），改为用户贴曲目文本，搜索引擎逐首匹配后播放
    if (pathname === '/api/match') {
      const payload = await readBody(req)
      const items = Array.isArray(payload.items) ? payload.items.slice(0, 80) : []
      // 引擎选择：网易匿名搜索接口被污染（"晴天 周杰伦"前10全是翻唱/搬运号），
      // 酷我 search.kuwo.cn 排序正常（原唱第一），故默认（auto）走酷我；显式选网易才走网易
      const reqSrc = String(payload.source || 'auto')
      let plat
      if (reqSrc === 'auto' || reqSrc === 'kw') plat = 'kw'
      else {
        const pref = parseSourceParam(reqSrc)
        plat = listNative(pref.plat)
      }
      // 候选打分：规范化后歌名须相等/互相包含（门槛），歌手吻合加分、不符扣分（挡翻唱/搬运号）
      const norm = (s) => String(s || '').toLowerCase()
        .replace(/[（(【\[「『].*?[）)】\]」』]/g, '')
        .replace(/[\s\-–—_:：,，。.、·/'"]+/g, '')
      const scoreOf = (it, s) => {
        const qn = norm(it.name), cn = norm(s.name)
        if (!qn || !cn) return -1
        // 歌名门槛：相等，或结果名包含歌名，或歌名包含结果名（此时结果名须 ≥ 歌名长度60%，
        // 挡"不存在的歌曲xyzabc999"匹配到"XYZ"这类短子串钻空）
        const nameOk = cn === qn ||
          (cn.includes(qn) && qn.length >= 2) ||
          (qn.includes(cn) && cn.length >= Math.max(2, Math.floor(qn.length * 0.6)))
        if (!nameOk) return -1
        let sc = cn === qn ? 3 : 1
        const qa = norm(it.artist), cs = norm(s.singer)
        if (qa) sc += (cs && (cs.includes(qa) || qa.includes(cs))) ? 3 : -2
        return sc
      }
      // 并发池：同时最多 6 路搜索，避免 80 首串行拖到几十秒
      const results = new Array(items.length)
      let cursor = 0
      const worker = async () => {
        while (cursor < items.length) {
          const i = cursor++
          const it = items[i] || {}
          const q = [it.name, it.artist].filter(Boolean).join(' ').trim()
          if (!q) { results[i] = { ok: false, query: it, reason: '空行' }; continue }
          try {
            const list = plat === 'kw' ? await kw.search(q, 8) : await ny.search(q, 8)
            let hit = null, best = 0
            for (const s of list || []) {
              const sc = scoreOf(it, s)
              if (sc > best) { best = sc; hit = s }
            }
            results[i] = hit ? { ok: true, query: it, song: hit } : { ok: false, query: it, reason: '未找到匹配' }
          } catch (_) {
            results[i] = { ok: false, query: it, reason: '搜索失败' }
          }
        }
      }
      await Promise.all(Array.from({ length: Math.max(1, Math.min(6, items.length)) }, worker))
      const matched = results.filter((r) => r.ok).length
      return sendJSON(res, { results, matched, total: items.length, source: plat })
    }
    if (pathname === '/api/search') {
      const type = query.get('type') || 'song'
      const kw2 = (query.get('keyword') || '').trim()
      const limit = Math.min(parseInt(query.get('limit')) || (type === 'playlist' ? 20 : 100), 200)
      if (!kw2) return sendJSON(res, { error: '缺少 keyword' }, 400)
      const pref = parseSourceParam(query.get('source') || query.get('from') || 'auto')
      // 歌单搜索：固定走网易云（歌单详情接口已验证可用，可完整取歌），与单曲搜索的来源选择无关
      if (type === 'playlist') {
        try {
          const playlists = await ny.searchPlaylist(kw2, limit)
          return sendJSON(res, { playlists, source: 'ny', type: 'playlist' })
        } catch (e) {
          return sendJSON(res, { playlists: [], source: 'ny', type: 'playlist', note: '歌单搜索失败：' + e.message })
        }
      }
      // 1) 脚本自带搜索（少数脚本实现 musicSearch）
      let usedScriptSearch = false
      if (pref.kind === 'lx' && (pref.info.actions || []).includes('musicSearch')) {
        try {
          const r0 = await pref.entry.runtime.call('musicSearch', pref.plat, { text: kw2, limit, page: 1 })
          const list = normalizeLxSearch(r0, pref.plat)
          if (list.length) {
            usedScriptSearch = true
            return sendJSON(res, { list, source: pref.plat, from: pref.plat, via: 'lx:' + pref.script, requested: pref.key, fallback: false })
          }
        } catch (_) { /* 回落到原生搜索 */ }
      }
      // 2) 原生搜索引擎（平台 id 空间与列表数据一致，播放时可直接取址）
      const plat = listNative(pref.plat)
      let list = []
      let note = ''
      try {
        list = plat === 'kw' ? await kw.search(kw2, limit) : await ny.search(kw2, limit)
      } catch (e) {
        if (plat === 'ny') throw e
        list = await ny.search(kw2, limit)
        note = `${PLAT_LABEL[pref.plat] || pref.plat}搜索失败，已回退网易云`
      }
      if (pref.kind === 'lx' && !usedScriptSearch) {
        note = note || `该脚本未提供搜索接口，列表来自${PLAT_LABEL[plat] || plat}，播放仍用所选音源`
      } else if (isListFallback(pref, plat)) {
        note = note || `${PLAT_LABEL[pref.plat] || pref.plat}无搜索接口，列表来自${PLAT_LABEL[plat] || plat}`
      }
      return sendJSON(res, { list, source: plat, from: plat, via: 'native:' + plat, requested: pref.key, fallback: isListFallback(pref, plat), note })
    }
    if (pathname === '/api/hot') {
      const pref = parseSourceParam(query.get('source') || query.get('from') || 'auto')
      const plat = listNative(pref.plat)
      const board = query.get('board') || (plat === 'kw' ? '16' : '3778678')
      const limit = Math.min(parseInt(query.get('limit')) || 100, 200)
      let list = []
      let name = board
      let note = ''
      try {
        if (plat === 'kw') {
          list = await kw.hot(board, limit)
        } else {
          list = await ny.hot(board, limit)
          const meta = (await nyBoards().catch(() => [])).find((b) => String(b.id) === String(board))
          name = meta ? meta.name : board
        }
      } catch (e) {
        if (plat === 'ny') throw e
        list = await ny.hot('3778678', limit)
        name = '热歌榜'
        note = `${PLAT_LABEL[pref.plat] || pref.plat}榜单获取失败，已回退网易云`
      }
      if (pref.kind === 'lx') {
        note = note || `该脚本未提供榜单接口，榜单来自${PLAT_LABEL[plat] || plat}，播放仍用所选音源`
      } else if (isListFallback(pref, plat)) {
        note = note || `${PLAT_LABEL[pref.plat] || pref.plat}无榜单接口，榜单来自${PLAT_LABEL[plat] || plat}`
      }
      return sendJSON(res, { list, board: name, source: plat, from: plat, via: 'native:' + plat, requested: pref.key, fallback: isListFallback(pref, plat), note })
    }
    if (pathname === '/api/song') {
      const id = query.get('id')
      if (!id) return sendJSON(res, { error: '缺少 id' }, 400)
      const source = query.get('source') || 'ny'
      const name = query.get('name') || ''
      const singer = query.get('singer') || ''
      const prefer = query.get('prefer') || ''
      // raw = 列表项携带的脚本原始字段（hash / strMediaMid / albumId ...），
      // 交给脚本取址比只带一个 id 更可靠
      let raw = null
      const rawStr = query.get('raw')
      if (rawStr) {
        try {
          const parsed = JSON.parse(rawStr)
          if (parsed && typeof parsed === 'object') raw = parsed
        } catch (_) { raw = null }
      }
      // 取播放址 与 封面 并行（原为串行，切歌时两段上游调用叠加导致卡顿）
      const coverParam = query.get('cover')
      const [r, coverVal] = await Promise.all([
        resolveSongUrl({ id, source, name, singer, prefer, raw }),
        (async () => {
          if (coverParam && /^https?:\/\//.test(coverParam)) return coverParam
          if (source === 'ny') return await ny.pic(id).catch(() => '')
          return await kw.fillCover({ id, name }).then((s) => s.cover || '').catch(() => '')
        })(),
      ])
      const song = { id, url: r.url, via: r.via, sourceName: r.sourceName || '', source, cover: coverVal }
      return sendJSON(res, song)
    }
    if (pathname === '/api/lyric') {
      const id = query.get('id')
      if (!id) return sendJSON(res, { error: '缺少 id' }, 400)
      const source = query.get('source') || 'ny'
      const lyric = source === 'kw' ? await kw.lyric(id) : await ny.lyric(id)
      return sendJSON(res, { lyric })
    }
    if (pathname === '/api/audio') {
      const u = query.get('u')
      if (!u) return sendJSON(res, { error: '缺少 u' }, 400)
      return proxyMedia(req, res, u, { isAudio: true })
    }
    if (pathname === '/api/cover') {
      const u = query.get('u')
      if (u) return proxyMedia(req, res, u, { isAudio: false })
      const id = query.get('id')
      if (id) {
        const picUrl = await ny.pic(id).catch(() => '')
        if (!picUrl) return sendJSON(res, { error: '无封面' }, 404)
        return proxyMedia(req, res, picUrl, { isAudio: false })
      }
      return sendJSON(res, { error: '缺少 u 或 id' }, 400)
    }
    // ---- 洛雪音源管理 ----
    if (pathname === '/api/sources') {
      const list = []
      list.push({ id: 'ny', name: '网易云音乐', type: 'native', actions: ['musicUrl'], qualitys: ['128k', '320k'] })
      list.push({ id: 'kw', name: '酷我音乐', type: 'native', actions: [], qualitys: [], note: '取址已被官方关闭，自动跨源匹配到网易云' })
      for (const [sid, entry] of lxSources) {
        for (const [src, raw] of Object.entries(entry.sources)) {
          const info = sourceMeta(entry, src) || raw
          list.push({
            id: `${sid}:${src}`,
            name: info.name || src,
            type: 'lx',
            script: sid,
            source: src,
            actions: info.actions || [],
            qualitys: info.qualitys || [],
            builtin: !!entry.meta.builtin,
          })
        }
      }
      // 初始化失败的脚本也要列出来，否则用户没法在界面删除这些残留文件
      for (const [sid, f] of lxFailed) {
        list.push({
          id: sid,
          name: sid,
          type: 'lx',
          script: sid,
          source: sid,
          actions: [],
          qualitys: [],
          builtin: !!f.meta.builtin,
          failed: true,
          error: f.error,
        })
      }
      return sendJSON(res, { sources: list })
    }
    if (pathname === '/api/source/import') {
      if (req.method !== 'POST') return sendJSON(res, { error: '需要 POST' }, 405)
      let raw = ''
      for await (const chunk of req) raw += chunk
      let payload = {}
      try { payload = JSON.parse(raw || '{}') } catch (_) {}
      const idBase = (payload.id || 'user').replace(/[^\w.-]/g, '')
      let code = payload.code
      if (!code && payload.url) {
        const r = await fetchText(payload.url, { timeout: 20000 })
        if (r.status !== 200) return sendJSON(res, { error: '下载失败 HTTP ' + r.status }, 502)
        code = r.text
      }
      if (!code) return sendJSON(res, { error: '缺少 code 或 url' }, 400)
      // 同一份脚本已存在则不重复导入
      const exists = findExistingScript(code)
      if (exists) {
        const entry0 = lxSources.get(exists)
        return sendJSON(res, {
          ok: true,
          duplicate: true,
          id: exists,
          sources: entry0 ? Object.keys(entry0.sources) : [],
          message: '该脚本已存在（' + exists + '），未重复导入',
        })
      }
      const id = `${idBase}-${Date.now().toString(36)}`
      fs.mkdirSync(USER_SOURCES_DIR, { recursive: true })
      fs.writeFileSync(path.join(USER_SOURCES_DIR, id + '.js'), code)
      const entry = await bootLxSource(path.join(USER_SOURCES_DIR, id + '.js'), { id, name: id })
      if (!entry) {
        try { fs.unlinkSync(path.join(USER_SOURCES_DIR, id + '.js')) } catch (_) {}
        return sendJSON(res, { error: '源脚本初始化失败（格式不支持或接口异常）' }, 400)
      }
      return sendJSON(res, { ok: true, id, sources: Object.keys(entry.sources) })
    }
    // ---- 轻量预检 ----
    // 只剔除明显不是洛雪源脚本 / 有风险的样本；
    // 真正的可用性交给下面的试运行（真实取址）判定，静态特征不可靠。
    const MAX_PROBE_CODE = 800 * 1024
    function litePrecheck(code) {
      if (!code || !code.trim()) return '空文件'
      const size = Buffer.byteLength(code, 'utf8')
      if (size < 1024) return '文件过小（<1KB），不像源脚本'
      if (size > MAX_PROBE_CODE) return '文件过大（>800KB）'
      if (!/lx/.test(code)) return '未出现 lx，不是洛雪源脚本'
      if (/child_process|require\(\s*['"](?:fs|net|http|vm)/.test(code)) return '试图使用沙箱未提供的模块'
      if (/process\.binding|\beval\(/.test(code)) return '包含高危调用'
      return null
    }
    // ---- 试运行：在内存里加载脚本并测试取址，不落盘、不改动线上状态 ----
    // 供音源自动搜罗器在「导入前」判断一个脚本是否真的可用，
    // 比静态特征判断可靠（同名文件可能是别的用途，仓库也可能已失效）
    if (pathname === '/api/source/probe') {
      if (req.method !== 'POST') return sendJSON(res, { error: '需要 POST' }, 405)
      const payload = await readBody(req)
      let code = payload.code
      if (!code && payload.url) {
        const r = await fetchText(payload.url, { timeout: 20000 })
        if (r.status !== 200) return sendJSON(res, { ok: false, error: '下载失败 HTTP ' + r.status }, 502)
        code = r.text
      }
      if (!code || !code.trim()) return sendJSON(res, { ok: false, error: '缺少 code 或 url' }, 400)
      const why = litePrecheck(code)
      if (why) return sendJSON(res, { ok: false, error: why })
      const booted = await bootFromCode(code, { id: 'probe', name: 'probe' })
      if (!booted.ok) return sendJSON(res, { ok: false, error: booted.error })
      const sources = Object.keys(booted.sources)
      const details = []
      for (const src of sources) {
        const info = sourceMeta({ sources: booted.sources }, src) || {}
        const acts = info.actions || []
        if (!acts.includes('musicUrl')) {
          details.push({ source: src, name: info.name || src, actions: acts, urlOk: false, error: '该音源不支持取址' })
          continue
        }
        const q = (info.qualitys && info.qualitys[0]) || '128k'
        const t0 = Date.now()
        let urlOk = false
        let via = ''
        let err = ''
        // 逐个尝试 id 形态，任一成功即认为该音源可用
        for (const musicInfo of candidateMusicInfos(src)) {
          try {
            const u = await booted.runtime.call('musicUrl', src, { musicInfo, type: q })
            if (u) { urlOk = true; via = String(u).split('/')[2] || ''; break }
          } catch (e) {
            err = e.message || String(e)
          }
        }
        details.push({ source: src, name: info.name || src, actions: acts, urlOk, via, ms: Date.now() - t0, error: urlOk ? '' : err })
      }
      return sendJSON(res, { ok: true, sources: details })
    }
    // ---- 音源测试：验证某个音源能否取到播放地址 ----
    if (pathname === '/api/source/test') {
      if (req.method !== 'POST') return sendJSON(res, { error: '需要 POST' }, 405)
      const payload = await readBody(req)
      const id = String(payload.id || '')
      const song = payload.song || null
      const t0 = Date.now()
      try {
        let url = ''
        let via = ''
        if (id === 'ny') {
          const sid = (song && song.id) || '5257138'
          url = await ny.songUrl(sid)
          via = 'ny'
        } else if (id === 'kw') {
          const s = song || { id: '228908', name: '晴天', singer: '周杰伦' }
          const r = await resolveSongUrl({ id: s.id, source: 'kw', name: s.name || '晴天', singer: s.singer || '周杰伦' })
          url = r.url
          via = r.via
        } else {
          const [sid, src] = id.split(':')
          const entry = lxSources.get(sid)
          if (!entry) {
            const f = lxFailed.get(sid)
            throw new Error(f ? ('源脚本初始化失败：' + f.error) : ('音源脚本不存在：' + sid))
          }
          const info = sourceMeta(entry, src)
          if (!info) throw new Error('脚本内不存在音源：' + src)
          if (!(info.actions || []).includes('musicUrl')) throw new Error('该音源不支持取址')
          const q = (info.qualitys && info.qualitys[0]) || '128k'
          // 不同平台的 id 形态不一样，依次尝试直到取到地址
          const candidates = song ? [buildMusicInfo(src, song)] : candidateMusicInfos(src)
          let lastErr = null
          for (const musicInfo of candidates) {
            try {
              const u = await entry.runtime.call('musicUrl', src, { musicInfo, type: q })
              if (u) {
                url = u
                via = sid + '/' + src
                break
              }
            } catch (e) {
              lastErr = e
            }
          }
          if (!url) throw lastErr || new Error('该音源未返回播放地址')
        }
        return sendJSON(res, { ok: true, url, via, ms: Date.now() - t0 })
      } catch (e) {
        return sendJSON(res, { ok: false, error: e.message, ms: Date.now() - t0 })
      }
    }
    // ---- 删除音源脚本（仅限用户导入的）----
    if (pathname.startsWith('/api/source/') && req.method === 'DELETE') {
      const sid = decodeURIComponent(pathname.slice('/api/source/'.length)).replace(/[^\w.-]/g, '')
      if (!sid) return sendJSON(res, { error: '缺少音源 id' }, 400)
      const entry = lxSources.get(sid)
      const failed = lxFailed.get(sid)
      if (!entry && !failed) return sendJSON(res, { error: '音源脚本不存在：' + sid }, 404)
      if ((entry && entry.meta.builtin) || (failed && failed.meta.builtin)) {
        return sendJSON(res, { error: '内置音源脚本不可删除' }, 403)
      }
      const file = path.join(USER_SOURCES_DIR, sid + '.js')
      try {
        if (fs.existsSync(file)) fs.unlinkSync(file)
      } catch (e) {
        return sendJSON(res, { error: '删除文件失败：' + e.message }, 500)
      }
      lxSources.delete(sid)
      lxFailed.delete(sid)
      console.log(`[lx源] 已删除 ${sid}`)
      return sendJSON(res, { ok: true, id: sid })
    }
    return sendJSON(res, { error: 'unknown api' }, 404)
  } catch (e) {
    return sendJSON(res, { error: e.message }, 502)
  }
}

// ---------- 主服务器 ----------
const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`)
  const pathname = u.pathname
  const t0 = Date.now()
  res.on('finish', () => {
    console.log(`[req] ${req.method} ${pathname} -> ${res.statusCode} ${Date.now() - t0}ms`)
  })
  if (pathname.startsWith('/api/')) return handleApi(req, res, pathname, u.searchParams)

  let rel = pathname === '/' ? '/index.html' : pathname
  const filePath = path.normalize(path.join(WEB_DIR, rel))
  if (!filePath.startsWith(WEB_DIR)) {
    res.writeHead(403)
    res.end('forbidden')
    return
  }
  serveStatic(req, res, filePath)
})

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', async () => {
    console.log(`lx-music-web 已启动: http://0.0.0.0:${PORT}`)
    await bootAllLxSources()
  })
}

// 供测试/脚本直接调用内部实现（node server.js 时不会触发）
module.exports = { server, fetchText, makeRequest, ny, kw, lxSources, resolveSongUrl, bootAllLxSources }
