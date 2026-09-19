// crayon.js — Procedural Crayon & Offscreen Layer Engine for HTML5 Canvas
// Architecture:
// 1. Shapes are drawn solid on offscreen Canvas Layers.
// 2. Grain is an invariant paper texture mask (destination-in composite), anchored to viewport pixels.
// 3. Multi-layer compositing preserves authentic chalk/crayon texture without texture-sliding artifacts.

const Crayon = (() => {
  const fract = v => v - Math.floor(v)
  const hash = v => fract(Math.sin(v * 127.1 + 311.7) * 43758.5453)
  const hash2 = (x, y) => fract(Math.sin(x * 127.1 + y * 311.7) * 43758.5453)
  const mix = (a, b, t) => a + (b - a) * t
  const smooth = t => t * t * (3 - 2 * t)
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v))

  // 1D value noise with seed stability to prevent stroke boiling
  function noise1(x, seed = 0) {
    const i = Math.floor(x), t = smooth(x - i)
    return mix(hash(i + seed * 57.3), hash(i + 1 + seed * 57.3), t)
  }

  // 2D value noise for flow fields and paper fiber
  function noise2(x, y, seed = 0) {
    const xi = Math.floor(x), yi = Math.floor(y)
    const tx = smooth(x - xi), ty = smooth(y - yi)
    const s = seed * 13.7
    return mix(
      mix(hash2(xi + s, yi), hash2(xi + 1 + s, yi), tx),
      mix(hash2(xi + s, yi + 1), hash2(xi + 1 + s, yi + 1), tx), ty)
  }

  function fbm2(x, y, seed = 0, oct = 3) {
    let v = 0, a = .5, f = 1, n = 0
    for (let i = 0; i < oct; i++) { v += a * noise2(x * f, y * f, seed + i); n += a; a *= .5; f *= 2 }
    return v / n
  }

  // Deterministic PRNG
  function rng(seed) {
    let s = seed >>> 0 || 1
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 }
  }

  // ---------- Paper Tooth & Grain Mask ----------
  function makeGrain(size = 256, strength = .6, seed = 1) {
    const c = document.createElement('canvas'); c.width = c.height = size
    const g = c.getContext('2d')
    const img = g.createImageData(size, size), d = img.data
    const FIELD = 24, cell = 2
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const fx = x / size * FIELD, fy = y / size * FIELD
      const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = smooth(fx - x0), ty = smooth(fy - y0)
      const at = (a, b) => hash2(((a % FIELD) + FIELD) % FIELD + seed * 7, ((b % FIELD) + FIELD) % FIELD)
      const coarse = mix(mix(at(x0, y0), at(x0 + 1, y0), tx), mix(at(x0, y0 + 1), at(x0 + 1, y0 + 1), tx), ty)
      const fine = hash2(Math.floor(x / cell) + seed * 3, Math.floor(y / cell))
      const tooth = coarse * .58 + fine * .42
      const alpha = mix(1, tooth, strength)
      const i = (y * size + x) * 4
      d[i] = d[i + 1] = d[i + 2] = 255; d[i + 3] = Math.round(clamp(alpha, 0, 1) * 255)
    }
    g.putImageData(img, 0, 0)
    return c
  }

  // ---------- Offscreen Layer Architecture ----------
  class Layer {
    constructor(w, h, opts = {}) {
      this.w = w; this.h = h
      this.c = document.createElement('canvas'); this.c.width = w; this.c.height = h
      this.ctx = this.c.getContext('2d')
      this.grainStrength = opts.grain ?? .6
      this.grainSeed = opts.grainSeed ?? 1
      this.blend = opts.blend ?? 'source-over'
      this.alpha = opts.alpha ?? 1
      this.name = opts.name ?? 'layer'
      this.debugColor = opts.debugColor ?? 'rgba(255,0,0,.25)'
      this._grain = null; this._grainKey = ''
    }
    clear() { this.ctx.clearRect(0, 0, this.w, this.h) }
    grain() {
      const key = this.grainStrength.toFixed(2) + ':' + this.grainSeed
      if (this._grainKey !== key) { this._grain = makeGrain(256, this.grainStrength, this.grainSeed); this._grainKey = key }
      return this._grain
    }
    composite(target, opts = {}) {
      const g = this.ctx
      if (this.grainStrength > 0) {
        g.save()
        g.globalCompositeOperation = 'destination-in'
        g.fillStyle = g.createPattern(this.grain(), 'repeat')
        g.fillRect(0, 0, this.w, this.h)
        g.restore()
      }
      target.save()
      target.globalCompositeOperation = opts.blend ?? this.blend
      target.globalAlpha = opts.alpha ?? this.alpha
      target.drawImage(this.c, 0, 0)
      target.restore()
    }
  }

  // ---------- Procedural Strokes & Mark-Making ----------
  function stroke(ctx, pts, o = {}) {
    if (pts.length < 2) return
    const w = o.width ?? 3, color = o.color ?? 'rgb(253,251,244)', alpha = o.alpha ?? .9
    const swellAmt = o.swell ?? 1, seed = o.seed ?? 0, closed = !!o.closed
    const taper = o.taper ?? 0
    ctx.save(); ctx.strokeStyle = color; ctx.lineCap = 'round'; ctx.lineJoin = 'round'
    let t = 0
    const n = pts.length + (closed ? 1 : 0)
    for (let i = 1; i < n; i++) {
      const a = pts[i - 1], b = pts[i % pts.length]
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy)
      const p = seed * 3.1
      let swell = 1 + swellAmt * (Math.sin(t * .055 + p) * .20 + Math.sin(t * .019 + p * 2.3) * .15 + Math.sin(t * .15 + p * .6) * .09)
      if (taper > 0) {
        const u = i / (n - 1)
        const edge = Math.min(u, 1 - u) / .25
        swell *= mix(1, Math.min(1, edge), taper)
      }
      ctx.lineWidth = Math.max(.3, w * swell)
      ctx.globalAlpha = alpha * mix(1, clamp(swell, .55, 1), .6)
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke()
      t += len
    }
    ctx.restore()
  }

  function ringPoints(cx, cy, r, o = {}) {
    const wobble = o.wobble ?? .12, seed = o.seed ?? 0, turns = o.turns ?? 1.12
    const gap = o.gap ?? 0, squash = o.squash ?? 1, drift = o.drift ?? 0
    const start = hash(seed) * Math.PI * 2
    const total = Math.PI * 2 * turns * (1 - gap)
    const steps = Math.max(24, Math.round(r * 1.5 * turns))
    const pts = []
    for (let i = 0; i <= steps; i++) {
      const th = start + total * i / steps
      const loop = (th - start) / (Math.PI * 2)
      const rr = r * (1 + wobble * (noise1(th * 1.4 + loop * 3, seed) - .5) * 2)
      const ox = drift * r * loop, oy = drift * r * loop * .6
      pts.push({ x: cx + ox + Math.cos(th) * rr, y: cy + oy + Math.sin(th) * rr * squash })
    }
    return pts
  }

  function ring(ctx, cx, cy, r, o = {}) {
    stroke(ctx, ringPoints(cx, cy, r, o), { width: o.width ?? Math.max(1.2, r * .12), color: o.color, alpha: o.alpha, seed: o.seed, swell: o.swell ?? 1 })
  }

  function disc(ctx, cx, cy, r, o = {}) {
    const color = o.rgb ?? '238,247,250', alpha = o.alpha ?? .8, soft = o.soft ?? .3
    const sx = o.stretch ?? 1, ang = o.angle ?? 0, seed = o.seed ?? 0
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(ang); ctx.scale(sx, 1)
    if (soft > 0) {
      const grad = ctx.createRadialGradient(0, 0, r * .8, 0, 0, r * (1 + soft))
      grad.addColorStop(0, `rgba(${color},${alpha * .45})`); grad.addColorStop(1, `rgba(${color},0)`)
      ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(0, 0, r * (1 + soft), 0, Math.PI * 2); ctx.fill()
    }
    const pts = ringPoints(0, 0, r * .96, { wobble: .09, turns: 1, seed })
    ctx.fillStyle = `rgba(${color},${alpha})`
    ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath(); ctx.fill()
    ctx.restore()
    if (o.highlight) {
      const hr = r * .55, a0 = -Math.PI * .95, a1 = -Math.PI * .3
      const pts = []
      for (let i = 0; i <= 10; i++) { const a = mix(a0, a1, i / 10); pts.push({ x: cx + Math.cos(a) * hr * sx, y: cy + Math.sin(a) * hr }) }
      stroke(ctx, pts, { width: Math.max(2, r * .26), color: 'rgb(255,255,255)', alpha: o.highlight, seed, taper: 1, swell: .3 })
    }
  }

  function hatch(ctx, x, y, dir, len, o = {}) {
    const bend = o.bend ?? .15, seed = o.seed ?? 0
    const pts = []
    const n = Math.max(3, Math.round(len / 6))
    const perp = dir + Math.PI / 2
    for (let i = 0; i <= n; i++) {
      const u = i / n
      const off = Math.sin(u * Math.PI) * bend * len * (noise1(u * 2 + seed, seed) - .5)
      pts.push({ x: x + Math.cos(dir) * len * u + Math.cos(perp) * off, y: y + Math.sin(dir) * len * u + Math.sin(perp) * off })
    }
    stroke(ctx, pts, { width: o.width ?? 1.6, color: o.color, alpha: o.alpha ?? .7, seed, swell: o.swell ?? 1, taper: o.taper ?? .6 })
  }

  function scumble(ctx, pts, o = {}) {
    stroke(ctx, pts, { width: o.width ?? 24, color: o.color, alpha: o.alpha ?? .18, seed: o.seed, swell: o.swell ?? .6, taper: o.taper ?? .8 })
  }

  // ---------- Refined Collapsible Control Panel ----------
  function panel(schema, onChange = () => {}, opts = {}) {
    const groups = Array.isArray(schema) ? schema : [{ id: 'all', title: '参数', params: schema }]
    const params = {}
    const rows = {}
    const secTitles = {}
    const rowLabels = {}

    const box = document.createElement('div'); box.className = 'cr-panel cr-closed'
    const head = document.createElement('div'); head.className = 'cr-head'
    head.innerHTML = `
      <div class="cr-head-left">
        <span class="cr-icon">🎛️</span>
        <span class="cr-title" data-i18n-key="panelTitle">${opts.title ?? '参数调节'}</span>
      </div>
      <button class="cr-close-btn" title="关闭面板 (C)">✕</button>
    `
    const body = document.createElement('div'); body.className = 'cr-body'
    box.appendChild(head); box.appendChild(body)

    for (const gp of groups) {
      const sec = document.createElement('div'); sec.className = 'cr-sec'
      const sh = document.createElement('div'); sh.className = 'cr-sec-head'
      sh.innerHTML = `<button class="cr-chev">▾</button><span class="cr-sec-title" data-sec-id="${gp.id}">${gp.title}</span>`
      secTitles[gp.id] = sh.querySelector('.cr-sec-title')
      const inner = document.createElement('div'); inner.className = 'cr-sec-body'
      sh.querySelector('.cr-chev').onclick = () => sec.classList.toggle('cr-collapsed')
      sh.querySelector('.cr-sec-title').onclick = () => sec.classList.toggle('cr-collapsed')

      if (gp.toggle) {
        params[gp.toggle] = gp.on !== false
        const sw = document.createElement('span'); sw.className = 'cr-sw'
        sw.innerHTML = `<input type="checkbox" ${params[gp.toggle] ? 'checked' : ''}><span></span>`
        const input = sw.querySelector('input')
        const apply = on => {
          inner.classList.toggle('cr-off', !on)
          inner.querySelectorAll('input,select').forEach(i => { i.disabled = !on })
        }
        input.onchange = e => { params[gp.toggle] = e.target.checked; apply(e.target.checked); onChange(gp.toggle) }
        sh.appendChild(sw); sec.dataset.toggle = gp.toggle; sec._sw = input; sec._apply = apply
      }
      sec.appendChild(sh); sec.appendChild(inner); body.appendChild(sec)

      for (const k in (gp.params || {})) {
        const d = gp.params[k]; params[k] = d.value
        const row = document.createElement('label'); row.className = 'cr-row'
        if (d.type === 'check') {
          row.classList.add('cr-row-check')
          row.innerHTML = `<span class="cr-label" data-param-key="${k}">${d.label}</span><span class="cr-sw"><input type="checkbox" ${d.value ? 'checked' : ''}><span></span></span>`
          row.querySelector('input').onchange = e => { params[k] = e.target.checked; onChange(k) }
        } else {
          row.innerHTML = `<span class="cr-label" data-param-key="${k}">${d.label}</span><b>${d.value}</b>` +
            `<input type="range" min="${d.min}" max="${d.max}" step="${d.step ?? .01}" value="${d.value}">`
          const inp = row.querySelector('input'), val = row.querySelector('b')
          inp.oninput = e => { params[k] = parseFloat(e.target.value); val.textContent = params[k]; onChange(k) }
        }
        inner.appendChild(row); rows[k] = row
        rowLabels[k] = row.querySelector('.cr-label')
      }
      if (gp.toggle) sec._apply(params[gp.toggle])
    }

    // Panel Action Footer
    const footer = document.createElement('div'); footer.className = 'cr-bar'
    if (opts.buttons) {
      for (const [label, fn, btnClass] of opts.buttons) {
        const b = document.createElement('button')
        b.className = 'cr-btn ' + (btnClass ?? '')
        b.textContent = label
        b.onclick = fn
        footer.appendChild(b)
      }
    }
    box.appendChild(footer)
    document.body.appendChild(box)

    const closeBtn = head.querySelector('.cr-close-btn')
    const togglePanel = (force) => {
      const isOpen = box.classList.contains('cr-open')
      const targetState = force !== undefined ? force : !isOpen
      box.classList.toggle('cr-open', targetState)
      box.classList.toggle('cr-closed', !targetState)
      if (opts.onToggle) opts.onToggle(targetState)
    }
    closeBtn.onclick = () => togglePanel(false)

    // Keyboard shortcut C to toggle controls panel
    window.addEventListener('keydown', e => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return
      if (e.key === 'c' || e.key === 'C') togglePanel()
    })

    Object.defineProperty(params, '__sync', { enumerable: false, value: (k, v) => {
      const row = rows[k]
      if (!row) {
        for (const sec of box.querySelectorAll('.cr-sec')) if (sec.dataset.toggle === k && sec._sw) { sec._sw.checked = v; sec._apply(v) }
        return
      }
      const inp = row.querySelector('input'); if (!inp) return
      if (inp.type === 'checkbox') inp.checked = v
      else { inp.value = v; const val = row.querySelector('b'); if (val) val.textContent = v }
    } })

    Object.defineProperty(params, '__togglePanel', { enumerable: false, value: togglePanel })
    Object.defineProperty(params, '__dom', { enumerable: false, value: { box, secTitles, rowLabels, headTitle: head.querySelector('.cr-title'), footer } })

    return params
  }

  const css = `
  body{margin:0;background:#2c3a42;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#123;-webkit-font-smoothing:antialiased;overflow:hidden}
  canvas.stage{display:block;margin:0 auto;touch-action:none;user-select:none;-webkit-user-select:none}
  
  /* Top-Right Action Bar */
  .cr-top-bar{position:fixed;top:22px;right:24px;display:flex;align-items:center;gap:14px;z-index:99}

  /* 80x80 Object Switcher Buttons */
  .cr-obj-btn{width:80px;height:80px;display:inline-flex;align-items:center;justify-content:center;background:transparent;border:none;cursor:pointer;padding:0;position:relative;transition:transform .16s cubic-bezier(.34,1.56,.64,1);user-select:none;-webkit-tap-highlight-color:transparent}
  .cr-obj-thumb{display:block;pointer-events:none;filter:drop-shadow(0 8px 14px rgba(0,0,0,.26)) drop-shadow(0 2px 4px rgba(0,0,0,.16));transition:filter .16s ease,transform .16s ease}
  .cr-thumb-camera{max-width:72px;max-height:72px;object-fit:contain}
  .cr-thumb-crayon{width:64px;height:64px;object-fit:contain;transform:rotate(30deg)}
  .cr-thumb-mask,.cr-thumb-goggle{max-width:76px;max-height:70px;object-fit:contain}
  .cr-obj-btn:hover{transform:translateY(-3px) scale(1.08)}
  .cr-obj-btn:hover .cr-obj-thumb{filter:drop-shadow(0 14px 22px rgba(0,0,0,.34)) drop-shadow(0 4px 8px rgba(0,0,0,.2))}
  .cr-obj-btn:active{transform:translateY(2px) scale(.95)}
  .cr-obj-btn:active .cr-obj-thumb{filter:drop-shadow(0 2px 5px rgba(0,0,0,.28))}

  /* Solid Black Border & Shadow Buttons */
  .cr-solid-btn{display:inline-flex;align-items:center;justify-content:center;height:48px;padding:0 18px;border-radius:12px;background:#fff;color:#000;border:2.5px solid #000;box-shadow:4px 4px 0 #000;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:15px;font-weight:700;cursor:pointer;user-select:none;box-sizing:border-box;transition:transform .08s ease,box-shadow .08s ease,background-color .12s ease;-webkit-tap-highlight-color:transparent}
  .cr-solid-btn:hover{transform:translate(-1px,-1px);box-shadow:5px 5px 0 #000;background:#fafafa}
  .cr-solid-btn:active{transform:translate(4px,4px);box-shadow:0 0 0 #000;background:#f0f0f0}
  .cr-solid-icon-btn{width:48px;padding:0}

  /* Control Panel */
  .cr-panel{position:fixed;top:14px;right:14px;width:318px;max-width:calc(100vw - 28px);max-height:calc(100vh - 28px);overflow:hidden;display:flex;flex-direction:column;background:rgba(252,253,255,.95);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-radius:18px;font-size:13px;box-shadow:0 12px 36px rgba(0,0,0,.35);z-index:100;transition:opacity .2s,transform .2s;border:1px solid rgba(255,255,255,.4)}
  .cr-panel.cr-closed{opacity:0;pointer-events:none;transform:translateX(18px) scale(.97);display:none}
  .cr-panel.cr-open{opacity:1;pointer-events:auto;transform:none;display:flex}
  .cr-head{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid rgba(0,0,0,.07);background:rgba(252,253,255,.98);border-radius:18px 18px 0 0;flex-shrink:0}
  .cr-head-left{display:flex;align-items:center;gap:8px}
  .cr-icon{font-size:16px}
  .cr-title{font-weight:700;font-size:14px;color:#1a2933}
  .cr-close-btn{border:0;background:rgba(0,0,0,.06);width:28px;height:28px;border-radius:50%;font-size:13px;cursor:pointer;color:#455964;display:flex;align-items:center;justify-content:center;transition:background .15s}
  .cr-close-btn:hover{background:rgba(0,0,0,.12);color:#111}
  .cr-body{padding:4px 14px 10px;overflow-y:auto;flex:1}
  
  .cr-sec{border-top:1px solid rgba(0,0,0,.07)}
  .cr-sec-head{display:flex;align-items:center;gap:8px;height:44px;cursor:pointer;user-select:none}
  .cr-sec-title{font-weight:600;flex:1;font-size:13px;color:#243640}
  .cr-chev{border:0;background:none;font-size:12px;color:#5a717d;cursor:pointer;width:18px;height:36px;padding:0;transition:transform .15s}
  .cr-sec.cr-collapsed .cr-sec-body{display:none}
  .cr-sec.cr-collapsed .cr-chev{transform:rotate(-90deg)}
  .cr-sec-body{padding-bottom:8px}
  .cr-sec-body.cr-off{opacity:.35}
  
  .cr-row{display:grid;grid-template-columns:1fr 44px;gap:2px 8px;align-items:center;padding:7px 0 10px}
  .cr-row>span:first-child{color:#2e414c}
  .cr-row b{font-weight:600;text-align:right;font-variant-numeric:tabular-nums;color:#182830}
  .cr-row input[type=range]{grid-column:1 / -1;width:100%;-webkit-appearance:none;appearance:none;height:6px;border-radius:3px;background:#d7e2e8;margin:6px 0 0}
  .cr-row input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:24px;height:24px;border-radius:50%;background:#fff;border:1px solid rgba(0,0,0,.14);box-shadow:0 1px 4px rgba(0,0,0,.25);cursor:pointer}
  .cr-row.cr-row-check{grid-template-columns:1fr auto;padding:5px 0}
  
  .cr-sw{position:relative;display:inline-block;width:48px;height:28px;flex:0 0 auto}
  .cr-sw input{position:absolute;opacity:0;width:100%;height:100%;margin:0;cursor:pointer;z-index:2}
  .cr-sw>span{position:absolute;inset:0;background:#cbd6dc;border-radius:14px;transition:background .18s}
  .cr-sw>span::after{content:'';position:absolute;top:2px;left:2px;width:24px;height:24px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:transform .18s}
  .cr-sw input:checked+span{background:#30b355}
  .cr-sw input:checked+span::after{transform:translateX(20px)}
  .cr-sw input:disabled+span{opacity:.5}

  .cr-bar{padding:10px 14px;background:rgba(252,253,255,.98);border-top:1px solid rgba(0,0,0,.08);display:flex;flex-direction:column;gap:8px;border-radius:0 0 18px 18px;flex-shrink:0}
  .cr-btn{display:flex;align-items:center;justify-content:center;gap:6px;width:100%;font-size:13px;font-weight:600;padding:9px 12px;border-radius:10px;border:1px solid #b7c7d1;background:#fff;cursor:pointer;color:#1c2d36;transition:all .15s;box-sizing:border-box}
  .cr-btn:hover{background:#f4f8fa;border-color:#9eb3bf}
  .cr-btn:active{background:#e7eff3}
  .cr-btn-primary{background:#2a7cb5;border-color:#21699c;color:#fff}
  .cr-btn-primary:hover{background:#328cc9;border-color:#2a7cb5;color:#fff}
  .cr-btn-primary:active{background:#1f6393}

  /* Bottom Instruction & Shortcut Bar */
  .cr-bottom-bar{position:fixed;bottom:24px;left:32px;display:flex;align-items:center;gap:18px;color:#fff;z-index:90;user-select:none;pointer-events:auto}
  .cr-hint-desktop{display:flex;align-items:center;gap:16px;flex-wrap:wrap}
  .cr-hint-mobile{display:none;font-size:13.5px;font-weight:500;letter-spacing:.2px;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.45)}
  .cr-hint-item{display:inline-flex;align-items:center;gap:7px;color:#fff;font-size:14px;font-weight:500;text-shadow:0 1px 3px rgba(0,0,0,.4)}
  .cr-hint-play{display:inline-flex;align-items:center;gap:6px}
  .cr-play-icon{fill:#fff;filter:drop-shadow(0 1px 2px rgba(0,0,0,.4))}
  .cr-badge{display:inline-flex;align-items:center;justify-content:center;padding:3px 9px;border-radius:7px;border:1.5px solid rgba(255,255,255,.9);background:rgba(255,255,255,.12);backdrop-filter:blur(4px);color:#fff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:12.5px;font-weight:600;text-shadow:0 1px 2px rgba(0,0,0,.4);box-shadow:0 2px 5px rgba(0,0,0,.25);box-sizing:border-box}

  /* Mobile Reset Button (Hidden on Desktop) */
  .cr-mobile-reset-btn{display:none}

  /* Status Badge */
  .cr-status-badge{display:none;align-items:center;gap:4px;padding:3px 10px;border-radius:12px;background:#e55353;color:#fff;font-weight:700;font-size:11.5px;letter-spacing:.3px;box-shadow:0 2px 6px rgba(0,0,0,.3)}
  .cr-status-badge.visible{display:inline-flex}

  /* Toast Notification */
  .cr-toast{position:fixed;top:88px;left:50%;transform:translateX(-50%);padding:9px 18px;background:rgba(18,28,36,.88);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);color:#fff;border:1.5px solid rgba(255,255,255,.22);border-radius:22px;font-size:13.5px;font-weight:600;z-index:110;box-shadow:0 8px 24px rgba(0,0,0,.35);opacity:0;transition:opacity .2s,transform .2s;pointer-events:none;white-space:nowrap}
  .cr-toast.show{opacity:1;transform:translateX(-50%) translateY(4px)}

  @media(max-width:640px){
    .cr-top-bar{top:12px;right:12px;gap:8px}
    .cr-obj-btn{width:56px;height:56px}
    .cr-thumb-camera{max-width:50px;max-height:50px}
    .cr-thumb-crayon{width:44px;height:44px;transform:rotate(30deg)}
    .cr-thumb-mask,.cr-thumb-goggle{max-width:54px;max-height:48px}
    .cr-solid-btn{height:40px;padding:0 12px;font-size:13.5px;border-radius:10px;box-shadow:3px 3px 0 #000;border-width:2px}
    .cr-solid-btn:hover{transform:none;box-shadow:3px 3px 0 #000}
    .cr-solid-btn:active{transform:translate(3px,3px);box-shadow:0 0 0 #000}
    .cr-solid-icon-btn{width:40px;padding:0}
    
    .cr-hint-desktop{display:none}
    .cr-hint-mobile{display:flex;align-items:center;justify-content:center;width:100%}
    .cr-mobile-poised{display:none;align-items:center;justify-content:center}
    .cr-mobile-poised.visible{display:flex}
    .cr-mobile-dropped{display:none;align-items:center;justify-content:center;gap:10px;flex-wrap:wrap}
    .cr-mobile-dropped.visible{display:inline-flex}
    .cr-mobile-text{font-size:13.5px;font-weight:500;letter-spacing:.2px;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.5)}
    .cr-mobile-or-text{font-size:13px;font-weight:500;letter-spacing:.2px;color:rgba(255,255,255,.9);text-shadow:0 1px 3px rgba(0,0,0,.5)}
    .cr-mobile-reset-btn{display:inline-flex;align-items:center;justify-content:center;height:38px;padding:0 20px;border-radius:12px;background:rgba(255,255,255,.16);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);color:#fff;border:2px solid #fff;box-shadow:3px 3px 0 #fff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:14px;font-weight:700;letter-spacing:.4px;cursor:pointer;user-select:none;transition:transform .08s ease,box-shadow .08s ease,background-color .12s ease;-webkit-tap-highlight-color:transparent}
    .cr-mobile-reset-btn:hover{background:rgba(255,255,255,.24)}
    .cr-mobile-reset-btn:active{transform:translate(3px,3px);box-shadow:0 0 0 #fff;background:rgba(255,255,255,.36)}
    .cr-bottom-bar{left:50%;transform:translateX(-50%);bottom:20px;width:auto;max-width:92%;justify-content:center;text-align:center}
  }
  `

  function injectCSS() {
    const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s)
  }

  function showToast(msg, dur = 2000) {
    let t = document.querySelector('.cr-toast')
    if (!t) { t = document.createElement('div'); t.className = 'cr-toast'; document.body.appendChild(t) }
    t.textContent = msg
    t.classList.add('show')
    setTimeout(() => t.classList.remove('show'), dur)
  }

  return { hash, noise1, noise2, fbm2, rng, mix, clamp, makeGrain, Layer, stroke, ring, ringPoints, disc, hatch, scumble, panel, injectCSS, showToast }
})()
