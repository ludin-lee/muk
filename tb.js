#!/usr/bin/env node
// 터미널 e-ink 브라우저: 헤드리스 Chrome → 흑백 디더링 → iTerm2 인라인 이미지
//   node tb.js [url]                 실행
//   node tb.js --shot <url> <png>    한 프레임만 파일로 저장 (렌더 파이프라인 확인용)
const { spawn } = require('node:child_process')
const zlib = require('node:zlib')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')

const CHROME = process.env.TB_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
// 보정 손잡이: TB_SCALE = 렌더 배율(레티나 2), TB_CELL = 글자 칸 크기 "8x17" (터미널이 크기 질의에 답하지 않거나 틀릴 때)
const SCALE = Number(process.env.TB_SCALE) || 2
const CELL = process.env.TB_CELL?.split('x').map(Number)
// TB_IDLE_MS = 조작이 없을 때 화면 갱신 최소 간격(ms). 낮추면 부드럽고 CPU를 더 쓴다
const IDLE_MS = Number(process.env.TB_IDLE_MS) || 700

// 새 탭으로 열리는 링크는 보이지 않으므로 같은 탭에서 열리게 한다
const SAME_TAB = `addEventListener('click', e => { const a = e.target.closest?.('a[target]'); if (a) a.target = '_self' }, true)
window.open = u => (location.href = u, window)`

const KEYS = {
  '\r': ['Enter', 13, '\r'], '\x7f': ['Backspace', 8], '\t': ['Tab', 9], '\x1b': ['Escape', 27],
  '\x1b[A': ['ArrowUp', 38], '\x1b[B': ['ArrowDown', 40], '\x1b[C': ['ArrowRight', 39], '\x1b[D': ['ArrowLeft', 37],
  '\x1b[H': ['Home', 36], '\x1b[F': ['End', 35], '\x1b[5~': ['PageUp', 33], '\x1b[6~': ['PageDown', 34], '\x1b[3~': ['Delete', 46],
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
const toUrl = s => /^(https?|file|about|chrome):/i.test(s) ? s
  : /^\S+\.\S+$/.test(s) ? 'https://' + s
  : 'https://search.naver.com/search.naver?query=' + encodeURIComponent(s)

// Chrome 스크린샷 전용 디코더: 8비트 RGB/RGBA, 인터레이스 없음
function decodePng(buf) {
  let w, h, ch
  const idat = []
  for (let pos = 8; pos < buf.length;) {
    const len = buf.readUInt32BE(pos), type = buf.toString('latin1', pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4); ch = { 2: 3, 6: 4 }[data[9]]
      if (data[8] !== 8 || !ch || data[12]) throw new Error('지원하지 않는 PNG 형식')
    } else if (type === 'IDAT') idat.push(data)
    pos += 12 + len
  }
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * ch + 1
  for (let y = 0; y < h; y++) {
    const f = raw[y * stride], row = y * stride + 1, prev = row - stride
    if (!f) continue
    for (let x = 0; x < stride - 1; x++) {
      const a = x >= ch ? raw[row + x - ch] : 0, b = y ? raw[prev + x] : 0, c = x >= ch && y ? raw[prev + x - ch] : 0
      let p = a
      if (f === 2) p = b
      else if (f === 3) p = (a + b) >> 1
      else if (f === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c)
        p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      raw[row + x] = (raw[row + x] + p) & 255
    }
  }
  return { w, h, ch, raw }
}

// 4x4 Bayer 디더링 → 1비트 PNG. 순백/순흑은 그대로, 중간 톤만 점 패턴이 된다
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]
function ditherPng({ w, h, ch, raw }) {
  const rb = (w + 7) >> 3, bits = Buffer.alloc(h * (rb + 1))
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * (w * ch + 1) + 1 + x * ch
      const lum = (raw[i] * 77 + raw[i + 1] * 150 + raw[i + 2] * 29) >> 8
      if (lum > BAYER[(y & 3) * 4 + (x & 3)] * 16 + 8) bits[y * (rb + 1) + 1 + (x >> 3)] |= 0x80 >> (x & 7)
    }
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]), out = Buffer.alloc(body.length + 8)
    out.writeUInt32BE(data.length); body.copy(out, 4); out.writeUInt32BE(zlib.crc32(body), body.length + 4)
    return out
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 1
  return Buffer.concat([
    Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(bits, { level: 1 })), chunk('IEND', Buffer.alloc(0)),
  ])
}

async function launch() {
  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${path.join(os.homedir(), '.terminal-browser')}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  const wsUrl = await new Promise((res, rej) => {
    let err = ''
    chrome.stderr.on('data', d => { err += d; const m = err.match(/DevTools listening on (ws:\S+)/); if (m) res(m[1]) })
    chrome.on('exit', () => rej(new Error('Chrome 실행 실패 (이미 실행 중인 tb가 있는지 확인):\n' + err)))
    chrome.on('error', rej)
  })
  chrome.stderr.removeAllListeners('data').resume()

  const ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let id = 0
  const pending = new Map(), events = {} // events[메서드명] = 핸들러
  ws.onmessage = e => {
    const m = JSON.parse(e.data), p = pending.get(m.id)
    if (m.method) return events[m.method]?.(m.params)
    if (!p) return
    pending.delete(m.id)
    m.error ? p.rej(new Error(m.error.message)) : p.res(m.result)
  }
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    pending.set(++id, { res, rej })
    ws.send(JSON.stringify({ id, method, params, sessionId }))
  })
  const { targetInfos } = await send('Target.getTargets')
  const { sessionId } = await send('Target.attachToTarget', { targetId: targetInfos.find(t => t.type === 'page').targetId, flatten: true })
  const page = (method, params) => send(method, params, sessionId)
  // 헤드리스 표시를 지워 봇 차단을 줄인다
  const { userAgent } = await send('Browser.getVersion')
  await page('Emulation.setUserAgentOverride', { userAgent: userAgent.replace('Headless', '') })
  await page('Page.addScriptToEvaluateOnNewDocument', { source: SAME_TAB })
  return { chrome, ws, page, events }
}

// 페이지 이동과 겹치면 캡처가 응답 없이 멈출 수 있어 시간 제한을 둔다
const capture = page => Promise.race([
  page('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true }).then(r => r.data),
  sleep(2000).then(() => { throw new Error('캡처 시간 초과') }),
])

async function shot(url, file) {
  const { chrome, page } = await launch()
  await page('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: SCALE, mobile: false })
  await page('Page.navigate', { url: toUrl(url) })
  await sleep(3000)
  fs.writeFileSync(file, ditherPng(decodePng(Buffer.from(await capture(page), 'base64'))))
  chrome.kill()
  process.exit(0)
}

async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('터미널에서 실행해야 합니다')
  const { chrome, ws, page, events } = await launch()
  // 캡처 도중에 들어간 마우스 입력은 Chrome이 삼켜 버리므로 캡처와 입력을 한 줄로 세운다
  let chain = Promise.resolve()
  const serial = fn => (chain = chain.then(fn, fn))
  const fire = (method, params) => serial(() => page(method, params).catch(() => {}))
  const out = s => process.stdout.write(s)
  let cols, rows, cellW = CELL?.[0] || 8, cellH = CELL?.[1] || 17
  let last = '', url = '', editing = null // editing: 주소창 입력 중인 문자열
  let dirty = true, lastInput = 0, lastDraw = 0

  const quit = () => process.exit(0)
  process.on('exit', () => { out('\x1b[?1000l\x1b[?1002l\x1b[?1006l\x1b[?7h\x1b[?25h\x1b[?1049l'); chrome.kill() })
  chrome.on('exit', quit)
  ws.onclose = quit

  function bar() {
    const text = editing !== null ? `> ${editing}_` : ` ${url}`
    out(`\x1b[1;1H\x1b[7m${text.padEnd(cols)}\x1b[0m\x1b[${rows};1H\x1b[2m ^L 주소  ^B 뒤로  ^F 앞으로  ^R 새로고침  ^Q 종료\x1b[K\x1b[0m`)
  }
  function resize() {
    cols = process.stdout.columns; rows = process.stdout.rows
    fire('Emulation.setDeviceMetricsOverride', {
      width: Math.round(cols * cellW), height: Math.round((rows - 2) * cellH), deviceScaleFactor: SCALE, mobile: false,
    })
    last = ''
    dirty = true
    out('\x1b[2J')
    bar()
  }

  function onMouse(b, col, row, press) {
    if (row === 1) { if (press) { editing = ''; bar() } return }
    const pos = { x: (col - 0.5) * cellW, y: (row - 1.5) * cellH }
    if (b & 64) return fire('Input.dispatchMouseEvent', { type: 'mouseWheel', ...pos, deltaX: 0, deltaY: (b & 1 ? 1 : -1) * cellH * 3 })
    const button = ['left', 'middle', 'right'][b & 3]
    if (!button) return
    if (b & 32) return fire('Input.dispatchMouseEvent', { type: 'mouseMoved', ...pos, button, buttons: 1 })
    if (press) fire('Input.dispatchMouseEvent', { type: 'mouseMoved', ...pos })
    fire('Input.dispatchMouseEvent', { type: press ? 'mousePressed' : 'mouseReleased', ...pos, button, clickCount: 1 })
  }
  function onKey(t) {
    if (t === '\x11' || t === '\x03') return quit()
    if (editing !== null) {
      if (t === '\r') { if (editing.trim()) fire('Page.navigate', { url: toUrl(editing.trim()) }); editing = null }
      else if (t === '\x1b') editing = null
      else if (t === '\x7f') editing = [...editing].slice(0, -1).join('')
      return bar()
    }
    if (t === '\x0c') { editing = ''; return bar() }
    if (t === '\x02') return fire('Runtime.evaluate', { expression: 'history.back()' })
    if (t === '\x06') return fire('Runtime.evaluate', { expression: 'history.forward()' })
    if (t === '\x12') return fire('Page.reload')
    if (!KEYS[t]) return
    const [key, windowsVirtualKeyCode, text] = KEYS[t], ev = { key, code: key, windowsVirtualKeyCode }
    fire('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', text, ...ev })
    fire('Input.dispatchKeyEvent', { type: 'keyUp', ...ev })
  }
  // ponytail: 글자는 insertText로만 넣는다(한글 OK, keydown 없음). 사이트 단축키가 필요해지면 ASCII는 dispatchKeyEvent로
  function onText(s) {
    if (editing !== null) { editing += s; bar() } else fire('Input.insertText', { text: s })
  }

  process.stdin.setRawMode(true)
  process.stdin.on('data', d => {
    lastInput = Date.now()
    let text = ''
    const flush = () => { if (text) onText(text); text = '' }
    for (const m of d.toString().matchAll(/\x1b\[<(\d+);(\d+);(\d+)([Mm])|\x1b\[4;(\d+);(\d+)t|\x1b\[[\d;]*[A-Za-z~]|\x1b|[^\x1b]/gu)) {
      const t = m[0]
      if (t >= ' ' && t !== '\x7f') { text += t; continue }
      flush()
      if (m[4]) onMouse(+m[1], +m[2], +m[3], m[4] === 'M')
      else if (m[5]) { // 터미널 픽셀 크기 응답 → 글자 칸 크기 보정
        if (!CELL) { cellW = m[6] / cols; cellH = m[5] / rows; resize() }
      } else onKey(t)
    }
    flush()
  })
  process.stdout.on('resize', () => { resize(); out('\x1b[14t') })

  out('\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[?1000h\x1b[?1002h\x1b[?1006h')
  resize()
  out('\x1b[14t')
  // 스크린캐스트는 "화면이 바뀌었다"는 신호로만 쓴다(16px 썸네일). 실제 그림은 바뀐 때만 제 해상도로 캡처
  // 페이지 이동 도중에 시작하면 응답이 오지 않으므로 첫 이동 전에 켠다
  events['Page.screencastFrame'] = ({ sessionId }) => { dirty = true; page('Page.screencastFrameAck', { sessionId }).catch(() => {}) }
  await page('Page.startScreencast', { format: 'jpeg', quality: 1, maxWidth: 16, maxHeight: 16 })
  fire('Page.navigate', { url: toUrl(process.argv[2] || 'naver.com') })

  for (;;) {
    await sleep(80)
    // 조작 직후에는 바로 그리고, 광고처럼 페이지가 혼자 움직이는 건 IDLE_MS마다 한 번만 그린다
    if (!dirty || (Date.now() - lastInput > 1000 && Date.now() - lastDraw < IDLE_MS)) continue
    dirty = false
    lastDraw = Date.now()
    try {
      const [data, hist] = await Promise.all([serial(() => capture(page)), page('Page.getNavigationHistory')])
      const now = hist.entries[hist.currentIndex]?.url ?? ''
      if (now !== url) { url = now; bar() }
      if (data !== last) {
        last = data
        const png = ditherPng(decodePng(Buffer.from(data, 'base64')))
        out(`\x1b[2;1H\x1b]1337;File=inline=1;size=${png.length};width=${cols};height=${rows - 2};preserveAspectRatio=0:${png.toString('base64')}\x07`)
        if (editing !== null) bar()
      }
    } catch { dirty = true } // 페이지 이동 중에는 캡처가 실패할 수 있다 → 다음 틱에 재시도
  }
}

const [, , cmd, a, b] = process.argv
if (require.main === module) (cmd === '--shot' ? shot(a, b) : main()).catch(e => { console.error(e.message); process.exit(1) })
else module.exports = { launch, decodePng, ditherPng }
