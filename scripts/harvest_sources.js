#!/usr/bin/env node
'use strict'

/**
 * 洛雪音源自动搜罗器
 *
 * 每天跑一次，做四件事：
 *   1. 发现：从已知源仓库清单 + GitHub 搜索收集洛雪自定义源脚本
 *   2. 试运行：把脚本交给服务端在内存里加载并真实取址（POST /api/source/probe），不落盘
 *   3. 导入：只有试运行取址成功的脚本才真正导入（POST /api/source/import）
 *   4. 清理：复测存量脚本，全部音源都取不到地址的删除（DELETE /api/source/:id）
 *
 * 两个关键设计：
 *   - 优先走 raw.githubusercontent.com 直连（不消耗 GitHub API 配额）。
 *     API 未认证只有 60 次/小时，很容易被耗尽；耗尽时会被误读成「今天没有可用源」。
 *   - 「可用」以真实取址结果为准，不看文件名/静态特征（同名文件可能是别的东西）。
 *
 * 安全取舍：
 *   - 后端用 Node vm 沙箱运行脚本，只暴露 lx 协议与有限全局对象。
 *     注意：vm 并非强安全边界，自动导入等于信任上游仓库。
 *     因此默认带 --min-stars=5 星标门槛，建议只放行有社区背书的仓库。
 *   - 内置脚本（builtin）与原生音源永不删除，最差情况仍回落到网易云可播。
 *
 * 用法：
 *   node scripts/harvest_sources.js
 *   node scripts/harvest_sources.js --dry-run
 *   node scripts/harvest_sources.js --repos=20 --only=discover --verbose
 *   GITHUB_TOKEN=xxx node scripts/harvest_sources.js
 */

const https = require('https')
const http = require('http')
const fs = require('fs')
const path = require('path')

// ---------- 参数 ----------
const argv = process.argv.slice(2)
const has = (n) => argv.includes('--' + n)
function opt(n, def) {
  const p = argv.find((a) => a === '--' + n || a.startsWith('--' + n + '='))
  if (!p) return def
  const i = p.indexOf('=')
  return i > -1 ? p.slice(i + 1) : true
}

const BASE = String(process.env.LXMW_BASE || opt('base', 'http://hly1221.top:3005')).replace(/\/+$/, '')
const DRY_RUN = has('dry-run')
const MAX_REPOS = parseInt(opt('repos', '10'), 10) || 10
const MAX_FILES = parseInt(opt('files', '1'), 10) || 1
// 星标门槛：只放行有社区背书的仓库（自动导入等于信任上游脚本）
const MIN_STARS = parseInt(opt('min-stars', '5'), 10) || 0
// 单次任务最多试运行多少个脚本（每次试运行都要真实取址，控制耗时与网络开销）
const MAX_PROBE = parseInt(opt('max-probe', '6'), 10) || 6
const ONLY = String(opt('only', 'all'))   // discover | clean | all
const VERBOSE = !has('quiet')

const UA = 'lx-music-web-harvester'
const log = (s) => process.stdout.write(s + '\n')

// ---------- HTTP ----------
function rawRequest(url, { method = 'GET', headers = {}, body = null, timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    let u
    try {
      u = new URL(url)
    } catch (e) {
      return reject(new Error('非法 URL: ' + url))
    }
    const lib = u.protocol === 'https:' ? https : http
    const h = { 'User-Agent': UA, 'Accept-Encoding': 'identity', ...headers }
    if (body != null) h['content-length'] = Buffer.byteLength(body)
    const guard = setTimeout(() => req.destroy(new Error('请求超时')), timeout + 3000)
    guard.unref && guard.unref()
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: u.pathname + u.search,
        method,
        headers: h,
      },
      (res) => {
        clearTimeout(guard)
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString('utf8') }))
      }
    )
    req.setTimeout(timeout, () => req.destroy(new Error('请求超时')))
    req.on('error', (e) => {
      clearTimeout(guard)
      reject(e)
    })
    if (body != null) req.write(body)
    req.end()
  })
}

async function getJSON(url, headers = {}) {
  const r = await rawRequest(url, { headers: { Accept: 'application/vnd.github+json', ...headers } })
  // 限流必须显式上抛：否则会被静默吞掉，看起来像「今天没找到任何源」
  if ((r.status === 403 || r.status === 429) && /rate limit/i.test(r.text)) {
    const e = new Error('GitHub API 限流（设置 GITHUB_TOKEN 可提高到 5000 次/小时）')
    e.rateLimited = true
    throw e
  }
  if (r.status !== 200) throw new Error('HTTP ' + r.status)
  try {
    return JSON.parse(r.text)
  } catch (e) {
    throw new Error('响应不是合法 JSON')
  }
}

async function getText(url, headers = {}) {
  const r = await rawRequest(url, { headers })
  if (r.status !== 200) throw new Error('HTTP ' + r.status)
  return r.text
}

const ghHeaders = () => (process.env.GITHUB_TOKEN ? { Authorization: 'Bearer ' + process.env.GITHUB_TOKEN } : {})

// ---------- 站点 API ----------
async function api(p, { method = 'GET', body } = {}) {
  if (method === 'GET') return getJSON(BASE + p, { Accept: 'application/json' })
  const r = await rawRequest(BASE + p, {
    method,
    headers: { 'content-type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body || {}),
  })
  try {
    return JSON.parse(r.text)
  } catch (e) {
    return { error: '响应解析失败 ' + r.status }
  }
}

async function listEntries() {
  const s = await api('/api/sources')
  return (s && s.sources) || []
}

// 对某个脚本提供的每个音源做真实取址测试
async function testScript(scriptId) {
  const entries = await listEntries()
  const mine = entries.filter((e) => e.type === 'lx' && e.script === scriptId)
  const failedInit = mine.filter((e) => e.failed).length
  const testable = mine.filter((e) => !e.failed && (e.actions || []).includes('musicUrl'))
  const out = []
  let okCount = 0
  for (const e of testable) {
    let t = null
    try {
      t = await api('/api/source/test', { method: 'POST', body: { id: e.id } })
    } catch (err) {
      t = { ok: false, error: err.message }
    }
    if (t && t.ok) okCount++
    out.push({ id: e.id, ok: !!(t && t.ok), ms: (t && t.ms) || 0, via: (t && t.via) || '', error: (t && t.error) || '' })
  }
  return { total: mine.length, testable: testable.length, okCount, failedInit, results: out }
}

async function probeCode(code) {
  return api('/api/source/probe', { method: 'POST', body: { code } })
}

// ---------- 轻量预检 ----------
// 只剔除明显不是源脚本 / 有风险的样本，真正的可用性由服务端试运行判定
const MAX_CODE = 800 * 1024
function litePrecheck(code) {
  if (!code || !code.trim()) return '空文件'
  const size = Buffer.byteLength(code, 'utf8')
  if (size < 1024) return '文件过小（<1KB），不像源脚本'
  if (size > MAX_CODE) return '文件过大（>800KB）'
  if (!/lx/.test(code)) return '未出现 lx，不是洛雪源脚本'
  if (/child_process|require\(\s*['"](?:fs|net|http|vm)/.test(code)) return '试图使用沙箱未提供的模块'
  if (/process\.binding|\beval\(/.test(code)) return '包含高危调用'
  return null
}

// ---------- 候选来源 ----------
// 洛雪源脚本约定文件名为 latest.js；这些仓库经社区长期维护。
// 走 raw 直连不消耗 API 配额，因此作为主要来源。
const KNOWN_REPOS = [
  {
    repo: 'pdone/lx-music-source',
    branch: 'main',
    dirs: ['qdy', 'huibq', 'ikun', 'changqing', 'flower', 'grass', 'juhe', 'sixyin', 'xinghai'],
  },
]
const PREFERRED = ['latest.js', 'script.js']
const SKIP_DIR = /^(test|tests|demo|example|docs|node_modules|\.)/i

function looksLikeSource(name) {
  return /\.js$/i.test(name) && !/(^|\/)(test|demo|example|webpack|rollup|polyfill)/i.test(name)
}

const rawUrl = (repo, branch, p) =>
  'https://raw.githubusercontent.com/' + repo + '/' + branch + '/' + String(p).replace(/^\/+/, '')

// 已知仓库：按「文件名轮次」组织，先试所有目录的 latest.js，再试 script.js
function knownRounds() {
  const rounds = []
  for (const f of PREFERRED) {
    const round = []
    for (const k of KNOWN_REPOS) {
      for (const d of k.dirs) {
        const p = d ? d + '/' + f : f
        round.push({ repo: k.repo, path: p, download_url: rawUrl(k.repo, k.branch, p) })
      }
    }
    rounds.push(round)
  }
  return rounds
}

async function discoverRepos() {
  const map = new Map()
  const add = (r) => { if (r && r.full_name) map.set(r.full_name, r) }
  for (const q of ['lx-music-source in:name', '洛雪 音源', 'lxmusic source']) {
    try {
      const j = await getJSON(
        'https://api.github.com/search/repositories?q=' + encodeURIComponent(q) + '&sort=stars&per_page=15',
        ghHeaders()
      )
      for (const it of j.items || []) add(it)
    } catch (e) {
      if (e && e.rateLimited) throw e
      log('[发现] 搜索失败 "' + q + '"：' + e.message)
    }
  }
  // fork 网络里常藏着仍在维护的源
  for (const seed of ['lyswhut/lx-music-source', 'pdone/lx-music-source']) {
    try {
      const j = await getJSON(
        'https://api.github.com/repos/' + seed + '/forks?per_page=30&sort=stargazers',
      ghHeaders()
      )
      for (const it of j || []) add(it)
    } catch (e) {
      if (e && e.rateLimited) throw e
      log('[发现] fork 列表失败 ' + seed + '：' + e.message)
    }
  }
  const repos = [...map.values()].filter((r) => (r.stargazers_count || 0) >= MIN_STARS)
  repos.sort(
    (a, b) =>
      (b.stargazers_count || 0) - (a.stargazers_count || 0) ||
      String(b.pushed_at || '').localeCompare(String(a.pushed_at || ''))
  )
  return repos.slice(0, MAX_REPOS)
}

async function listDir(repo, dir) {
  const branch = repo.default_branch || 'main'
  const pathname = dir ? '/contents/' + dir : '/contents'
  const url = 'https://api.github.com/repos/' + repo.full_name + pathname + '?ref=' + encodeURIComponent(branch)
  try {
    return await getJSON(url, ghHeaders())
  } catch (e) {
    if (e && e.rateLimited) throw e
    return null
  }
}

// 用 git trees API 一次拿到整个仓库的文件清单，
// 避免为「根目录 / dist / src ...」逐个目录发请求
async function findScriptFiles(repo) {
  const branch = repo.default_branch || 'main'
  const treeUrl =
    'https://api.github.com/repos/' + repo.full_name + '/git/trees/' + encodeURIComponent(branch) + '?recursive=1'
  let blobs = []
  try {
    const tree = await getJSON(treeUrl, ghHeaders())
    if (Array.isArray(tree.tree)) {
      blobs = tree.tree.filter((f) => f.type === 'blob' && looksLikeSource(f.path) && (f.size || 0) < MAX_CODE)
    }
  } catch (e) {
    if (e && e.rateLimited) throw e
  }
  if (!blobs.length) {
    const root = await listDir(repo, '')
    if (Array.isArray(root)) {
      blobs = root
        .filter((f) => f.type === 'file' && looksLikeSource(f.name) && (f.size || 0) < MAX_CODE)
        .map((f) => ({ path: f.name, size: f.size || 0 }))
    }
  }
  const rank = (f) => {
    const base = String(f.path || '').split('/').pop().toLowerCase()
    const i = PREFERRED.indexOf(base)
    const depth = String(f.path || '').split('/').length - 1
    return (i < 0 ? 90 : i) * 100 + depth
  }
  return blobs
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, MAX_FILES)
    .map((f) => ({
      path: f.path,
      name: String(f.path || '').split('/').pop(),
      size: f.size || 0,
      download_url: rawUrl(repo, branch, f.path),
    }))
}

// ---------- 主流程 ----------
async function main() {
  log('[搜罗] 目标站点：' + BASE + (DRY_RUN ? '（dry-run：只报告不改动）' : ''))

  const before = await listEntries()
  const beforeUserScripts = [
    ...new Set(before.filter((s) => s.type === 'lx' && !s.builtin).map((s) => s.script)),
  ]
  log('[存量] 当前 ' + before.length + ' 个音源条目，其中用户脚本 ' + beforeUserScripts.length + ' 个：' + (beforeUserScripts.join(', ') || '无'))

  const imported = []
  const duplicates = []
  const rejected = []
  const cleaned = []
  const kept = []
  let rateLimited = false

  // ---- 1) 收集候选脚本地址 ----
  const candidates = []
  if (ONLY !== 'clean') {
    // 已知仓库（raw 直连，不消耗 API 配额）
    for (const round of knownRounds()) {
      for (const c of round) candidates.push(c)
    }
    // GitHub 搜索发现的新仓库（配额不足时整体跳过）
    try {
      const repos = await discoverRepos()
      if (VERBOSE) log('[发现] GitHub 搜索命中仓库 ' + repos.length + ' 个')
      for (const repo of repos) {
        const files = await findScriptFiles(repo).catch(() => [])
        for (const f of files) {
          candidates.push({ repo: repo.full_name, path: f.path, download_url: f.download_url })
        }
      }
    } catch (e) {
      rateLimited = true
      log('[发现] GitHub API 不可用：' + e.message + '（本次仅使用内置已知源清单）')
    }
  }

  // 同一 raw 地址只试一次
  const seen = new Set()
  const uniq = candidates.filter((c) => (seen.has(c.download_url) ? false : (seen.add(c.download_url), true)))
  log('[发现] 待试运行脚本 ' + uniq.length + ' 个')

  // ---- 2) 逐个试运行，取址成功的才导入 ----
  let probed = 0
  const doneRepos = new Set()
  for (const c of uniq) {
    if (probed >= MAX_PROBE) break
    if (doneRepos.has(c.repo)) continue
    if (VERBOSE) log('[下载] ' + c.repo + '/' + c.path)
    let code = ''
    try {
      code = await getText(c.download_url)
    } catch (e) {
      const why = '下载失败：' + (e && e.message ? e.message : String(e))
      if (VERBOSE) log('[下载失败] ' + c.repo + '/' + c.path + ' -> ' + why)
      rejected.push({ repo: c.repo, file: c.path, reason: why })
      continue
    }
    // 先做静态预检：明显不是源脚本/有风险的样本不该占用「试运行」配额，
    // 否则 MAX_PROBE 会被垃圾文件吃光，真正的候选永远排不到
    const why = litePrecheck(code)
    if (why) {
      rejected.push({ repo: c.repo, file: c.path, reason: why })
      continue
    }
    probed++
    let p = null
    try {
      p = await probeCode(code)
    } catch (e) {
      rejected.push({ repo: c.repo, file: c.path, reason: '试运行请求失败：' + e.message })
      continue
    }
    const sources = (p && p.sources) || []
    const okSources = sources.filter((s) => s.urlOk)
    if (!okSources.length) {
      rejected.push({
        repo: c.repo,
        file: c.path,
        reason: '试运行未取到播放地址（' + sources.map((s) => s.name).join(', ') + '）',
      })
      continue
    }
    if (DRY_RUN) {
      imported.push({
        repo: c.repo,
        file: c.path,
        script: '(dry-run 未导入)',
        okCount: okSources.length,
        total: sources.length,
        dryRun: true,
      })
      continue
    }
    const r = await api('/api/source/import', { method: 'POST', body: { code, id: 'lx' } }).catch((e) => ({ error: e.message }))
    if (r.error) {
      rejected.push({ repo: c.repo, file: c.path, reason: r.error })
      continue
    }
    if (r.duplicate) {
      duplicates.push(r.id)
      continue
    }
    imported.push({ repo: c.repo, file: c.path, script: r.id, okCount: okSources.length, total: sources.length })
  }

  // ---- 3) 复测存量脚本，清理失效的 ----
  for (const sid of ONLY === 'discover' ? [] : beforeUserScripts) {
    const t = await testScript(sid).catch(() => ({ testable: 0, okCount: 0, total: 0 }))
    if (t.testable === 0) {
      cleaned.push({ script: sid, reason: '无可用取址音源' })
    } else if (t.okCount === 0) {
      cleaned.push({ script: sid, reason: '全部音源取址失败（' + t.testable + ' 个）' })
    } else {
      kept.push({ script: sid, okCount: t.okCount, total: t.testable })
      continue
    }
    if (DRY_RUN) {
      cleaned[cleaned.length - 1].reason += '（dry-run 未删除）'
      continue
    }
    await api('/api/source/' + encodeURIComponent(sid), { method: 'DELETE' }).catch(() => ({}))
  }

  // ---- 4) 报告 ----
  const after = await listEntries()
  log('')
  log('===== 搜罗报告 =====')
  log('新增可用脚本：' + imported.filter((x) => !x.dryRun).length)
  for (const x of imported) {
    log('  + ' + x.script + '  (' + x.repo + '/' + x.file + ')  可用音源 ' + (x.okCount || 0) + '/' + (x.total || 0))
  }
  log('已存在（跳过）：' + duplicates.length + (duplicates.length ? ' -> ' + duplicates.join(', ') : ''))
  log('清理失效脚本：' + cleaned.length)
  for (const x of cleaned) log('  - ' + x.script + '：' + x.reason)
  log('保留有效脚本：' + kept.length)
  for (const x of kept) log('  * ' + x.script + '：可用 ' + x.okCount + '/' + x.total)
  log('未通过（跳过）：' + rejected.length)
  for (const x of rejected.slice(0, 10)) log('  x ' + x.repo + '/' + x.file + '：' + x.reason)
  log('音源条目：' + before.length + ' -> ' + after.length)
  if (rateLimited) log('提示：GitHub API 已限流，本次未扫描新仓库；设置 GITHUB_TOKEN 可解除限制。')

  try {
    const dir = path.join(__dirname, '..', 'data')
    fs.mkdirSync(dir, { recursive: true })
    const d = new Date()
    const day =
      d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
    const file = path.join(dir, 'harvest-report-' + day + '.json')
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          at: d.toISOString(),
          base: BASE,
          dryRun: DRY_RUN,
          rateLimited,
          imported,
          duplicates,
          rejected,
          cleaned,
          kept,
          before: before.length,
          after: after.length,
        },
        null,
        2
      )
    )
    log('报告已写入：' + file)
  } catch (_) { /* 落盘失败不影响主流程 */ }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      log('[搜罗失败] ' + (e && e.message ? e.message : String(e)))
      process.exit(1)
    })
}

module.exports = { litePrecheck, PREFERRED, looksLikeSource }
