'use strict'

// ---------- API ----------
const API = {
  boards: (source) => fetchJSON('/api/boards' + (source ? `?source=${encodeURIComponent(source)}` : '')),
  hot: (board, limit = 100, source) =>
    fetchJSON(`/api/hot?board=${encodeURIComponent(board)}&limit=${limit}` +
      (source ? `&source=${encodeURIComponent(source)}` : '')),
  search: (kw, limit = 30, source) =>
    fetchJSON(`/api/search?keyword=${encodeURIComponent(kw)}&limit=${limit}` +
      (source ? `&source=${encodeURIComponent(source)}` : '')),
  song: (id, source, name, singer, prefer, raw) =>
    fetchJSON(`/api/song?id=${encodeURIComponent(id)}&source=${encodeURIComponent(source || 'ny')}` +
      (name ? `&name=${encodeURIComponent(name)}` : '') + (singer ? `&singer=${encodeURIComponent(singer)}` : '') +
      (prefer && prefer !== 'auto' ? `&prefer=${encodeURIComponent(prefer)}` : '') +
      (raw && Object.keys(raw).length ? `&raw=${encodeURIComponent(JSON.stringify(raw))}` : '')),
  lyric: (id, source) => fetchJSON(`/api/lyric?id=${encodeURIComponent(id)}&source=${encodeURIComponent(source || 'ny')}`),
  playlists: (limit = 20, platform) =>
    fetchJSON(`/api/playlists?limit=${limit}` + (platform ? `&platform=${encodeURIComponent(platform)}` : '')),
  // 歌单歌曲详情：按歌单所属平台取歌（网易云可用，QQ/酷狗可能受限）
  playlist: (id, platform, limit = 100) =>
    fetchJSON(`/api/playlist?platform=${encodeURIComponent(platform || 'ny')}&id=${encodeURIComponent(id)}&limit=${limit}`),
  // 粘贴歌单/曲目：把解析出的 [{name, artist}] 交给后端逐首搜索匹配
  match: (items, source) =>
    fetch('/api/match', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items, source }) })
      .then((r) => r.json()),
  // 多平台歌单链接解析：返回 {ok, platform_name, playlist_title, count, songs:[{name,artist}], formatted}
  parsePlaylist: (url) =>
    fetchJSON(`/api/parse_playlist?url=${encodeURIComponent(url)}`, 25000),
  sources: () => fetchJSON('/api/sources'),
  importSource: (payload) =>
    fetch('/api/source/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
      .then((r) => r.json()),
  testSource: (id) =>
    fetch('/api/source/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) })
      .then((r) => r.json()),
  deleteSource: (scriptId) =>
    fetch('/api/source/' + encodeURIComponent(scriptId), { method: 'DELETE' }).then((r) => r.json()),
}
function fetchJSON(url, timeout = 15000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  return fetch(url, { cache: 'no-store', signal: ctrl.signal })
    .then((r) => {
      clearTimeout(timer)
      if (!r.ok) throw new Error('HTTP ' + r.status)
      return r.json()
    })
    .catch((e) => {
      clearTimeout(timer)
      if (e.name === 'AbortError') throw new Error('请求超时')
      throw e
    })
}
// 封面：优先用歌曲自带直链，否则用 id 走后端解析
const coverURL = (song) => {
  if (!song) return ''
  if (song.cover) return '/api/cover?u=' + encodeURIComponent(song.cover)
  if (song.id) return '/api/cover?id=' + encodeURIComponent(song.id)
  return ''
}
const audioURL = (u) => '/api/audio?u=' + encodeURIComponent(u)

// ---------- 状态 ----------
const state = {
  playlist: [],       // 当前播放列表 [{id,name,singer,cover,source}]
  index: -1,
  shuffle: true,
  listTitle: '热歌榜 · 精选',
  board: '3778678',   // 网易云热歌榜（默认）
  boardPlat: 'ny',    // 榜单所属平台（网易云/酷我），与播放音源相互独立，可下拉手动选择
  playlistPlat: 'ny', // 歌单所属平台（网易云/QQ/酷狗），与榜单平台相互独立
  listKind: 'board',  // 'board' | 'playlist'：当前列表是榜单还是歌单
  playlistId: null,   // 歌单模式下选中的歌单 id
  listName: '热歌榜', // 当前列表名称（用于音源切换后刷新时回填标题）
  searchList: null,
  listSource: 'ny',   // 当前列表数据实际来自哪个平台（后端返回）
  listNote: '',       // 后端给出的回退说明
}
const SOURCE_LABEL = { ny: '网易', kw: '酷我', kg: '酷狗', tx: 'QQ', wy: '网易', mg: '咪咕', qs: '汽水' }
const sourceLabel = (s) => SOURCE_LABEL[s] || s || ''
// 列表数据（搜索/榜单）只能由原生引擎提供：洛雪脚本只负责取址，
// 因此把用户选择的音源映射到对应引擎（与后端 LIST_NATIVE 保持一致）
const LIST_NATIVE = { ny: 'ny', wy: 'ny', kw: 'kw', kg: 'ny', tx: 'ny', mg: 'ny', qs: 'ny' }
const DEFAULT_BOARD = { ny: { id: '3778678', name: '热歌榜' }, kw: { id: '16', name: '热歌榜' } }
const sourcePlat = (key) => (String(key || '').includes(':') ? String(key).split(':')[1] : String(key || ''))
const nativeOf = (key) => (!key || key === 'auto' ? 'ny' : LIST_NATIVE[sourcePlat(key)] || 'ny')
// 播放时手动指定的音源（'auto' = 自动回退）
const PREFER_KEY = 'lxmw.prefer'
let preferSource = 'auto'
try { preferSource = localStorage.getItem(PREFER_KEY) || 'auto' } catch (_) {}
const sourceNameById = { auto: '自动' }

// ---------- DOM ----------
const $ = (id) => document.getElementById(id)
const audio = $('audio')
const els = {
  bg: $('bg'),
  boardChips: $('boardChips'),
  platSelect: $('boardPlatSelect'),
  playlistPlatSelect: $('playlistPlatSelect'),
  playlistPlatNote: $('playlistPlatNote'),
  pastePanel: $('pastePanel'),
  pasteOpenBtn: $('pasteOpenBtn'),
  pasteClose: $('pasteClose'),
  pasteArea: $('pasteArea'),
  pasteSource: $('pasteSource'),
  pasteGo: $('pasteGo'),
  pasteMsg: $('pasteMsg'),
  songList: $('songList'),
  listTitle: $('listTitle'),
  listMeta: $('listMeta'),
  listLoading: $('listLoading'),
  shuffleBtn: $('shuffleBtn'),
  playAllBtn: $('playAllBtn'),
  searchBtn: $('searchBtn'),
  searchPanel: $('searchPanel'),
  searchInput: $('searchInput'),
  searchClose: $('searchClose'),
  searchResults: $('searchResults'),
  searchEmpty: $('searchEmpty'),
  sourceBtn: $('sourceBtn'),
  sourcePanel: $('sourcePanel'),
  sourceClose: $('sourceClose'),
  sourceList: $('sourceList'),
  sourceUrl: $('sourceUrl'),
  sourceCode: $('sourceCode'),
  sourceImportUrl: $('sourceImportUrl'),
  sourceImportCode: $('sourceImportCode'),
  sourceTestAll: $('sourceTestAll'),
  sourcePick: $('sourcePick'),
  sourceChip: $('sourceChip'),
  sourceMsg: $('sourceMsg'),
  player: $('player'),
  playerClose: $('playerClose'),
  playerCover: $('playerCover'),
  playerTitle: $('playerTitle'),
  playerArtist: $('playerArtist'),
  playerSrc: $('playerSrc'),
  shuffleIcon: $('shuffleIcon'),
  disc: $('disc'),
  lyricScroll: $('lyricScroll'),
  curTime: $('curTime'),
  durTime: $('durTime'),
  progressBar: $('progressBar'),
  progressFill: $('progressFill'),
  playBtn: $('playBtn'),
  prevBtn: $('prevBtn'),
  nextBtn: $('nextBtn'),
  modeBtn: $('modeBtn'),
  mini: $('mini'),
  miniCover: $('miniCover'),
  miniTitle: $('miniTitle'),
  miniArtist: $('miniArtist'),
  miniPlay: $('miniPlay'),
  miniOpen: $('miniOpen'),
  miniPrev: $('miniPrev'),
  miniNext: $('miniNext'),
  playerQueueBtn: $('playerQueueBtn'),
  themeToggle: $('themeToggle'),
  themeToggleP: $('themeToggleP'),
  playerStage: $('playerStage'),
  stageDots: $('stageDots'),
  loMinus5: $('loMinus5'),
  loMinus1: $('loMinus1'),
  loVal: $('loVal'),
  loPlus1: $('loPlus1'),
  loPlus5: $('loPlus5'),
  loOpen: $('loOpen'),
  loClose: $('loClose'),
  lyricOffsetBar: $('lyricOffsetBar'),
  queuePanel: $('queuePanel'),
  queueList: $('queueList'),
  queueClose: $('queueClose'),
  queueCount: $('queueCount'),
  queueEmpty: $('queueEmpty'),
  tabBoard: $('tabBoard'),
  tabPlaylist: $('tabPlaylist'),
  boardSection: $('boardSection'),
  playlistSection: $('playlistSection'),
  playlistGrid: $('playlistGrid'),
  playlistLoading: $('playlistLoading'),
}

// ---------- 工具 ----------
function fmtTime(sec) {
  if (!sec || isNaN(sec)) return '0:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
// 播放量格式化：12345 -> 1.2万，123456789 -> 1.2亿
function formatPlayCount(n) {
  n = Number(n) || 0
  if (n >= 1e8) return (n / 1e8).toFixed(1).replace(/\.0$/, '') + '亿'
  if (n >= 1e4) return (n / 1e4).toFixed(1).replace(/\.0$/, '') + '万'
  return String(n)
}

// ---------- 图标 ----------
// 用内联 SVG 替代 emoji：emoji 在 Windows / iOS / Android 上字形差异很大，
// 暗色界面里彩色 emoji 会显得廉价且大小不一；SVG 继承 currentColor，配色统一。
const icon = (body, cls) =>
  `<svg class="i${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`
const ICONS = {
  play: icon('<path d="M8 5.2v13.6L19 12z"/>'),
  pause: icon('<path d="M9.5 5v14M14.5 5v14"/>'),
  prev: icon('<path d="M18.5 6v12L8.5 12z"/><path d="M5.5 6v12"/>'),
  next: icon('<path d="M5.5 6v12l10-6z"/><path d="M18.5 6v12"/>'),
  search: icon('<circle cx="11" cy="11" r="7"/><path d="M20.5 20.5L16.7 16.7"/>'),
  close: icon('<path d="M6 6l12 12M18 6L6 18"/>'),
  sliders: icon('<path d="M4 7h16M4 12h16M4 17h16"/><circle cx="9" cy="7" r="2.2"/><circle cx="15" cy="12" r="2.2"/><circle cx="8" cy="17" r="2.2"/>'),
  shuffle: icon('<path d="M17 3l4 4-4 4"/><path d="M21 7h-4"/><path d="M3 7h4.5c1.6 0 2.6.8 3.5 2.2l3 5.6c.9 1.4 1.9 2.2 3.5 2.2H21"/><path d="M17 13l4 4-4 4"/><path d="M17 17h-2.5c-1.6 0-2.6-.8-3.5-2.2"/><path d="M3 17h4.5"/><path d="M14.5 7H21"/>'),
  seq: icon('<path d="M17 2l4 4-4 4"/><path d="M21 6H8a4 4 0 00-4 4v1"/><path d="M7 22l-4-4 4-4"/><path d="M3 18h13a4 4 0 004 4v-1"/>'),
  note: icon('<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>'),
  chevronDown: icon('<path d="M6 9l6 6 6-6"/>'),
  chevronUp: icon('<path d="M18 15l-6-6-6 6"/>'),
  list: icon('<path d="M8 6h12M8 12h12M8 18h12"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>'),
  sun: icon('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/>'),
  moon: icon('<path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.5 6.5 0 0 0 9.8 9.8z"/>'),
}
const setIcon = (el, key) => { if (el && ICONS[key]) el.innerHTML = ICONS[key] }
// 图标 + 文案（文案统一转义，脚本名属于外部输入）
const setIconText = (el, key, text) => { if (el) el.innerHTML = (ICONS[key] || '') + '<span>' + escapeHtml(text) + '</span>' }

// ---------- 深浅色模式 ----------
const THEME_KEY = 'lx_theme'
const themeMeta = document.querySelector('meta[name="theme-color"]')
function applyTheme(mode) {
  const root = document.documentElement
  const isLight = mode === 'light'
  root.classList.toggle('theme-light', isLight)
  setIcon(els.themeToggle, isLight ? 'moon' : 'sun')
  setIcon(els.themeToggleP, isLight ? 'moon' : 'sun')
  if (themeMeta) themeMeta.setAttribute('content', isLight ? '#eef0f6' : '#0b0b12')
}
function toggleTheme() {
  const isLight = document.documentElement.classList.contains('theme-light')
  const next = isLight ? 'dark' : 'light'
  try { localStorage.setItem(THEME_KEY, next) } catch (e) {}
  applyTheme(next)
}
function initTheme() {
  let saved = 'dark'
  try { saved = localStorage.getItem(THEME_KEY) || 'dark' } catch (e) {}
  applyTheme(saved === 'light' ? 'light' : 'dark')
}

// ---------- 渲染：榜单 chips（榜单平台可下拉手动选择，与播放音源相互独立）----------
async function renderBoards() {
  const data = await API.boards(state.boardPlat)
  const boards = data.boards || []
  els.boardChips.innerHTML = ''
  boards.forEach((b) => {
    const btn = document.createElement('button')
    btn.className = 'chip' + (String(b.id) === String(state.board) ? ' active' : '')
    btn.textContent = b.name
    btn.onclick = () => selectBoard(b)
    els.boardChips.appendChild(btn)
  })
}

async function selectBoard(b) {
  state.listKind = 'board'
  state.board = b.id
  state.listName = b.name
  state.searchList = null
  ;[...els.boardChips.children].forEach((c) => c.classList.toggle('active', c.textContent === b.name))
  await loadList(b.id, b.name)
}

// 列表来源提示：明确告诉用户「列表数据来自谁、播放用谁」
function renderListMeta(data) {
  const note = (data && data.note) || state.listNote || ''
  const plat = (data && data.source) || state.listSource || 'ny'
  const via = (data && data.via) || ''
  const playName = preferSource === 'auto' ? '自动回退' : (sourceNameById[preferSource] || preferSource)
  // via='lx:脚本id' 表示列表由脚本自身搜索返回，否则是原生引擎（网易云/酷我）提供的
  const listName = via.indexOf('lx:') === 0 ? playName : (sourceLabel(plat) || plat)
  els.listMeta.innerHTML =
    `<span class="lm-tag">列表：${escapeHtml(listName)}</span>` +
    `<span class="lm-tag">播放：${escapeHtml(playName)}</span>` +
    (note ? `<span class="lm-fallback">${escapeHtml(note)}</span>` : '')
}

// 通用列表加载：榜单走 /api/hot（按榜单平台），歌单走 /api/playlist（按歌单平台，
// 网易云可用，QQ/酷狗歌曲接口受限时后端会返回 note 提示无法播放）。
async function loadList(id, name) {
  state.listName = name
  els.listTitle.textContent = name + ' · 精选'
  els.listLoading.classList.remove('hidden')
  els.songList.innerHTML = ''
  try {
    const data = state.listKind === 'playlist'
      ? await API.playlist(id, state.playlistPlat, 100)
      : await API.hot(id, 100, state.boardPlat)
    const list = data.list || []
    state.playlist = list
    state.listTitle = name
    state.listSource = data.source || state.playlistPlat
    state.listNote = data.note || ''
    renderSongList(list, els.songList, { queue: true })
    renderListMeta(data)
  } catch (e) {
    els.songList.innerHTML = `<div class="empty">加载失败：${escapeHtml(e.message)} <button id="retryList" class="retry-btn">重试</button></div>`
    const rb = document.getElementById('retryList')
    if (rb) rb.onclick = () => loadList(id, name)
  } finally {
    els.listLoading.classList.add('hidden')
  }
}

// 当前用于随机播放 / 音源切换刷新的列表 id（优先用歌单，否则用榜单）
function currentListId() {
  if (state.listKind === 'playlist' && state.playlistId) return state.playlistId
  return state.board
}

// ---------- 渲染：热门歌单 ----------
async function renderPlaylists() {
  els.playlistLoading.classList.remove('hidden')
  els.playlistGrid.innerHTML = ''
  // QQ/酷狗歌单可浏览，但歌曲详情接口受平台签名/风控限制，点击后可能无法播放，先提示用户
  const plat = state.playlistPlat
  if (plat === 'tx' || plat === 'kg') {
    els.playlistPlatNote.classList.remove('hidden')
    els.playlistPlatNote.textContent = (plat === 'tx' ? 'QQ音乐' : '酷狗') + '歌单可浏览，但歌曲播放接口受平台限制，点击后若无法播放属正常现象（已回退网易云的会标“已回退”）'
  } else {
    els.playlistPlatNote.classList.add('hidden')
  }
  try {
    const data = await API.playlists(20, plat)
    const list = data.playlists || []
    // 后端若因接口受限回退到网易云，把说明一并展示
    if (data.note && els.playlistPlatNote.classList.contains('hidden')) {
      els.playlistPlatNote.classList.remove('hidden')
      els.playlistPlatNote.textContent = data.note
    } else if (data.note) {
      els.playlistPlatNote.textContent = data.note
    }
    if (!list.length) {
      els.playlistGrid.innerHTML = '<div class="empty">暂无可用的热门歌单</div>'
      return
    }
    list.forEach((p) => {
      const card = document.createElement('button')
      card.className = 'playlist-card'
      card.dataset.id = String(p.id)
      card.dataset.plat = plat
      card.innerHTML =
        `<img class="playlist-cover" src="${p.cover ? '/api/cover?u=' + encodeURIComponent(p.cover) : ''}" alt="" loading="lazy" />` +
        `<div class="playlist-name">${escapeHtml(p.name)}</div>` +
        `<div class="playlist-meta">${p.playCount ? '▶ ' + formatPlayCount(p.playCount) : ''}${p.creator ? ' · ' + escapeHtml(p.creator) : ''}</div>`
      card.onclick = () => selectPlaylist(p)
      els.playlistGrid.appendChild(card)
    })
  } catch (e) {
    els.playlistGrid.innerHTML = `<div class="empty">歌单加载失败：${escapeHtml(e.message)}</div>`
  } finally {
    els.playlistLoading.classList.add('hidden')
  }
}

// 把歌曲列表区块滚入视野，避免歌单网格较高时「已加载却看不见」的错觉
function scrollToSongList() {
  const sec = els.songList.closest('.list-section')
  if (sec && sec.scrollIntoView) {
    try { sec.scrollIntoView({ behavior: 'smooth', block: 'start' }) } catch (_) { sec.scrollIntoView() }
  } else if (els.songList.scrollIntoView) {
    try { els.songList.scrollIntoView({ behavior: 'smooth', block: 'start' }) } catch (_) {}
  }
}

async function selectPlaylist(p) {
  state.listKind = 'playlist'
  state.playlistId = p.id
  state.listName = p.name
  state.searchList = null
  ;[...els.playlistGrid.children].forEach((c) => c.classList.toggle('active', c.dataset.id === String(p.id)))
  await loadList(p.id, p.name)
  // 歌单网格较高，选完后把歌曲列表滚入视野，明确反馈「已加载对应歌曲」
  scrollToSongList()
}

// 榜单 / 歌单 tab 切换
function selectTab(tab) {
  const toBoard = tab === 'board'
  els.tabBoard.classList.toggle('active', toBoard)
  els.tabPlaylist.classList.toggle('active', !toBoard)
  els.boardSection.classList.toggle('hidden', !toBoard)
  els.playlistSection.classList.toggle('hidden', toBoard)
  state.listKind = toBoard ? 'board' : (state.playlistId ? 'playlist' : 'board')
  if (toBoard) {
    // 回到榜单：刷新当前榜单列表
    loadList(state.board, state.listName || '热歌榜')
  } else {
    if (!els.playlistGrid.children.length) renderPlaylists()
    if (state.playlistId) loadList(state.playlistId, state.listName || '')
    else {
      els.songList.innerHTML = '<div class="empty">选择上方歌单，查看其中的歌曲</div>'
      els.listMeta.innerHTML = ''
    }
  }
}

// ---------- 渲染：歌曲列表 ----------
// opts.queue = true 时显示上移/下移/移除控件，并高亮当前播放的那首
function renderSongList(list, container, opts = {}) {
  const isQueue = !!opts.queue
  container.innerHTML = ''
  list.forEach((song, i) => {
    const li = document.createElement('li')
    li.className = 'song-item' + (i === state.index ? ' playing' : '')
    li.innerHTML = `
      <div class="song-idx">${i + 1}</div>
      <img class="song-cover" src="${coverURL(song)}" alt="" loading="lazy" />
      <div class="song-info">
        <div class="song-name">${escapeHtml(song.name)}<span class="badge">${escapeHtml(sourceLabel(song.source))}</span></div>
        <div class="song-artist">${escapeHtml(song.singer)}</div>
      </div>
      <div class="song-dur">${song.duration || ''}</div>` +
      (isQueue ? `<div class="song-actions">
        <button class="qbtn" data-act="up" title="上移">↑</button>
        <button class="qbtn" data-act="down" title="下移">↓</button>
        <button class="qbtn qbtn-del" data-act="del" title="移出队列">✕</button>
      </div>` : '')
    li.onclick = () => playFromList(list, i)
    if (isQueue) {
      li.querySelectorAll('.qbtn').forEach((btn) => {
        btn.onclick = (e) => {
          e.stopPropagation() // 不触发整行的播放
          const act = btn.getAttribute('data-act')
          if (act === 'up') moveSong(i, -1)
          else if (act === 'down') moveSong(i, 1)
          else if (act === 'del') removeSong(i)
        }
      })
    }
    container.appendChild(li)
  })
}

// 同时刷新「首页主列表」与（若打开）「播放列表面板」，保持两处队列一致
function refreshLists() {
  renderSongList(state.playlist, els.songList, { queue: true })
  if (!els.queuePanel.classList.contains('hidden')) renderQueue()
}

// ---------- 播放队列管理：调整顺序 / 移除 ----------
function moveSong(i, dir) {
  const arr = state.playlist
  const j = i + dir
  if (j < 0 || j >= arr.length) return
  const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp
  // 当前播放的那首跟着换位置，音频不中断
  if (state.index === i) state.index = j
  else if (state.index === j) state.index = i
  refreshLists()
}
function removeSong(i) {
  const arr = state.playlist
  if (i < 0 || i >= arr.length) return
  const wasCurrent = state.index === i
  arr.splice(i, 1)
  if (state.index > i) state.index--
  if (state.index >= arr.length) state.index = arr.length - 1
  refreshLists()
  if (wasCurrent) {
    if (arr.length) playCurrent() // 删的是当前这首 → 自动播下一首
    else {
      audio.pause(); audio.removeAttribute('src')
      els.playerTitle.textContent = ''; els.playerArtist.textContent = ''
      els.playerCover.removeAttribute('src')
    }
  }
}

// 播放列表面板：把当前队列渲染出来，可在播放器内直接管理顺序
function renderQueue() {
  const list = state.playlist
  els.queueCount.textContent = list.length ? list.length + ' 首' : ''
  if (!list.length) {
    els.queueList.innerHTML = ''
    els.queueEmpty.classList.remove('hidden')
    return
  }
  els.queueEmpty.classList.add('hidden')
  renderSongList(list, els.queueList, { queue: true })
  // 点击某行：从队列中切到这一首并同步高亮
  ;[...els.queueList.children].forEach((li, i) => {
    li.onclick = () => {
      state.index = i
      playCurrent()
      if (!els.queuePanel.classList.contains('hidden')) renderQueue()
    }
  })
}
function openQueue() { renderQueue(); els.queuePanel.classList.remove('hidden') }
function closeQueue() { els.queuePanel.classList.add('hidden') }

// ---------- 播放控制 ----------
function playFromList(list, i) {
  state.playlist = list
  state.index = i
  playCurrent()
  if (state.searchList) { /* 搜索结果在独立面板，列表高亮不强制 */ }
  // 高亮主列表
  [...els.songList.children].forEach((c, idx) => c.classList.toggle('playing', idx === i && state.searchList === null))
}

async function playCurrent() {
  const song = state.playlist[state.index]
  if (!song) return
  // 迷你播放器 / 播放器 元信息
  els.playerTitle.textContent = song.name
  els.playerArtist.textContent = song.singer
  // 先按歌曲自身平台显示，取到地址后再更新为实际出地址的音源
  els.playerSrc.textContent = (sourceLabel(song.source) || '音乐') + '音乐'
  els.miniTitle.textContent = song.name
  els.miniArtist.textContent = song.singer
  els.playerCover.src = coverURL(song)
  els.miniCover.src = coverURL(song)
  els.bg.style.backgroundImage = `url("${coverURL(song)}")`
  els.lyricScroll.innerHTML = '<p class="lyric-line empty">歌词加载中…</p>'
  lyricLines = []
  currentLyricIdx = -1
  userScrolling = false

  try {
    const data = await API.song(song.id, song.source, song.name, song.singer, preferSource, song.raw)
    if (!data || !data.url) throw new Error('未获取到播放地址')
    // 显示真实音源（可能是手动指定的源，或跨源匹配后的源）
    els.playerSrc.textContent = data.sourceName || data.via || ((sourceLabel(song.source) || '音乐') + '音乐')
    audio.src = audioURL(data.url)
    audio.load()
    // 移动端/未交互时浏览器会拦截自动播放：吞掉异常，并按真实播放状态更新按钮
    try { await audio.play() } catch (_) { /* 被拦截，等用户点播放键 */ }
    setPlaying(!audio.paused)
    loadLyric(song.id, song.source)
  } catch (e) {
    els.lyricScroll.innerHTML = '<p class="lyric-line empty">播放地址获取失败</p>'
    setPlaying(false)
  }
  // 播放列表面板打开时，同步高亮当前播放的那首
  if (!els.queuePanel.classList.contains('hidden')) renderQueue()
  showMini()
}

function nextTrack() {
  if (!state.playlist.length) return
  if (state.shuffle) {
    let n
    do { n = Math.floor(Math.random() * state.playlist.length) } while (state.playlist.length > 1 && n === state.index)
    state.index = n
  } else {
    state.index = (state.index + 1) % state.playlist.length
  }
  playCurrent()
}
function prevTrack() {
  if (!state.playlist.length) return
  if (state.shuffle) {
    let n
    do { n = Math.floor(Math.random() * state.playlist.length) } while (state.playlist.length > 1 && n === state.index)
    state.index = n
  } else {
    state.index = (state.index - 1 + state.playlist.length) % state.playlist.length
  }
  playCurrent()
}
function setPlaying(p) {
  setIcon(els.playBtn, p ? 'pause' : 'play')
  setIcon(els.miniPlay, p ? 'pause' : 'play')
  els.disc.classList.toggle('spinning', p)
}
function togglePlay() {
  if (!audio.src) { if (state.index >= 0) playCurrent(); return }
  if (audio.paused) audio.play().catch(() => {}); else audio.pause()
}

// ---------- 歌词 ----------
let lyricLines = []      // [{t, text, el}]
let currentLyricIdx = -1
let userScrolling = false          // 用户正在手动滚动歌词，暂停自动居中
let scrollResumeTimer = null
// 歌词时间偏移（秒）：修正跨版本（网易云歌词 / 酷我音频）的整段时差，用户校准后本地保存
// 默认 +45（歌词时间轴比音频快 45s），仅在本地尚未校准过时生效；之后可用底部校准条随时微调
let lyricOffset = 45
try {
  const _v = localStorage.getItem('lx_lyric_offset')
  if (_v === null) lyricOffset = 45
  else lyricOffset = Math.round(Number(_v) * 10) / 10 || 0
} catch (_) { lyricOffset = 45 }
function parseLRC(text) {
  const lines = []
  text.split('\n').forEach((line) => {
    const m = line.match(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g)
    if (!m) return
    const content = line.replace(/\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/g, '').trim()
    if (!content) return
    m.forEach((tag) => {
      const p = tag.match(/(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?/)
      const t = (+p[1]) * 60 + (+p[2]) + (p[3] ? +('0.' + p[3]) : 0)
      lines.push({ t, text: content })
    })
  })
  return lines.sort((a, b) => a.t - b.t)
}
// 用户手动滚动歌词时暂停自动居中，空闲 4 秒后恢复
function markUserScroll() {
  userScrolling = true
  clearTimeout(scrollResumeTimer)
  scrollResumeTimer = setTimeout(() => { userScrolling = false }, 4000)
}
async function loadLyric(id, source) {
  try {
    const { lyric } = await API.lyric(id, source)
    const lines = lyric ? parseLRC(lyric) : []
    lyricLines = lines
    currentLyricIdx = -1
    userScrolling = false
    els.lyricScroll.innerHTML = ''
    if (!lines.length) {
      const p = document.createElement('p')
      p.className = 'lyric-line empty'
      p.textContent = '暂无歌词'
      els.lyricScroll.appendChild(p)
      return
    }
    // 一次性渲染全部歌词行，行内点击可跳转到对应时间
    lines.forEach((ln) => {
      const p = document.createElement('p')
      p.className = 'lyric-line'
      p.textContent = ln.text
      p.addEventListener('click', () => {
        if (typeof ln.t === 'number' && audio.duration) audio.currentTime = ln.t
      })
      ln.el = p
      els.lyricScroll.appendChild(p)
    })
    els.lyricScroll.scrollTop = 0
  } catch (_) {
    lyricLines = []
    els.lyricScroll.innerHTML = '<p class="lyric-line empty">暂无歌词</p>'
  }
}
// 自写短动画居中当前行：比浏览器默认 smooth 更快更跟手，避免「居中行」慢半拍造成不同步的观感
let lyricScrollRAF = null
let lyricScrollStart = 0
let lyricScrollFrom = 0
let lyricScrollTo = 0
let lyricScrollT0 = 0
const LYRIC_SCROLL_DUR = 220
function animateLyricScroll(top) {
  const el = els.lyricScroll
  if (lyricScrollRAF) cancelAnimationFrame(lyricScrollRAF)
  lyricScrollFrom = el.scrollTop
  lyricScrollTo = top
  if (Math.abs(lyricScrollTo - lyricScrollFrom) < 1) { el.scrollTop = top; return }
  lyricScrollStart = performance.now()
  const step = (now) => {
    const p = Math.min(1, (now - lyricScrollStart) / LYRIC_SCROLL_DUR)
    const e = 1 - Math.pow(1 - p, 3) // easeOutCubic
    el.scrollTop = lyricScrollFrom + (lyricScrollTo - lyricScrollFrom) * e
    if (p < 1) lyricScrollRAF = requestAnimationFrame(step)
    else lyricScrollRAF = null
  }
  lyricScrollRAF = requestAnimationFrame(step)
}

// 播放期间用 rAF 节拍驱动歌词高亮，把行切换延迟从 timeupdate 的 ~250ms 降到每帧，更贴合演唱
let lyricTickRAF = null
function lyricTick() {
  updateLyric(audio.currentTime)
  if (!audio.paused) lyricTickRAF = requestAnimationFrame(lyricTick)
  else lyricTickRAF = null
}
function startLyricTick() { if (!lyricTickRAF && !audio.paused) lyricTickRAF = requestAnimationFrame(lyricTick) }
function stopLyricTick() { if (lyricTickRAF) { cancelAnimationFrame(lyricTickRAF); lyricTickRAF = null } }

// 歌词校准：±秒调整并即时重新对齐，结果存入 localStorage（跨版本整段时差一次校准长期生效）
function applyLyricOffset(delta) {
  lyricOffset = Math.round((lyricOffset + delta) * 10) / 10
  lyricOffset = Math.max(-180, Math.min(180, lyricOffset))
  try { localStorage.setItem('lx_lyric_offset', String(lyricOffset)) } catch (_) {}
  els.loVal.textContent = (lyricOffset > 0 ? '+' : '') + lyricOffset.toFixed(1) + 's'
  if (lyricLines.length) {
    currentLyricIdx = -1   // 强制重新判定当前行
    updateLyric(audio.currentTime)
  }
}

function updateLyric(cur) {
  if (!lyricLines.length) return
  const ref = cur + lyricOffset   // 套用用户校准的偏移量
  let idx = -1
  for (let i = 0; i < lyricLines.length; i++) {
    if (ref >= lyricLines[i].t) idx = i; else break
  }
  if (idx !== currentLyricIdx) {
    if (currentLyricIdx >= 0 && lyricLines[currentLyricIdx] && lyricLines[currentLyricIdx].el) {
      const pe = lyricLines[currentLyricIdx].el
      pe.classList.remove('active')
      clearLyricFill(pe)
    }
    currentLyricIdx = idx
    const el = idx >= 0 ? lyricLines[idx].el : null
    if (el) el.classList.add('active')
    // 自动滚动让当前行居中（用户手动滚动时暂停，避免抢手势）
    if (el && !userScrolling && els.lyricScroll.scrollHeight) {
      // 用 rect 计算行在滚动内容中的绝对位置，避免 offsetParent 嵌套导致的坐标错位
      const cr = els.lyricScroll.getBoundingClientRect()
      const lr = el.getBoundingClientRect()
      const innerPos = lr.top - cr.top + els.lyricScroll.scrollTop
      const target = innerPos - els.lyricScroll.clientHeight / 2 + el.clientHeight / 2
      animateLyricScroll(Math.max(0, target))
    }
  }
  // 当前句 KTV 渐变填充：随演唱进度从左往右上色（每帧刷新）
  updateLyricFill(ref)
}

// KTV 逐字上色：已唱部分为亮色，未唱部分为暗色，按当前句进度 p(0~1) 左→右推进
const LYRIC_FILL_COLOR = '#ff4d6d'                 // 已唱：主题红
const LYRIC_FILL_DIM = 'rgba(244,244,248,0.5)'    // 未唱：浅灰
function setLyricFill(el, p) {
  const pct = (p * 100).toFixed(2)
  el.style.backgroundImage =
    `linear-gradient(90deg, ${LYRIC_FILL_COLOR} 0%, ${LYRIC_FILL_COLOR} ${pct}%, ${LYRIC_FILL_DIM} ${pct}%, ${LYRIC_FILL_DIM} 100%)`
  el.style.webkitBackgroundClip = 'text'
  el.style.backgroundClip = 'text'
  el.style.color = 'transparent'
  el.style.webkitTextFillColor = 'transparent'
}
function clearLyricFill(el) {
  el.style.backgroundImage = ''
  el.style.webkitBackgroundClip = ''
  el.style.backgroundClip = ''
  el.style.color = ''
  el.style.webkitTextFillColor = ''
}
function updateLyricFill(ref) {
  if (currentLyricIdx < 0) return
  const ln = lyricLines[currentLyricIdx]
  if (!ln || !ln.el) return
  const next = lyricLines[currentLyricIdx + 1]
  const start = ln.t
  const end = next ? next.t : (audio.duration || start + 4)
  const span = Math.max(0.5, end - start)
  let p = (ref - start) / span
  p = Math.max(0, Math.min(1, p))
  setLyricFill(ln.el, p)
}

// ---------- 音频事件 ----------
audio.addEventListener('timeupdate', () => {
  const cur = audio.currentTime
  const dur = audio.duration || 0
  els.curTime.textContent = fmtTime(cur)
  els.durTime.textContent = fmtTime(dur)
  els.progressFill.style.width = dur ? (cur / dur) * 100 + '%' : '0%'
})
audio.addEventListener('play', () => { setPlaying(true); startLyricTick() })
audio.addEventListener('pause', () => { setPlaying(false); stopLyricTick() })
audio.addEventListener('ended', () => { stopLyricTick(); nextTrack() })

// 进度条：支持点击与拖动 seek（Pointer Events 同时覆盖鼠标与触摸）
let seeking = false
function seekRatioFromEvent(e) {
  const rect = els.progressBar.getBoundingClientRect()
  const x = ((e.clientX != null ? e.clientX : (e.touches && e.touches[0] && e.touches[0].clientX)) || 0) - rect.left
  return Math.min(1, Math.max(0, x / rect.width))
}
function applySeek(e) {
  const ratio = seekRatioFromEvent(e)
  if (audio.duration) audio.currentTime = ratio * audio.duration
}
els.progressBar.addEventListener('pointerdown', (e) => {
  seeking = true
  try { els.progressBar.setPointerCapture(e.pointerId) } catch (_) {}
  applySeek(e)
})
els.progressBar.addEventListener('pointermove', (e) => {
  if (seeking) applySeek(e)
})
function endSeek(e) {
  if (!seeking) return
  seeking = false
  try { els.progressBar.releasePointerCapture(e.pointerId) } catch (_) {}
}
els.progressBar.addEventListener('pointerup', endSeek)
els.progressBar.addEventListener('pointercancel', endSeek)

// ---------- UI 显隐 ----------
function showMini() { els.mini.classList.remove('hidden') }
function openPlayer() { els.player.classList.remove('hidden') }
function closePlayer() { els.player.classList.add('hidden') }

// 播放器双屏：左滑/右滑在「唱片」与「歌词」之间切换；圆点可点击切换
function switchPlayerScreen(i) {
  const w = els.playerStage.clientWidth || 1
  els.playerStage.scrollTo({ left: i * w, behavior: 'smooth' })
}
function initPlayerStage() {
  const dots = [...els.stageDots.querySelectorAll('.dot')]
  dots.forEach((d) => {
    d.onclick = () => switchPlayerScreen(Number(d.getAttribute('data-i')))
  })
  els.playerStage.addEventListener('scroll', () => {
    const w = els.playerStage.clientWidth || 1
    const i = Math.round(els.playerStage.scrollLeft / w)
    dots.forEach((d, k) => d.classList.toggle('active', k === i))
  }, { passive: true })
}

// ---------- 事件绑定 ----------
els.shuffleBtn.onclick = async () => {
  els.listLoading.classList.remove('hidden')
  try {
    // 随机播放从「当前选中的列表」（歌单优先，否则榜单）里取一首；
    // 歌单按歌单平台、榜单按榜单平台，两者相互独立
    const isPlaylist = state.listKind === 'playlist'
    const plat = isPlaylist ? state.playlistPlat : state.boardPlat
    const id = currentListId()
    let data = isPlaylist
      ? await API.playlist(id, plat, 100)
      : await API.hot(id, 100, plat)
    if (!isPlaylist && (!data.list || !data.list.length)) {
      // 兜底：当前榜单拿不到歌时切回该平台的默认榜再试一次
      const def = DEFAULT_BOARD[plat] || DEFAULT_BOARD.ny
      state.board = def.id
      data = await API.hot(def.id, 100, plat)
    }
    const list = data.list || []
    state.playlist = list
    state.listTitle = '随机播放'
    state.listSource = data.source || nativeOf(preferSource)
    state.listNote = data.note || ''
    renderListMeta(data)
    if (list.length) {
      state.index = Math.floor(Math.random() * list.length)
      playCurrent()
      openPlayer()
    } else {
      alert('随机播放失败：榜单暂无歌曲，请换一个榜单或音源试试')
    }
  } catch (e) {
    alert('随机播放失败：' + e.message)
  } finally {
    els.listLoading.classList.add('hidden')
  }
}
els.playAllBtn.onclick = () => {
  if (state.playlist.length) {
    state.index = 0
    playCurrent()
    openPlayer()
  }
}
els.prevBtn.onclick = prevTrack
els.nextBtn.onclick = nextTrack
els.playBtn.onclick = togglePlay
// 迷你播放器：点击 dock 栏空余处或向上箭头均可展开；按钮各自 stopPropagation 避免误触发
els.mini.onclick = openPlayer
els.miniPrev.onclick = (e) => { e.stopPropagation(); prevTrack() }
els.miniNext.onclick = (e) => { e.stopPropagation(); nextTrack() }
els.miniPlay.onclick = (e) => { e.stopPropagation(); togglePlay() }
els.miniOpen.onclick = (e) => { e.stopPropagation(); openPlayer() }
els.playerClose.onclick = closePlayer
els.playerQueueBtn.onclick = openQueue
els.queueClose.onclick = closeQueue
// 深浅色切换
els.themeToggle.onclick = toggleTheme
els.themeToggleP.onclick = toggleTheme
// 播放器双屏：左右滑动切换「唱片 / 歌词」，圆点也可点
initPlayerStage()
// 歌词校准按钮
els.loVal.textContent = (lyricOffset > 0 ? '+' : '') + lyricOffset.toFixed(1) + 's'
els.loOpen.onclick = () => els.lyricOffsetBar.classList.remove('hidden')
els.loClose.onclick = () => els.lyricOffsetBar.classList.add('hidden')
els.loMinus5.onclick = () => applyLyricOffset(-5)
els.loMinus1.onclick = () => applyLyricOffset(-1)
els.loPlus1.onclick = () => applyLyricOffset(1)
els.loPlus5.onclick = () => applyLyricOffset(5)
// 榜单 / 歌单 tab
els.tabBoard.onclick = () => selectTab('board')
els.tabPlaylist.onclick = () => selectTab('playlist')
// 榜单平台下拉：手动选择网易云 / 酷我，切换后重新拉取对应平台的榜单并载入默认榜
els.platSelect.onchange = () => {
  const plat = els.platSelect.value
  if (plat === state.boardPlat) return
  state.boardPlat = plat
  const def = DEFAULT_BOARD[plat] || DEFAULT_BOARD.ny
  state.board = def.id
  state.listName = def.name
  els.listLoading.classList.remove('hidden')
  renderBoards()
    .then(() => loadList(state.board, state.listName))
    .catch(() => {})
    .finally(() => els.listLoading.classList.add('hidden'))
}
// 歌单平台下拉：网易云(可播放) / QQ / 酷狗(可浏览，播放可能受限)。切换后重拉该平台的歌单，
// 并清空已选歌单（不同平台的歌单 id 不互通，旧的歌单歌曲列表已失效）
els.playlistPlatSelect.onchange = () => {
  const plat = els.playlistPlatSelect.value
  if (plat === state.playlistPlat) return
  state.playlistPlat = plat
  state.playlistId = null
  state.listKind = 'board' // 平台切换后旧歌单失效，回到待选状态（不立即加载某张歌单）
  els.songList.innerHTML = '<div class="empty">选择上方歌单，查看其中的歌曲</div>'
  els.listTitle.textContent = '热门歌单 · 精选'
  renderPlaylists()
}

// ---------- 粘贴歌单 / 曲目 ----------
// QQ/酷狗等平台歌单曲目接口被平台封死，改为：用户贴曲目文本 → 后端逐首搜索匹配 → 匹配到的直接播放
function openPaste() { els.pastePanel.classList.remove('hidden') }
function closePaste() { els.pastePanel.classList.add('hidden') }
els.pasteOpenBtn.onclick = openPaste
els.pasteClose.onclick = closePaste

// 解析粘贴内容：网易云歌单链接 → {url:{plat:'ny',id}}；其它平台歌单链接 → {url:{plat:'multi',raw}}；
// 纯曲目文本 → {items:[{name, artist}]}（每行一首，支持「歌名 - 歌手」「歌手 - 歌名」「只有歌名」，
// 自动剥掉行首序号「01. / 1、」等；歌名/歌手顺序不影响匹配，搜索时两段拼接）
function parsePasteInput(text) {
  const t = String(text || '').trim()
  if (!t) return { url: null, items: [] }
  const nyLink = t.match(/music\.163\.com\/(?:#\/)?playlist\?id=(\d+)/) || t.match(/music\.163\.com\/(?:#\/)?playlist\/(\d+)/)
  if (nyLink) return { url: { plat: 'ny', id: nyLink[1] }, items: [] }
  // 其它平台歌单链接：交给后端 /api/parse_playlist 多平台解析
  const anyUrl = t.match(/https?:\/\/[^\s]+/i)
  const platRe = /y\.qq\.com|kugou\.com|kuwo\.cn|music\.91q\.com|kma\.kkbox\.com|music\.apple\.com|open\.spotify\.com|music\.migu\.cn/i
  const isPlatUrl = anyUrl && platRe.test(anyUrl[0])
  const items = []
  t.split(/\r?\n/).forEach((line) => {
    let s = line.trim()
    if (!s || /^https?:\/\//i.test(s)) return
    s = s.replace(/^\s*\d+\s*[.、)．:：]\s*/, '') // 剥行首序号「01. / 2、 / 3：」
    let name = s, artist = ''
    const parts = s.split(/\s*[-–—|]\s*/)
    if (parts.length >= 2) { name = parts[0].trim(); artist = parts.slice(1).join(' ').trim() }
    if (name) items.push({ name, artist })
  })
  return { url: isPlatUrl ? { plat: 'multi', raw: anyUrl[0] } : null, items }
}

// 把一组已解析好的歌曲直接作为当前播放列表（不归属榜单/歌单，不受平台切换联动影响）
function applyExternalPlaylist(list, title, note) {
  state.playlist = list
  state.listKind = 'board'
  state.playlistId = null
  state.searchList = null
  state.listTitle = title
  state.listSource = (list[0] && list[0].source) || 'ny'
  state.listNote = note || ''
  els.listTitle.textContent = title
  renderSongList(list, els.songList, { queue: true })
  renderListMeta({ source: state.listSource, note: note || '' })
  scrollToSongList()
  if (list.length) { state.index = 0; playCurrent(); openPlayer() }
}

els.pasteGo.onclick = async () => {
  const parsed = parsePasteInput(els.pasteArea.value)
  els.pasteMsg.textContent = ''
  // ① 网易云歌单链接：直接读取曲目并播放
  if (parsed.url && parsed.url.plat === 'ny') {
    els.pasteMsg.textContent = '正在读取网易云歌单…'
    try {
      const data = await API.playlist(parsed.url.id, 'ny', 100)
      const list = data.list || []
      if (!list.length) throw new Error(data.note || '未读取到曲目')
      closePaste()
      applyExternalPlaylist(list, '网易云歌单', data.note || '')
      return
    } catch (e) {
      els.pasteMsg.textContent = '读取失败：' + e.message + '。可改为在 App 里复制曲目列表后粘贴'
      return
    }
  }
  let items = parsed.items || []
  let matchLabel = '粘贴歌单'
  let matchNote = ''
  // ② 其它平台歌单链接（且无文本曲目）：后端多平台解析出 [{name,artist}]，
  //    把「曲名 - 歌手」列表回填到输入框展示出来（这是核心交付：让用户看到解析结果），
  //    用户确认后再点「解析并播放」走逐首匹配。
  //    混合输入（既有文本行又有链接）时优先按文本曲目匹配（链接行已被跳过），与原行为一致
  if (parsed.url && parsed.url.plat === 'multi' && !parsed.items.length) {
    els.pasteMsg.textContent = '正在解析歌单链接…'
    try {
      const data = await API.parsePlaylist(parsed.url.raw)
      if (!data.ok) throw new Error(data.error || '解析失败')
      const songs = data.songs || []
      if (!songs.length) throw new Error('未解析到曲目')
      // 回填「曲名 - 歌手」列表，让用户看到完整解析结果
      els.pasteArea.value = songs.map((s) => (s.artist ? `${s.name} - ${s.artist}` : s.name)).join('\n')
      const title = (data.platform_name || '歌单') + (data.playlist_title ? '「' + data.playlist_title + '」' : '')
      const warn = data.warning ? '（' + data.warning + '）' : ''
      els.pasteMsg.textContent = `已解析 ${title} 共 ${songs.length} 首（曲名 - 歌手），列表已填入上方，可编辑后点「解析并播放」${warn}`
      return
    } catch (e) {
      els.pasteMsg.textContent = '解析失败：' + e.message
      return
    }
  }
  // ③ 曲目文本 / 解析结果：批量搜索匹配
  if (!items.length) {
    els.pasteMsg.textContent = '没有可解析的曲目：每行一首，如「晴天 - 周杰伦」，或粘贴歌单链接'
    return
  }
  els.pasteGo.disabled = true
  els.pasteMsg.textContent = `正在匹配 ${items.length} 首歌…`
  try {
    const data = await API.match(items, els.pasteSource.value)
    const songs = []
    let miss = 0
    ;(data.results || []).forEach((r) => { if (r.ok && r.song) songs.push(r.song); else miss++ })
    if (!songs.length) {
      els.pasteMsg.textContent = '一首都没匹配到，请检查格式（每行一首：歌名 - 歌手）'
      return
    }
    const note = [matchNote, miss ? `${miss} 首未匹配到，已跳过（共 ${data.total} 首）` : ''].filter(Boolean).join('；')
    closePaste()
    applyExternalPlaylist(songs, matchLabel, note)
  } catch (e) {
    els.pasteMsg.textContent = '匹配失败：' + e.message
  } finally {
    els.pasteGo.disabled = false
  }
}
els.modeBtn.onclick = () => {
  state.shuffle = !state.shuffle
  updateModeBtn()
}

// 搜索
let searchTimer = null
els.searchBtn.onclick = () => {
  els.searchPanel.classList.remove('hidden')
  els.searchInput.focus()
  els.searchEmpty.classList.remove('hidden')
}
els.searchClose.onclick = () => els.searchPanel.classList.add('hidden')
async function runSearch(kw) {
  try {
    const data = await API.search(kw, 30, preferSource)
    const list = data.list || []
    state.searchList = list
    state.listSource = data.source || nativeOf(preferSource)
    state.listNote = data.note || ''
    renderSongList(list, els.searchResults)
    renderListMeta(data)
    els.searchResults.querySelectorAll('.song-item').forEach((li, i) => {
      li.onclick = () => { playFromList(list, i); openPlayer() }
    })
  } catch (e) {
    els.searchResults.innerHTML = `<div class="empty">搜索失败：${escapeHtml(e.message)}</div>`
  }
}
els.searchInput.addEventListener('input', () => {
  const kw = els.searchInput.value.trim()
  clearTimeout(searchTimer)
  if (!kw) { els.searchEmpty.classList.remove('hidden'); els.searchResults.innerHTML = ''; return }
  els.searchEmpty.classList.add('hidden')
  searchTimer = setTimeout(() => runSearch(kw), 350)
})

// ---------- 洛雪音源管理 ----------
const PLAT_LABEL = { ny: '网易云', kw: '酷我', kg: '酷狗', tx: 'QQ音乐', wy: '网易云', mg: '咪咕', qs: '汽水音乐' }
function updateSourceChip() {
  const nm = sourceNameById[preferSource] || preferSource || '自动'
  setIconText(els.sourceChip, 'note', nm)
  els.sourceChip.classList.toggle('custom', preferSource !== 'auto')
}
// 播放模式按钮：图标 + 文案
function updateModeBtn() {
  if (!els.modeBtn) return
  setIconText(els.modeBtn, state.shuffle ? 'shuffle' : 'seq', state.shuffle ? '随机' : '顺序')
  els.modeBtn.classList.toggle('active', state.shuffle)
}
// 渲染「播放音源」下拉框：按平台分组，同平台下可选不同脚本实现
function renderSourcePick(sources) {
  const sel = els.sourcePick
  sel.innerHTML = ''
  const groups = new Map()
  for (const s of sources) {
    if (s.failed) continue
    const plat = s.type === 'native' ? s.id : (s.source || s.id)
    if (!groups.has(plat)) groups.set(plat, [])
    groups.get(plat).push(s)
  }
  const og = document.createElement('optgroup')
  og.label = '自动回退'
  const auto = document.createElement('option')
  auto.value = 'auto'
  auto.textContent = '自动（内置 → 脚本 → 跨源匹配）'
  og.appendChild(auto)
  sel.appendChild(og)
  for (const [plat, items] of groups) {
    const g = document.createElement('optgroup')
    g.label = PLAT_LABEL[plat] || plat
    for (const s of items) {
      const o = document.createElement('option')
      o.value = s.id
      const label = s.type === 'native'
        ? s.name
        : s.name + (s.builtin ? '（内置脚本）' : '（' + s.script + '）')
      o.textContent = label
      sourceNameById[s.id] = label
      g.appendChild(o)
    }
    sel.appendChild(g)
  }
  if (!sourceNameById[preferSource]) preferSource = 'auto'
  sel.value = preferSource
  updateSourceChip()
}
// 切换音源后立即刷新当前视图：榜单/歌单与播放音源相互独立，不重置选择，
// 仅用当前列表重新拉取（数据仍来自固定引擎），并更新「播放」音源提示
async function refreshForSource() {
  if (state.listKind === 'playlist' && state.playlistId) await loadList(state.playlistId, state.listName)
  else await loadList(state.board, state.listName || '热歌榜')
  // 搜索面板打开且有关键词：用新音源重搜
  const kw = els.searchInput.value.trim()
  if (kw && !els.searchPanel.classList.contains('hidden')) await runSearch(kw)
}
els.sourcePick.onchange = () => {
  preferSource = els.sourcePick.value
  try { localStorage.setItem(PREFER_KEY, preferSource) } catch (_) {}
  updateSourceChip()
  els.sourceMsg.textContent = preferSource === 'auto'
    ? '播放音源：自动回退'
    : '播放音源：' + (sourceNameById[preferSource] || preferSource) + '（取不到时自动回退）'
  els.sourceMsg.className = 'panel-msg ok'
  refreshForSource().catch(() => {})
}
els.sourceChip.onclick = openSources

async function openSources() {
  els.sourcePanel.classList.remove('hidden')
  els.sourceMsg.textContent = '加载中…'
  els.sourceMsg.className = 'panel-msg'
  try {
    const { sources } = await API.sources()
    renderSourcePick(sources)
    els.sourceList.innerHTML = ''
    sources.forEach((s) => {
      const li = document.createElement('li')
      li.className = 'source-item'
      const tag = s.type === 'lx' ? '洛雪脚本' : '内置'
      const note = s.note ? `<span class="s-note">${escapeHtml(s.note)}</span>` : ''
      const acts = (s.actions || []).join('/')
      const delBtn = s.type === 'lx' && !s.builtin
        ? `<button class="btn s-btn danger" data-act="del" data-sid="${escapeHtml(s.script)}"><span>删除</span></button>`
        : ''
      if (s.failed) {
        // 初始化失败的脚本：只能删除，没有可测试的取址能力
        li.className = 'source-item failed'
        li.innerHTML = `
          <div class="s-main">
            <div class="s-name">${escapeHtml(s.name)}
              <span class="s-note">${escapeHtml(s.id)} · 初始化失败</span>
              <span class="s-note">${escapeHtml(s.error || '')}</span>
            </div>
            <span class="s-tag bad">失败</span>
            ${delBtn}
          </div>
          <div class="s-result" data-for="${escapeHtml(s.id)}"></div>`
        els.sourceList.appendChild(li)
        return
      }
      li.innerHTML = `
        <div class="s-main">
          <div class="s-name">${escapeHtml(s.name)}
            <span class="s-note">${escapeHtml(s.id)}${acts ? ' · ' + escapeHtml(acts) : ''}</span>${note}
          </div>
          <span class="s-tag ${s.type === 'native' ? 'native' : ''}">${tag}</span>
          <button class="btn s-btn ghost" data-act="test" data-id="${escapeHtml(s.id)}"><span>测试</span></button>
          ${delBtn}
        </div>
        <div class="s-result" data-for="${escapeHtml(s.id)}"></div>`
      els.sourceList.appendChild(li)
    })
    els.sourceMsg.textContent = '共 ' + sources.length + ' 个音源可用（点「测试」可验证该音源能否取到播放地址）'
  } catch (e) {
    els.sourceMsg.textContent = '加载失败：' + e.message
    els.sourceMsg.className = 'panel-msg err'
  }
}
function setSourceResult(id, text, cls) {
  const box = els.sourceList.querySelector('.s-result[data-for="' + CSS.escape(id) + '"]')
  if (!box) return
  box.textContent = text
  box.className = 's-result ' + (cls || '')
}
async function testOneSource(id, btn) {
  setSourceResult(id, '测试中…', 'testing')
  if (btn) btn.disabled = true
  try {
    const r = await API.testSource(id)
    if (r.ok) {
      const host = (r.url || '').split('/')[2] || ''
      setSourceResult(id, `✓ 可用 · ${r.ms}ms · ${r.via || ''}${host ? ' · ' + host : ''}`, 'ok')
    } else {
      setSourceResult(id, `✗ 失败 · ${r.ms}ms · ${r.error || '未知错误'}`, 'err')
    }
  } catch (e) {
    setSourceResult(id, '✗ 请求失败：' + e.message, 'err')
  } finally {
    if (btn) btn.disabled = false
  }
}
async function deleteOneSource(sid, name) {
  if (!window.confirm(`确定删除音源脚本「${sid}」吗？\n该脚本提供的所有音源都会一并移除。`)) return
  try {
    const r = await API.deleteSource(sid)
    if (r.error) {
      els.sourceMsg.textContent = '删除失败：' + r.error
      els.sourceMsg.className = 'panel-msg err'
      return
    }
    els.sourceMsg.textContent = '已删除：' + sid
    els.sourceMsg.className = 'panel-msg ok'
    await openSources()
  } catch (e) {
    els.sourceMsg.textContent = '删除失败：' + e.message
    els.sourceMsg.className = 'panel-msg err'
  }
}
async function importSource(payload, label) {
  els.sourceMsg.textContent = '正在导入…'
  els.sourceMsg.className = 'panel-msg'
  try {
    const r = await API.importSource(payload)
    if (r.error) {
      els.sourceMsg.textContent = '导入失败：' + r.error
      els.sourceMsg.className = 'panel-msg err'
      return
    }
    if (r.duplicate) {
      els.sourceMsg.textContent = r.message || ('该脚本已存在（' + r.id + '），未重复导入')
      els.sourceMsg.className = 'panel-msg'
      await openSources()
      return
    }
    els.sourceMsg.textContent = '导入成功（' + label + '）：脚本 ' + r.id + '，提供音源 ' + (r.sources || []).join(', ')
    els.sourceMsg.className = 'panel-msg ok'
    await openSources()
  } catch (e) {
    els.sourceMsg.textContent = '导入失败：' + e.message
    els.sourceMsg.className = 'panel-msg err'
  }
}
// 事件委托：测试 / 删除
els.sourceList.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]')
  if (!btn) return
  if (btn.dataset.act === 'test') testOneSource(btn.dataset.id, btn)
  else if (btn.dataset.act === 'del') deleteOneSource(btn.dataset.sid, btn.dataset.sid)
})
els.sourceTestAll.onclick = async () => {
  const btns = [...els.sourceList.querySelectorAll('button[data-act="test"]')]
  els.sourceTestAll.disabled = true
  els.sourceTestAll.innerHTML = '<span>测试中…</span>'
  // 并行测试，避免逐个等待
  await Promise.all(btns.map((b) => testOneSource(b.dataset.id, b)))
  els.sourceTestAll.disabled = false
  els.sourceTestAll.innerHTML = '<span>测试全部音源</span>'
}
els.sourceBtn.onclick = openSources
els.sourceClose.onclick = () => els.sourcePanel.classList.add('hidden')
els.sourceImportUrl.onclick = () => {
  const url = els.sourceUrl.value.trim()
  if (!url) return
  importSource({ url, id: 'lx' }, 'URL')
}
els.sourceImportCode.onclick = () => {
  const code = els.sourceCode.value
  if (!code || !code.trim()) return
  importSource({ code, id: 'lx' }, '脚本内容')
}

// ---------- 初始化 ----------
window.addEventListener('error', (e) => {
  const box = document.createElement('div')
  box.className = 'err-bar'
  box.textContent = '出错了：' + (e.message || e.error) + '（点击关闭）'
  box.onclick = () => box.remove()
  document.body.appendChild(box)
  setTimeout(() => box.remove(), 10000)
})
// 把 emoji 占位替换成 SVG 图标（HTML 里只留 aria-label，避免 JS 未就绪时露出怪字符）
function paintIcons() {
  setIcon(els.searchBtn, 'search')
  setIcon(els.sourceBtn, 'sliders')
  setIcon(els.searchClose, 'close')
  setIcon(els.sourceClose, 'close')
  setIcon(els.pasteClose, 'close')
  setIcon(els.playerClose, 'chevronDown')
  setIcon(els.playerQueueBtn, 'list')
  setIcon(els.queueClose, 'close')
  initTheme()
  setIcon(els.miniOpen, 'chevronUp')
  setIcon(els.shuffleIcon, 'shuffle')
  setIconText(els.playAllBtn, 'play', '全部播放')
  setIcon(els.prevBtn, 'prev')
  setIcon(els.nextBtn, 'next')
  setIcon(els.playBtn, 'play')
  setIcon(els.miniPlay, 'play')
  setIcon(els.miniPrev, 'prev')
  setIcon(els.miniNext, 'next')
  updateModeBtn()
  updateSourceChip()
}
;(async function init() {
  paintIcons()
  // 歌词滚动容器：用户手动滚动（滚轮/触摸）时暂停自动居中，空闲后恢复
  els.lyricScroll.addEventListener('wheel', markUserScroll, { passive: true })
  els.lyricScroll.addEventListener('touchmove', markUserScroll, { passive: true })
  try {
    // 榜单列表用所选平台（默认网易云，可下拉切换酷我），与播放音源相互独立
    els.platSelect.value = state.boardPlat
    // 歌单平台默认网易云（可下拉切 QQ / 酷狗）
    els.playlistPlatSelect.value = state.playlistPlat
    state.board = (DEFAULT_BOARD[state.boardPlat] || DEFAULT_BOARD.ny).id
    state.listName = (DEFAULT_BOARD[state.boardPlat] || DEFAULT_BOARD.ny).name
    await renderBoards()
    await loadList(state.board, state.listName)
  } catch (e) {
    els.songList.innerHTML = `<div class="empty">初始化失败：${escapeHtml(e.message)}</div>`
  }
})()
