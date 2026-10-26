// 洛雪音乐(LX Music) 自定义源脚本运行时
//
// 协议对齐洛雪 1.9.1（android/app/src/main/assets/script/user-api-preload.js）：
//   脚本读取 globalThis.lx = { EVENT_NAMES, on, send, request, utils, version, currentScriptInfo }
//   脚本 send('inited', { status, sources }) 注册音源
//   宿主 send('request', { source, action, info }) -> 脚本的 request 处理器返回 Promise
//     action='musicUrl' 时 info = { musicInfo, type }
//
// 参考实现：https://github.com/lyswhut/lx-music-source
const vm = require('vm')
const crypto = require('crypto')
const zlib = require('zlib')
const http = require('http')
const https = require('https')
const { URL } = require('url')

const EVENT_NAMES = { request: 'request', inited: 'inited', updateAlert: 'updateAlert' }

function toBuf(v) {
  if (Buffer.isBuffer(v)) return v
  if (v == null) return Buffer.alloc(0)
  if (typeof v === 'string') return Buffer.from(v, 'utf8')
  if (ArrayBuffer.isView(v)) return Buffer.from(v.buffer, v.byteOffset, v.byteLength)
  if (v instanceof ArrayBuffer) return Buffer.from(v)
  return Buffer.from(String(v), 'utf8')
}

// ---------- 宿主侧 HTTP（对齐洛雪 request 语义）----------
function httpRequest(url, options = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    let u
    try {
      u = new URL(url)
    } catch (e) {
      return reject(new Error('非法URL: ' + url))
    }
    const isHttps = u.protocol === 'https:'
    const lib = isHttps ? https : http
    const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', ...(options.headers || {}) }
    let body = null
    if (options.form && typeof options.form === 'object') {
      body = new URLSearchParams(options.form).toString()
      headers['content-type'] = headers['content-type'] || 'application/x-www-form-urlencoded'
    } else if (options.body != null) {
      body = toBuf(options.body)
    }
    if (body) headers['content-length'] = body.length
    const timeout = options.timeout || 20000
    // 硬超时兜底（DNS/TCP 阶段 socket 未分配时 setTimeout 不生效）
    const guard = setTimeout(() => req.destroy(new Error('请求超时')), timeout + 3000)
    guard.unref && guard.unref()

    const req = lib.request(
      { protocol: u.protocol, hostname: u.hostname, port: u.port || (isHttps ? 443 : 80), path: u.pathname + u.search, method: options.method || 'GET', autoSelectFamily: true, headers },
      (res) => {
        clearTimeout(guard)
        // 跟随重定向（洛雪原生 request 会跟随）
        if (redirects < 5 && [301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume()
          const next = new URL(res.headers.location, url).toString()
          return resolve(httpRequest(next, options, redirects + 1))
        }
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const raw = Buffer.concat(chunks)
          let parsed = raw.toString('utf8')
          const ct = String(res.headers['content-type'] || '')
          if (ct.includes('json') || /^\s*[[{]/.test(parsed)) {
            try {
              parsed = JSON.parse(parsed)
            } catch (e) { /* 保持字符串 */ }
          }
          resolve({ body: parsed, headers: res.headers, statusCode: res.statusCode })
        })
      }
    )
    req.setTimeout(timeout, () => req.destroy(new Error('请求超时')))
    req.on('error', (e) => { clearTimeout(guard); reject(e) })
    if (body) req.write(body)
    req.end()
  })
}

// ---------- 洛雪 utils 实现 ----------
const lxUtils = {
  buffer: {
    from: (v, enc) => (enc ? Buffer.from(toBuf(v).toString('latin1'), enc) : toBuf(v)),
    bufToString: (v, enc) => toBuf(v).toString(enc || 'utf8'),
  },
  crypto: {
    // aesEncrypt(buffer, mode, key, iv) -> Buffer
    // 注意1：洛雪原生 AES.java 里 ECB 模式用的是 Java 的 "AES" 别名 = AES/ECB/PKCS5Padding（带填充），
    //        不是 NoPadding。写错会导致 eapi（网易）报 "wrong final block length"。
    // 注意2：洛雪原生返回的是 **Buffer**（脚本侧 buf2hex 会再按 hex 转字符串），
    //        若返回 base64 字符串会被当成字节流做 hex 编码，签名全错。
    // 注意3：mode 传入的是 'ecb' / 'cbc'（洛雪 utils.js 会 mode.split('-').pop()）。
    aesEncrypt(data, mode, key, iv) {
      const buf = toBuf(data)
      const k = toBuf(key)
      const algo = k.length === 24 ? 'aes-192' : k.length === 32 ? 'aes-256' : 'aes-128'
      if (/cbc/i.test(String(mode || ''))) {
        const ivBuf = Buffer.alloc(16)
        const ivRaw = toBuf(iv)
        ivRaw.copy(ivBuf, 0, 0, Math.min(16, ivRaw.length))
        const c = crypto.createCipheriv(algo + '-cbc', k, ivBuf)
        return Buffer.concat([c.update(buf), c.final()])
      }
      const c = crypto.createCipheriv(algo + '-ecb', k, null)
      return Buffer.concat([c.update(buf), c.final()])
    },
    aesDecrypt(data, mode, key, iv) {
      const buf = toBuf(data)
      const k = toBuf(key)
      const algo = k.length === 24 ? 'aes-192' : k.length === 32 ? 'aes-256' : 'aes-128'
      if (/cbc/i.test(String(mode || ''))) {
        const ivBuf = Buffer.alloc(16)
        const ivRaw = toBuf(iv)
        ivRaw.copy(ivBuf, 0, 0, Math.min(16, ivRaw.length))
        const d = crypto.createDecipheriv(algo + '-cbc', k, ivBuf)
        return Buffer.concat([d.update(buf), d.final()])
      }
      const d = crypto.createDecipheriv(algo + '-ecb', k, null)
      return Buffer.concat([d.update(buf), d.final()])
    },
    md5: (str) => crypto.createHash('md5').update(toBuf(str)).digest('hex'),
    randomBytes: (size) => {
      const b = crypto.randomBytes(size)
      return Array.from(b)
    },
    rsaEncrypt(data, key) {
      return crypto.publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_PADDING }, toBuf(data)).toString('base64')
    },
  },
  zlib: {
    inflate: (buf) => zlib.inflateSync(toBuf(buf)),
    deflate: (buf) => zlib.deflateSync(toBuf(buf)),
  },
}

/**
 * 加载一个洛雪源脚本
 * @param {string} code 脚本源码
 * @param {object} meta { id, name }
 * @returns {{ sources: object, call: Function, ready: Promise }}
 */
function loadLxSource(code, meta = {}) {
  const handlers = { request: [] }
  const pending = new Map()
  let sources = {}
  let initStatus = false
  let initError = null
  let reqSeq = 0
  let resolveReady
  let readySettled = false
  const ready = new Promise((res) => { resolveReady = res })
  // 兜底：脚本若未在 15 秒内发 inited（格式不对 / 提前抛错 / 覆盖了 globalThis.lx），不能让服务器永久挂起
  const readyTimer = setTimeout(() => {
    if (readySettled) return
    readySettled = true
    initError = initError || '源脚本未在 15 秒内完成初始化（可能格式不符合洛雪规范）'
    resolveReady({ status: false, sources: {}, error: initError })
  }, 15000)
  readyTimer.unref && readyTimer.unref()

  const lx = {
    EVENT_NAMES,
    version: '1.9.1',
    currentScriptInfo: { id: meta.id || 'user', name: meta.name || '自定义源', version: meta.version || '1.0.0', author: meta.author || '', homepage: meta.homepage || '' },
    on(evt, cb) {
      if (!handlers[evt]) handlers[evt] = []
      handlers[evt].push(cb)
    },
    send(evt, data) {
      if (evt === EVENT_NAMES.inited) {
        if (readySettled) return
        readySettled = true
        clearTimeout(readyTimer)
        if (data && data.status) {
          sources = data.sources || {}
          initStatus = true
        } else {
          initError = (data && data.errorMessage) || '源脚本初始化失败'
        }
        resolveReady({ status: initStatus, sources, error: initError })
      } else if (evt === EVENT_NAMES.response) {
        const p = pending.get(data && data.requestKey)
        if (!p) return
        pending.delete(data.requestKey)
        if (data.status) p.resolve(data.result)
        else p.reject(new Error(data.errorMessage || 'failed'))
      }
    },
    request(url, options, callback) {
      const cb = typeof options === 'function' ? options : callback
      const opts = typeof options === 'function' ? {} : options || {}
      const controller = { aborted: false, abort() { this.aborted = true } }
      httpRequest(url, opts).then(
        (resp) => { if (typeof cb === 'function') cb(null, resp) },
        (err) => { if (typeof cb === 'function') cb(err, null) }
      )
      return controller
    },
    utils: lxUtils,
  }

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    setImmediate,
    clearImmediate,
    Promise,
    Buffer,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
    btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
    crypto: { webcrypto: undefined },
    lx,
  }
  sandbox.globalThis = sandbox
  sandbox.self = sandbox
  sandbox.window = sandbox

  const context = vm.createContext(sandbox)
  try {
    vm.runInContext(code, context, { filename: meta.id || 'lx-source.js', timeout: 30000 })
  } catch (e) {
    if (!readySettled) {
      readySettled = true
      clearTimeout(readyTimer)
      initError = '脚本执行异常: ' + e.message
      resolveReady({ status: false, sources: {}, error: initError })
    }
  }

  /** 调用脚本的动作（如 musicUrl） */
  async function call(action, source, info) {
    if (!initStatus) throw new Error(initError || '源脚本未就绪')
    const list = handlers[EVENT_NAMES.request] || []
    if (!list.length) throw new Error('源脚本未注册 request 处理器')
    const req = { source, action, info }
    // 洛雪脚本的 request 处理器返回 Promise；也兼容走 send('response') 的实现
    const p = new Promise((resolve, reject) => {
      const key = 'r' + ++reqSeq
      pending.set(key, { resolve, reject })
      let done = false
      const finish = (fn, v) => { if (done) return; done = true; pending.delete(key); fn(v) }
      for (const cb of list) {
        try {
          const r = cb.call(lx, req)
          if (r && typeof r.then === 'function') {
            r.then((v) => finish(resolve, v), (e) => finish(reject, e))
          } else if (r !== undefined) {
            finish(resolve, r)
          }
        } catch (e) {
          finish(reject, e)
        }
      }
      setTimeout(() => finish(reject, new Error('源脚本响应超时')), 30000)
    })
    const res = await p
    if (action === 'musicUrl') {
      if (typeof res !== 'string' || !/^https?:\/\//i.test(res)) throw new Error('源脚本未返回有效音频地址')
    }
    return res
  }

  return { sources, call, ready, meta }
}

module.exports = { loadLxSource, httpRequest, lxUtils, EVENT_NAMES }
