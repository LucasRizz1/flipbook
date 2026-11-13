/*
 * flipbook.js — motor de flipbook com dobra de página real.
 *
 * Como funciona (resumo):
 *  - Cada página é um elemento DOM (imagem). Durante a virada, três elementos mudam:
 *      "front"  = frente da folha que está virando  (recortada com clip-path)
 *      "flap"   = verso da folha (rotacionado + recortado: é a "aba" dobrada)
 *      "under"  = página que aparece por baixo
 *  - A dobra é a mediatriz entre o canto original da folha (C) e a posição
 *    atual desse canto (P, que segue o dedo/mouse). A parte da folha do lado de C
 *    é espelhada sobre essa linha — isso é a aba.
 *  - Luz e sombra (sombra projetada, sombra na página revelada, brilho no vinco)
 *    são desenhadas num <canvas> por cima, no mesmo frame.
 *
 * Espaço "folha": x de 0 (lombada) até W (borda externa), y de 0 a H.
 * Espaço "livro": lombada em x = 0; página direita em [0, W], esquerda em [-W, 0].
 */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeSine = (t) => (1 - Math.cos(Math.PI * t)) / 2;
const ink = (a) => `rgba(0,0,0,${clamp(a, 0, 1).toFixed(4)})`;
const glow = (a) => `rgba(255,255,255,${clamp(a, 0, 1).toFixed(4)})`;

/** Recorta um polígono convexo por um semiplano: mantém (q - m)·n * sign >= 0. */
function clipHalf(poly, nx, ny, mx, my, sign) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const ha = ((a[0] - mx) * nx + (a[1] - my) * ny) * sign;
    const hb = ((b[0] - mx) * nx + (b[1] - my) * ny) * sign;
    if (ha >= 0) out.push(a);
    if (ha >= 0 !== hb >= 0) {
      const t = ha / (ha - hb);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

/** Níveis de qualidade das sombras: escala do canvas (teto) e nº de passadas da sombra suave. */
const QUALITY = [
  { scale: 2, steps: 26 },
  { scale: 1.5, steps: 18 },
  { scale: 1, steps: 12 },
];

function tracePoly(path, pts) {
  path.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) path.lineTo(pts[i][0], pts[i][1]);
  path.closePath();
}

export class FlipBook extends EventTarget {
  /**
   * @param {HTMLElement} stage  área onde o livro é desenhado (ocupa a tela)
   * @param {object} meta        manifesto (book.json)
   * @param {object} opts        { base, startPage, flipDuration, maxZoom, insets() }
   */
  constructor(stage, meta, opts = {}) {
    super();
    this.stage = stage;
    this.meta = meta;
    this.N = meta.pages;
    this.pw = meta.pageWidth;
    this.ph = meta.pageHeight;
    this.sizes = meta.sizes.slice().sort((a, b) => a.width - b.width);
    const top = this.sizes[this.sizes.length - 1];
    this.maxRaster = top.vector ? Infinity : top.width;
    // camada vetorial opcional (fundo sem texto + texto em SVG), usada no zoom fundo
    const vec = meta.vector;
    this.vec = vec && vec.bg && vec.text && Array.isArray(vec.pages) && vec.pages.length ? vec : null;
    this.vecPages = new Set(this.vec ? this.vec.pages : []);
    this.o = Object.assign(
      {
        base: '',
        flipDuration: 620,
        maxZoom: meta.maxZoom || (this.vec ? 6 : 4),
        zoomStep: 2,
        forceSingle: false,
        insets: () => ({ top: 60, right: 70, bottom: 64, left: 70 }),
      },
      opts
    );
    this.page = clamp(Math.round(opts.startPage || 1), 1, this.N);
    this.mode = '';
    this.W = 0;
    this.H = 0;
    this.sw = 0;
    this.sh = 0;
    this.z = 1;
    this.tx = 0;
    this.ty = 0;
    this.spineX = 0;
    this.top = 0;
    this.pages = new Map();
    this.flip = null;
    this.ptrs = new Map();
    this.g = null;
    this._raf = 0;
    this._wheelLock = 0;
    this._wheelT = 0;
    this._wheelAcc = 0;
    this._wheelFired = false;
    this._wheelMin = Infinity;
    this._lastTap = null;
    this._inertia = 0;
    this._qTimer = 0;
    this.ql = 0; // nível de qualidade das sombras (ver QUALITY e _judgeFrames)
    this.q = QUALITY[0];
    this._slow = 0;
    this._slowSum = 0;
    this._trial = null;
    this._qLock = false;
    this._idleDt = 0;
    this._idleBusy = false;
    this._tick = this._tick.bind(this);
    this._build();
    this._bind();
    this.layout();
    this._measureIdle();
  }

  /* ------------------------------------------------------------------ */
  /* Estrutura                                                          */
  /* ------------------------------------------------------------------ */

  _build() {
    const mk = (cls, tag = 'div') => {
      const e = document.createElement(tag);
      e.className = cls;
      return e;
    };
    this.zoomEl = mk('fb-zoom');
    this.book = mk('fb-book');
    this.shadow = mk('fb-shadow');
    this.edgeL = mk('fb-edge fb-edge-l');
    this.edgeR = mk('fb-edge fb-edge-r');
    this.ghost = mk('fb-page fb-ghost');
    this.ghostImg = new Image();
    this.ghostImg.alt = '';
    this.ghostImg.draggable = false;
    this.ghost.append(this.ghostImg);
    this.light = mk('fb-light', 'canvas');
    this.lctx = this.light.getContext('2d');
    this.book.append(this.shadow, this.edgeL, this.edgeR, this.ghost, this.light);
    this.zoomEl.append(this.book);
    this.stage.prepend(this.zoomEl);
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /* ------------------------------------------------------------------ */
  /* Modelo: páginas, spreads, índices                                  */
  /* ------------------------------------------------------------------ */

  /** Índice da "vista": nº do spread (modo duplo) ou nº da página (modo simples). */
  get index() {
    return this.mode === 'double' ? Math.floor(this.page / 2) : this.page;
  }
  get minIndex() {
    return this.mode === 'double' ? 0 : 1;
  }
  get maxIndex() {
    return this.mode === 'double' ? Math.floor(this.N / 2) : this.N;
  }
  /** Índice já "decidido" (durante uma virada confirmada, é o destino). */
  get targetIndex() {
    return this.flip && this.flip.committed ? this.flip.toIndex : this.index;
  }

  /** Páginas [esquerda, direita] de um spread (0 = não existe). Capa fica sozinha à direita. */
  spreadPages(k) {
    const l = 2 * k;
    const r = 2 * k + 1;
    return [l >= 1 && l <= this.N ? l : 0, r <= this.N ? r : 0];
  }

  pagesAt(index) {
    if (this.mode === 'double') return this.spreadPages(index).filter(Boolean);
    return [index];
  }

  indexOfPage(p) {
    p = clamp(Math.round(p), 1, this.N);
    return this.mode === 'double' ? Math.floor(p / 2) : p;
  }

  info(index = this.targetIndex) {
    const pages = this.pagesAt(index);
    return {
      index,
      pages,
      label: pages.join('-'),
      total: this.N,
      mode: this.mode,
      first: index <= this.minIndex,
      last: index >= this.maxIndex,
      min: this.minIndex,
      max: this.maxIndex,
    };
  }

  _setIndex(i) {
    if (this.mode === 'double') {
      const [l, r] = this.spreadPages(i);
      this.page = l || r;
    } else {
      this.page = clamp(i, 1, this.N);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Imagens                                                            */
  /* ------------------------------------------------------------------ */

  url(size, n) {
    // "version" muda a cada conversão: evita que o navegador mostre páginas antigas em cache
    const v = this.meta.version ? '?v=' + encodeURIComponent(this.meta.version) : '';
    return this.o.base + size.path.replace('{n}', n) + v;
  }

  thumbUrl(n) {
    return this.url(this.sizes[0], n);
  }

  _pickSize(px) {
    // nunca amplia a imagem (texto rasterizado perde nitidez): pega o primeiro
    // tamanho que cobre os pixels necessários
    for (const s of this.sizes) if (s.vector || s.width >= px * 0.96) return s;
    return this.sizes[this.sizes.length - 1];
  }

  _needPx() {
    return this.W * this.z * Math.min(window.devicePixelRatio || 1, 3);
  }

  _page(n) {
    let p = this.pages.get(n);
    if (p) return p;
    const el = document.createElement('div');
    el.className = 'fb-page ' + this._sideClass(n);
    el.dataset.n = n;
    const img = new Image();
    img.alt = '';
    img.draggable = false;
    el.append(img);
    const links = this.meta.links && this.meta.links[n];
    if (links) {
      for (const l of links) {
        const a = document.createElement('a');
        a.className = 'fb-link';
        if (l.page) {
          // link interno: vai para outra página do próprio livro
          a.href = '#p=' + l.page;
          if (this.o.goToLabel) a.title = this.o.goToLabel(l.page);
        } else {
          a.href = l.url;
          a.target = '_blank';
          a.rel = 'noopener';
          a.title = l.url;
        }
        a.style.cssText = `left:${l.x}%;top:${l.y}%;width:${l.w}%;height:${l.h}%`;
        el.append(a);
      }
    }
    el.style.display = 'none';
    this.book.insertBefore(el, this.ghost);
    p = { n, el, img, have: 0, want: 0, vec: null, vecFailed: false };
    this.pages.set(n, p);
    return p;
  }

  /* ------------------------------------------------------------------ */
  /* Camada vetorial (zoom fundo)                                       */
  /* ------------------------------------------------------------------ */

  /**
   * Quando o zoom pede mais pixels do que a maior imagem tem, cobre a página com
   * duas camadas: o fundo sem texto (imagem) e o texto em SVG — as letras ficam
   * nítidas em qualquer ampliação. Sem zoom e durante as viradas, sai de cena
   * (desenhar milhares de letras vetoriais a cada quadro pesaria na animação).
   */
  _syncVector() {
    const on = !!this.vec && !this.flip && this.z > 1.001 && this._needPx() > this.maxRaster * 1.02;
    const vis = on ? this.pagesAt(this.index) : [];
    for (const [n, p] of this.pages) {
      if (vis.includes(n) && this.vecPages.has(n) && !p.vecFailed) this._addVector(p);
      else this._dropVector(p);
    }
  }

  _addVector(p) {
    if (p.vec) return;
    const q = this.meta.version ? '?v=' + encodeURIComponent(this.meta.version) : '';
    const mk = (cls, path) => {
      const im = new Image();
      im.alt = '';
      im.draggable = false;
      im.className = cls;
      im.src = this.o.base + path.replace('{n}', p.n) + q;
      return im;
    };
    const layer = (p.vec = { bg: mk('fb-vbg', this.vec.bg), tx: mk('fb-vtx', this.vec.text) });
    const loaded = (im) =>
      new Promise((ok, fail) => {
        im.onload = ok;
        im.onerror = fail;
      });
    Promise.all([loaded(layer.bg), loaded(layer.tx)]).then(
      () => {
        // só entra em cena com as duas partes prontas (senão o texto sumiria por um instante)
        if (p.vec !== layer || !this.pages.has(p.n)) return;
        p.img.after(layer.bg, layer.tx);
      },
      () => {
        if (p.vec === layer) p.vec = null;
        p.vecFailed = true; // fica com a imagem normal
      }
    );
  }

  _dropVector(p) {
    if (!p.vec) return;
    p.vec.bg.remove();
    p.vec.tx.remove();
    p.vec = null;
  }

  _sideClass(n) {
    return this.mode === 'double' && n % 2 === 0 ? 'fb-l' : 'fb-r';
  }

  /** Garante que a página n tenha imagem com pelo menos `px` de largura. */
  _ensureImage(n, px) {
    if (n < 1 || n > this.N) return;
    const p = this._page(n);
    const size = this._pickSize(px);
    const w = size.vector ? Infinity : size.width;
    if (p.have >= w || p.want >= w) return;
    p.want = w;
    const img = new Image();
    img.alt = '';
    img.draggable = false;
    img.decoding = 'async';
    const done = () => {
      if (p.have >= w || this.pages.get(n) !== p) return;
      p.have = w;
      p.tries = 0;
      p.img.replaceWith(img);
      p.img = img;
      p.el.classList.add('fb-has');
      this._emit('pageimage', { n });
    };
    const fail = () => {
      if (p.want === w) p.want = p.have;
      // conexão caiu? tenta de novo (até 3 vezes) enquanto a página estiver à vista
      const shown = () => this.pages.get(n) === p && p.el.style.display !== 'none';
      if (shown() && !p.retry && (p.tries = (p.tries || 0) + 1) <= 3) {
        p.retry = setTimeout(() => {
          p.retry = 0;
          if (shown()) this._loadFor(n);
        }, 1500 * p.tries);
      }
    };
    img.onload = done;
    img.onerror = fail;
    img.src = this.url(size, n);
    if (img.decode) img.decode().then(done, () => {});
  }

  _loadFor(n) {
    if (!n) return;
    this._ensureImage(n, 1); // miniatura primeiro: aparece quase na hora
    this._ensureImage(n, this._needPx());
  }

  _preloadAround() {
    const base = this.W * Math.min(window.devicePixelRatio || 1, 3);
    const c = this.page;
    for (let d = 1; d <= 4; d++) {
      this._ensureImage(c + d, base);
      this._ensureImage(c - d + (this.mode === 'double' ? 1 : 0), base);
    }
    // libera páginas distantes
    for (const [n, p] of this.pages) {
      if (Math.abs(n - c) > 8) {
        this._dropVector(p);
        p.el.remove();
        this.pages.delete(n);
      }
    }
  }

  _refreshQuality() {
    clearTimeout(this._qTimer);
    this._qTimer = setTimeout(() => {
      const need = this._needPx();
      for (const n of this.pagesAt(this.index)) this._ensureImage(n, need);
      this._syncVector();
    }, 180);
  }

  /* ------------------------------------------------------------------ */
  /* Layout                                                             */
  /* ------------------------------------------------------------------ */

  layout() {
    this._settle();
    // tamanho "de layout" (clientWidth/Height): não é afetado por transform no palco,
    // como a leve escala da animação de entrada
    const w = this.stage.clientWidth;
    const h = this.stage.clientHeight;
    if (!w || !h) return;
    this.rect = this.stage.getBoundingClientRect(); // só para converter posições do ponteiro
    this.sw = w;
    this.sh = h;
    const ins = (this.ins = this.o.insets(this.sw, this.sh));
    const aw = Math.max(60, this.sw - ins.left - ins.right);
    const ah = Math.max(60, this.sh - ins.top - ins.bottom);
    const s2 = Math.min(aw / (2 * this.pw), ah / this.ph);
    const s1 = Math.min(aw / this.pw, ah / this.ph);
    const mode = this.o.forceSingle || this.N < 2 || s1 > s2 * 1.3 ? 'single' : 'double';
    const s = mode === 'single' ? s1 : s2;
    const modeChanged = mode !== this.mode;
    this.mode = mode;
    this.W = Math.max(24, Math.floor(this.pw * s));
    this.H = Math.max(24, Math.round((this.W * this.ph) / this.pw));
    this.cx = ins.left + aw / 2;
    this.top = Math.round(ins.top + ah / 2 - this.H / 2);
    this.book.style.setProperty('--fb-w', this.W + 'px');
    this.book.style.setProperty('--fb-h', this.H + 'px');
    this.stage.dataset.mode = mode;
    if (modeChanged) for (const [n, p] of this.pages) p.el.className = 'fb-page ' + this._sideClass(n) + (p.have ? ' fb-has' : '');

    // limite esquerdo da aba no modo de página única (ver _renderFlip)
    const gap = this.cx - this.W / 2;
    this.flapMinX = mode === 'single' ? (gap <= 48 ? -(gap + 4) : 0) : -1e6;
    this._sizeLight();

    this._stopInertia();
    this.z = 1;
    this.tx = 0;
    this.ty = 0;
    this.stage.classList.remove('fb-zoomed', 'fb-grabbing');
    this._applyView(false);
    this._syncVector();
    this._renderRest();
    this._preloadAround();
    this._emit('layout', this.info());
    this._emit('zoom', { z: 1 });
  }

  /**
   * Dimensiona o canvas de luz (sombras e brilho): cobre o livro mais uma margem
   * para a aba que "sai" da página. A resolução segue o nível de qualidade atual.
   */
  _sizeLight() {
    const { W, H } = this;
    const mx = Math.ceil(W * 0.06 + 30);
    // a ponta da aba pode subir até (diagonal - altura) acima da página; em páginas
    // deitadas isso é bem mais que os 27% que bastam para o A4 em pé
    const my = Math.ceil(Math.max(H * 0.27, Math.hypot(W, H) - H + W * 0.07) + 30);
    // na página única a aba é cortada em flapMinX: não há o que desenhar além disso
    const left = (this.mode === 'single' ? Math.max(-W, this.flapMinX) : -W) - mx;
    const cw = W + mx - left;
    const ch = H + 2 * my;
    let k = Math.min(window.devicePixelRatio || 1, this.q.scale);
    const maxPx = 3.2e6;
    if (cw * ch * k * k > maxPx) k = Math.sqrt(maxPx / (cw * ch));
    this.light.width = Math.round(cw * k);
    this.light.height = Math.round(ch * k);
    this.light.style.cssText = `left:${left}px;top:${-my}px;width:${cw}px;height:${ch}px;visibility:hidden`;
    this.lk = this.light.width / cw;
    this.lox = -left;
    this.loy = my;
  }

  /**
   * Mede o ritmo normal de quadros deste aparelho quando nada está animando
   * (60, 90, 120 Hz... ou 30 com o modo de economia de energia ligado).
   * É a régua do regulador de qualidade: sem ela, um teto de 30 qps pareceria "lentidão".
   */
  _measureIdle() {
    if (document.hidden || this._idleBusy) return;
    this._idleBusy = true;
    const d = [];
    let last = 0;
    const step = (t) => {
      if (this.flip || document.hidden) {
        this._idleBusy = false; // amostra contaminada: fica com a medida anterior
        return;
      }
      if (last) d.push(t - last);
      last = t;
      if (d.length < 24) {
        requestAnimationFrame(step);
        return;
      }
      d.sort((a, b) => a - b);
      this._idleDt = d[Math.floor(d.length * 0.3)];
      this._idleBusy = false;
    };
    requestAnimationFrame(step);
  }

  /**
   * Regulador de qualidade: se as viradas estiverem perdendo quadros neste aparelho,
   * reduz a resolução e o nº de passadas das sombras (quase não se nota na imagem).
   * Depois confere se adiantou: se o ritmo não melhorar, o gargalo não eram as sombras —
   * volta à qualidade anterior e não mexe mais.
   */
  _judgeFrames(dts) {
    if (dts.length < 14 || this._qLock) return;
    const sorted = dts.slice().sort((a, b) => a - b);
    const ref = Math.max(4, this._idleDt || sorted[Math.floor(sorted.length * 0.2)]); // ritmo normal
    const avg = dts.reduce((a, b) => a + b, 0) / dts.length;
    const excess = avg / ref - 1; // 0 = nenhum quadro perdido; 0.2 = 1 em cada 5 perdido

    const t = this._trial;
    if (t) {
      t.sum += excess;
      if (++t.n < 2) return;
      this._trial = null;
      if (t.sum / t.n > t.before * 0.7) {
        this.ql = t.from;
        this.q = QUALITY[this.ql];
        this._sizeLight();
        this._qLock = true;
      }
      return;
    }

    if (excess > 0.12) {
      this._slow++;
      this._slowSum += excess;
    } else {
      this._slow = 0;
      this._slowSum = 0;
    }
    if (this._slow >= 2 && this.ql < QUALITY.length - 1) {
      this._trial = { from: this.ql, before: this._slowSum / this._slow, n: 0, sum: 0 };
      this._slow = 0;
      this._slowSum = 0;
      this.ql++;
      this.q = QUALITY[this.ql];
      this._sizeLight();
    }
  }

  _spineAt(index) {
    if (this.mode === 'single') return this.cx - this.W / 2;
    const [l, r] = this.spreadPages(index);
    return l && r ? this.cx : r ? this.cx - this.W / 2 : this.cx + this.W / 2;
  }

  /** Área ocupada pelas páginas (em coordenadas do livro). */
  _footprint(index) {
    if (this.mode === 'single') return { x0: 0, x1: this.W };
    const [l, r] = this.spreadPages(index);
    return { x0: l ? -this.W : 0, x1: r ? this.W : 0 };
  }

  _applyBook() {
    this.book.style.transform = `translate3d(${this.spineX}px,${this.top}px,0)`;
  }

  _place(p, side, z) {
    const st = p.el.style;
    st.display = 'block';
    st.zIndex = z;
    st.clipPath = '';
    st.opacity = '';
    st.transform = side < 0 ? `translate(${-this.W}px,0)` : 'translate(0,0)';
  }

  _renderRest() {
    const keep = new Set();
    if (this.mode === 'double') {
      const [l, r] = this.spreadPages(this.index);
      if (l) {
        this._place(this._page(l), -1, 1);
        keep.add(l);
      }
      if (r) {
        this._place(this._page(r), 1, 1);
        keep.add(r);
      }
    } else {
      this._place(this._page(this.page), 1, 1);
      keep.add(this.page);
    }
    for (const [n, p] of this.pages) if (!keep.has(n)) p.el.style.display = 'none';
    for (const n of keep) this._loadFor(n);
    this.ghost.style.display = 'none';
    this.spineX = Math.round(this._spineAt(this.index));
    this._applyBook();
    this._decor(this.index);
    this._clearLight();
  }

  /** Sombra do livro e "espessura" (pilha de folhas) nas bordas. */
  _decor(index) {
    const { W, H } = this;
    const fp = this._footprint(index);
    const st = this.shadow.style;
    st.left = fp.x0 + 'px';
    st.width = fp.x1 - fp.x0 + 'px';
    st.height = H + 'px';
    this.shadow.classList.remove('fb-off');
    const dbl = this.mode === 'double';
    const right = dbl ? this.maxIndex - index : this.N - index;
    const left = dbl ? index : 0;
    const per = dbl ? 0.5 : 0.25;
    const wr = fp.x1 > 0 ? Math.min(10, Math.round(right * per)) : 0;
    const wl = fp.x0 < 0 ? Math.min(10, Math.round(left * per)) : 0;
    this.edgeR.style.cssText = `left:${W}px;width:${wr}px;height:${H}px;display:${wr ? 'block' : 'none'}`;
    this.edgeL.style.cssText = `left:${-W - wl}px;width:${wl}px;height:${H}px;display:${wl ? 'block' : 'none'}`;
  }

  /* ------------------------------------------------------------------ */
  /* Geometria da dobra                                                 */
  /* ------------------------------------------------------------------ */

  /**
   * Dado o canto (W, cy) arrastado até (px, py), calcula a dobra.
   * Restrições físicas: a folha está presa na lombada, então o canto não pode
   * se afastar mais que W do pé da lombada nem mais que a diagonal do topo.
   */
  _fold(px, py, cy) {
    const W = this.W;
    const H = this.H;
    const D = Math.hypot(W, H);
    const oy = H - cy;
    let x = px;
    let y = py;
    for (let i = 0; i < 3; i++) {
      let d = Math.hypot(x, y - cy);
      if (d > W) {
        x *= W / d;
        y = cy + ((y - cy) * W) / d;
      }
      d = Math.hypot(x, y - oy);
      if (d > D) {
        x *= D / d;
        y = oy + ((y - oy) * D) / d;
      }
    }
    const vx = x - W;
    const vy = y - cy;
    const len = Math.hypot(vx, vy);
    if (len < 0.75) return null;
    const nx = vx / len;
    const ny = vy / len;
    const mx = (W + x) / 2;
    const my = (cy + y) / 2;
    const rect = [
      [0, 0],
      [W, 0],
      [W, H],
      [0, H],
    ];
    const stay = clipHalf(rect, nx, ny, mx, my, 1);
    const lift = clipHalf(rect, nx, ny, mx, my, -1);
    const mn = mx * nx + my * ny;
    let fw = 0;
    const flap = lift.map(([qx, qy]) => {
      const h = qx * nx + qy * ny - mn;
      if (-h > fw) fw = -h;
      return [qx - 2 * h * nx, qy - 2 * h * ny];
    });
    return {
      x,
      y,
      nx,
      ny,
      mx,
      my,
      mn,
      stay,
      lift,
      flap,
      fw,
      c2: 1 - 2 * nx * nx,
      s2: -2 * nx * ny,
      kx: 2 * mn * nx,
      ky: 2 * mn * ny,
    };
  }

  _polyCss(pts, mirror) {
    const W = this.W;
    let s = 'polygon(';
    for (let i = 0; i < pts.length; i++) {
      const x = mirror ? W - pts[i][0] : pts[i][0];
      s += (i ? ',' : '') + x.toFixed(2) + 'px ' + pts[i][1].toFixed(2) + 'px';
    }
    return s + ')';
  }

  /* ------------------------------------------------------------------ */
  /* Virada: estado                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * Monta o plano de uma virada.
   *  s        lado da folha em repouso (+1 direita, -1 esquerda)
   *  front    página na frente da folha;  back = verso (0 = verso em branco, modo simples)
   *  under    página revelada por baixo;  still = página parada do outro lado
   *  reverse  a folha começa virada e volta (voltar página no modo simples)
   */
  _plan(dir, toIndex) {
    const from = this.index;
    if (toIndex == null) toIndex = from + dir;
    if (toIndex < this.minIndex || toIndex > this.maxIndex || toIndex === from) return null;
    if (this.mode === 'double') {
      const [la, ra] = this.spreadPages(from);
      const [lb, rb] = this.spreadPages(toIndex);
      return dir > 0
        ? { s: 1, front: ra, back: lb, under: rb, still: la, reverse: false, toIndex, fromIndex: from }
        : { s: -1, front: la, back: rb, under: lb, still: ra, reverse: false, toIndex, fromIndex: from };
    }
    return dir > 0
      ? { s: 1, front: from, back: 0, under: toIndex, still: 0, reverse: false, toIndex, fromIndex: from }
      : { s: 1, front: toIndex, back: 0, under: from, still: 0, reverse: true, toIndex, fromIndex: from };
  }

  _startFlip(plan, cy, mode) {
    const { W } = this;
    const f = (this.flip = Object.assign({}, plan, {
      cy,
      mode,
      P: { x: plan.reverse ? -W : W, y: cy },
      T: null,
      anim: null,
      tau: 42,
      last: 0,
      committed: false,
      spine0: this._spineAt(plan.fromIndex),
      spine1: this._spineAt(plan.toIndex),
    }));
    const keep = new Set([f.front, f.back, f.under, f.still]);
    for (const [n, p] of this.pages) {
      this._dropVector(p);
      if (!keep.has(n)) p.el.style.display = 'none';
    }
    if (f.still) this._place(this._page(f.still), -f.s, 1);
    if (f.under) this._place(this._page(f.under), f.s, 1);
    this._place(this._page(f.front), f.s, 2);
    if (f.back) {
      const b = this._page(f.back).el.style;
      b.zIndex = 3;
      b.display = 'none';
    } else {
      this.ghostImg.src = this._page(f.front).img.src || this.thumbUrl(f.front);
    }
    for (const n of keep) this._loadFor(n);
    if (f.spine0 !== f.spine1) this.shadow.classList.add('fb-off');
    this.stage.classList.add('fb-flipping');
    this._renderFlip();
    this._schedule();
    return f;
  }

  _commit(f) {
    if (f.committed) return;
    f.committed = true;
    this._emit('flip', { dir: f.toIndex > f.fromIndex ? 1 : -1 });
    this._emit('change', this.info(f.toIndex));
  }

  _finishFlip(completed) {
    const f = this.flip;
    if (!f) return;
    this.flip = null;
    cancelAnimationFrame(this._raf);
    this._raf = 0;
    if (completed) {
      if (!f.committed) this._commit(f);
      this._setIndex(f.toIndex);
    }
    this.stage.classList.remove('fb-flipping', 'fb-peeling');
    this._renderRest();
    this._preloadAround();
    if (completed && f.dts && !document.hidden) this._judgeFrames(f.dts);
    // com zoom ativo, a área do livro pode ter mudado (capa ↔ página dupla)
    if (this.z > 1.001) {
      this.setView(this.z, this.tx, this.ty, true);
      this._refreshQuality();
    }
    this._emit('rest', this.info());
  }

  /** Retângulo ocupado pelo livro na tela (sem zoom), para posicionar a interface. */
  bounds(index = this.targetIndex) {
    const fp = this._footprint(index);
    const sp = Math.round(this._spineAt(index));
    return { x0: sp + fp.x0, x1: sp + fp.x1, y0: this.top, y1: this.top + this.H };
  }

  /** Encerra na hora qualquer virada em andamento (confirma se já estava decidida). */
  _settle() {
    if (this.flip) this._finishFlip(!!this.flip.committed);
  }

  _schedule() {
    if (!this._raf) this._raf = requestAnimationFrame(this._tick);
  }

  _tick(now) {
    this._raf = 0;
    const f = this.flip;
    if (!f) return;
    const dt = f.last ? Math.min(64, now - f.last) : 16;
    if (f.last && f.anim && f.committed) (f.dts || (f.dts = [])).push(now - f.last);
    f.last = now;
    if (f.anim) {
      const a = f.anim;
      if (!a.t0) a.t0 = now;
      const t = clamp((now - a.t0) / a.dur, 0, 1);
      const p = a.path(a.ease(t));
      f.P.x = p.x;
      f.P.y = p.y;
      if (t >= 1) {
        f.anim = null;
        if (a.done) {
          a.done();
          if (this.flip !== f) return;
        }
      }
    } else if (f.T) {
      const k = 1 - Math.exp(-dt / f.tau);
      f.P.x += (f.T.x - f.P.x) * k;
      f.P.y += (f.T.y - f.P.y) * k;
    }
    this._renderFlip();
    if (f.anim || (f.T && Math.hypot(f.T.x - f.P.x, f.T.y - f.P.y) > 0.05)) this._schedule();
    else f.last = 0;
  }

  /* ------------------------------------------------------------------ */
  /* Virada: desenho                                                    */
  /* ------------------------------------------------------------------ */

  _renderFlip() {
    const f = this.flip;
    if (!f) return;
    const W = this.W;
    const geo = this._fold(f.P.x, f.P.y, f.cy);
    const prog = clamp((W - (geo ? geo.x : f.P.x)) / (2 * W), 0, 1);
    f.prog = prog;

    if (f.spine0 !== f.spine1) {
      this.spineX = lerp(f.spine0, f.spine1, smooth(0, 1, prog));
      this._applyBook();
    }

    const front = this._page(f.front).el;
    const flap = f.back ? this._page(f.back).el : this.ghost;
    if (!geo) {
      front.style.clipPath = '';
      front.style.display = 'block';
      flap.style.display = 'none';
      this._clearLight();
      return;
    }

    if (geo.stay.length >= 3) {
      front.style.display = 'block';
      front.style.clipPath = this._polyCss(geo.stay, f.s < 0);
    } else {
      front.style.display = 'none';
    }

    // modo de página única: do "lado de lá" da lombada não existe página —
    // a aba some ao cruzar o limite (no celular, esse limite é a borda da tela)
    if (!f.back && geo.lift.length >= 3) {
      const cut = clipHalf(geo.flap, 1, 0, this.flapMinX, 0, 1);
      geo.flap = cut;
      geo.lift = cut.map(([qx, qy]) => {
        const h = qx * geo.nx + qy * geo.ny - geo.mn;
        return [qx - 2 * h * geo.nx, qy - 2 * h * geo.ny];
      });
      geo.clipX = this.flapMinX;
    }

    if (geo.lift.length >= 3) {
      const { c2, s2, kx, ky } = geo;
      const m =
        f.s > 0
          ? [-c2, -s2, s2, -c2, W * c2 + kx, W * s2 + ky]
          : [-c2, s2, -s2, -c2, -kx, ky];
      const st = flap.style;
      st.display = 'block';
      st.zIndex = 3;
      st.transform = `matrix(${m[0].toFixed(6)},${m[1].toFixed(6)},${m[2].toFixed(6)},${m[3].toFixed(6)},${m[4].toFixed(2)},${m[5].toFixed(2)})`;
      st.clipPath = this._polyCss(geo.lift, f.s > 0);
    } else {
      flap.style.display = 'none';
    }
    this._drawLight(geo, f, prog);
  }

  _clearLight() {
    this.lctx.setTransform(1, 0, 0, 1, 0, 0);
    this.lctx.clearRect(0, 0, this.light.width, this.light.height);
    this.light.style.visibility = 'hidden';
  }

  _drawLight(geo, f, prog) {
    const ctx = this.lctx;
    const { W, H, lk } = this;
    this.light.style.visibility = 'visible';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.light.width, this.light.height);
    ctx.setTransform(lk, 0, 0, lk, this.lox * lk, this.loy * lk);

    const s = f.s;
    const toBook = (pts) => pts.map((p) => [s * p[0], p[1]]);
    const flap = toBook(geo.flap);
    const nx = s * geo.nx;
    const ny = geo.ny;
    const mx = s * geo.mx;
    const my = geo.my;
    const fw = Math.max(geo.fw, 1);
    const arc = Math.sin(Math.PI * prog); // 0 → 1 → 0: "altura" da folha no ar
    const fade = smooth(0, 0.035, prog) * (1 - smooth(0.9, 1, prog));
    if (fade <= 0.001) return;
    const u = W / 450; // escala das medidas em px
    const BIG = 4 * (W + H);

    ctx.save();
    if (geo.clipX != null) {
      ctx.beginPath();
      ctx.rect(geo.clipX, -BIG, 2 * BIG, 2 * BIG);
      ctx.clip();
    }

    const flapPath = new Path2D();
    if (flap.length >= 3) tracePoly(flapPath, flap);

    // 1) sombra sobre a página revelada, encostada no vinco
    //    (usa a área original da folha levantada — não a aba já recortada)
    const bare = toBook(clipHalf([[0, 0], [W, 0], [W, H], [0, H]], geo.nx, geo.ny, geo.mx, geo.my, -1));
    if (f.under && bare.length >= 3) {
      const lift = bare;
      const reach = Math.max(8, Math.min(fw * 1.1, W * (0.1 + 0.42 * arc)));
      const a = (0.2 + 0.24 * arc) * fade;
      const g = ctx.createLinearGradient(mx, my, mx - nx * reach, my - ny * reach);
      g.addColorStop(0, ink(a));
      g.addColorStop(0.12, ink(a * 0.62));
      g.addColorStop(0.4, ink(a * 0.22));
      g.addColorStop(1, ink(0));
      ctx.save();
      const p = new Path2D();
      tracePoly(p, lift);
      ctx.clip(p);
      ctx.fillStyle = g;
      ctx.fillRect(-BIG, -BIG, 2 * BIG, 2 * BIG);
      ctx.restore();
    }

    // 2) sombra projetada da aba (só do lado de fora dela)
    //    (contornos sobrepostos, cada um um pouco mais largo: dá um degradê suave
    //     em qualquer navegador, sem depender de filtros de desfoque)
    if (flap.length >= 3) {
      const R = (4 + 24 * arc) * u;
      const A = (0.13 + 0.15 * arc) * fade;
      const steps = this.q.steps;
      const a = 1 - Math.pow(1 - A, 1 / steps);
      ctx.save();
      const outside = new Path2D();
      outside.rect(-BIG, -BIG, 2 * BIG, 2 * BIG);
      outside.addPath(flapPath);
      ctx.clip(outside, 'evenodd');
      ctx.lineJoin = 'round';
      ctx.strokeStyle = ink(a);
      for (let i = 1; i <= steps; i++) {
        ctx.lineWidth = 2 * R * Math.pow(i / steps, 1.75);
        ctx.stroke(flapPath);
      }
      ctx.restore();
    }

    // 3) luz na própria aba: vinco escuro → brilho → meia-sombra larga
    if (flap.length >= 3) {
      const d1 = Math.min(fw * 0.08, 7 * u);
      const d2 = Math.min(fw * 0.26, 26 * u);
      const d3 = Math.min(fw * 0.62, 92 * u);
      const g = ctx.createLinearGradient(mx, my, mx + nx * fw, my + ny * fw);
      g.addColorStop(0, ink(0.3 * fade));
      g.addColorStop(d1 / fw, ink(0.07 * fade));
      g.addColorStop(d2 / fw, glow((0.16 + 0.2 * arc) * fade));
      g.addColorStop(d3 / fw, glow(0));
      g.addColorStop(1, ink(0.1 * arc * fade));
      ctx.save();
      ctx.clip(flapPath);
      ctx.fillStyle = g;
      ctx.fillRect(-BIG, -BIG, 2 * BIG, 2 * BIG);
      // fio de luz na borda livre do papel
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = glow(0.22 * fade);
      ctx.stroke(flapPath);
      ctx.restore();
    }
    ctx.restore();
  }

  /* ------------------------------------------------------------------ */
  /* API pública de navegação                                           */
  /* ------------------------------------------------------------------ */

  next(corner) {
    return this._auto(1, null, corner);
  }
  prev(corner) {
    return this._auto(-1, null, corner);
  }
  first() {
    return this.goToPage(1);
  }
  last() {
    return this.goToPage(this.N);
  }

  goToPage(p, animate = true) {
    this._settle();
    const idx = this.indexOfPage(p);
    if (idx === this.index) return false;
    if (!animate) {
      this._setIndex(idx);
      this._renderRest();
      this._preloadAround();
      this._emit('change', this.info());
      this._emit('rest', this.info());
      return true;
    }
    return this._auto(idx > this.index ? 1 : -1, idx);
  }

  _auto(dir, toIndex, corner) {
    this._settle();
    const plan = this._plan(dir, toIndex);
    if (!plan) return false;
    const { W, H } = this;
    const cy = corner === 'top' ? 0 : H;
    const f = this._startFlip(plan, cy, 'auto');
    const up = cy === 0 ? 1 : -1;
    const rev = plan.reverse;
    // Trajetória do canto: atravessa de W até -W enquanto sobe e volta a descer.
    // O levantamento p·(1-p)² faz a dobra começar bem diagonal (como quem pega a
    // página pela ponta) e terminar reta, pousando sem tranco.
    f.anim = {
      t0: 0,
      dur: this.o.flipDuration,
      ease: easeSine,
      path: (e) => {
        const p = rev ? 1 - e : e;
        return { x: W * (1 - 2 * p), y: cy + up * W * 1.3 * p * (1 - p) * (1 - p) };
      },
      done: () => this._finishFlip(true),
    };
    this._commit(f);
    return true;
  }

  /** Solta a folha: completa a virada ou volta ao lugar. */
  _release(f, complete) {
    const { W } = this;
    f.T = null;
    f.mode = 'auto';
    const toFar = f.reverse ? !complete : complete;
    const end = { x: toFar ? -W : W, y: f.cy };
    const p0 = { x: f.P.x, y: f.P.y };
    const dist = Math.hypot(end.x - p0.x, end.y - p0.y);
    f.anim = {
      t0: 0,
      dur: clamp(this.o.flipDuration * (dist / (2 * W)) * 1.2, 170, this.o.flipDuration),
      ease: easeOut,
      path: (t) => ({ x: lerp(p0.x, end.x, t), y: lerp(p0.y, end.y, t) }),
      done: () => this._finishFlip(complete),
    };
    if (complete) this._commit(f);
    this._schedule();
  }

  /** Levanta o cantinho por um instante, como dica de que dá para virar. */
  hint() {
    if (this.flip || this.z > 1.01 || this.g) return;
    const plan = this._plan(1);
    if (!plan) return;
    const { W, H } = this;
    const f = this._startFlip(plan, H, 'hint');
    const peak = { x: W - W * 0.2, y: H - W * 0.14 };
    f.anim = {
      t0: 0,
      dur: 1500,
      ease: (t) => t,
      path: (t) => {
        const k = t < 0.3 ? easeOut(t / 0.3) : t < 0.62 ? 1 : 1 - easeInOut((t - 0.62) / 0.38);
        return { x: lerp(W, peak.x, k), y: lerp(H, peak.y, k) };
      },
      done: () => this._finishFlip(false),
    };
  }

  /** Pose estática de meia-virada (para inspeção visual / testes). */
  debugPose(dir, x, y, corner) {
    this._settle();
    const plan = this._plan(dir);
    if (!plan) return false;
    const f = this._startFlip(plan, corner === 'top' ? 0 : this.H, 'debug');
    f.P.x = x * this.W;
    f.P.y = y * this.H;
    cancelAnimationFrame(this._raf);
    this._raf = 0;
    this._renderFlip();
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* Zoom e deslocamento                                                */
  /* ------------------------------------------------------------------ */

  _applyView(animate) {
    const st = this.zoomEl.style;
    st.transition = animate ? 'transform 520ms cubic-bezier(.2,.6,.35,1)' : 'none';
    st.willChange = animate ? 'transform' : '';
    st.transform = this.z === 1 && !this.tx && !this.ty ? '' : `translate3d(${this.tx.toFixed(2)}px,${this.ty.toFixed(2)}px,0) scale(${this.z.toFixed(4)})`;
    if (animate) {
      clearTimeout(this._wcTimer);
      this._wcTimer = setTimeout(() => {
        st.willChange = '';
        st.transition = 'none';
      }, 560);
    }
  }

  _clampView(z, tx, ty, slack = 0) {
    const fp = this._footprint(this.targetIndex);
    const sp = this._spineAt(this.targetIndex);
    const x0 = (sp + fp.x0) * z;
    const x1 = (sp + fp.x1) * z;
    const y0 = this.top * z;
    const y1 = (this.top + this.H) * z;
    const ax0 = 0;
    const ax1 = this.sw;
    const ay0 = this.ins.top - 8;
    const ay1 = this.sh - this.ins.bottom + 8;
    const fit = (lo, hi, a0, a1, t) => {
      const size = hi - lo;
      const room = a1 - a0;
      if (size <= room) return a0 + (room - size) / 2 - lo;
      return clamp(t, a1 - hi - slack, a0 - lo + slack);
    };
    return { tx: fit(x0, x1, ax0, ax1, tx), ty: fit(y0, y1, ay0, ay1, ty) };
  }

  setView(z, tx, ty, animate = false, slack = 0) {
    const was = this.z;
    if (z <= 1.001) {
      z = 1;
      tx = 0;
      ty = 0;
    } else {
      const c = this._clampView(z, tx, ty, slack);
      tx = c.tx;
      ty = c.ty;
    }
    this.z = z;
    this.tx = tx;
    this.ty = ty;
    this._applyView(animate);
    this.stage.classList.toggle('fb-zoomed', z > 1.001);
    if (z !== was) {
      this._emit('zoom', { z });
      this._refreshQuality();
    }
  }

  /** Zoom mantendo fixo o ponto (sx, sy) da tela. */
  zoomAt(z, sx, sy, animate = true) {
    z = clamp(z, 1, this.o.maxZoom);
    if (sx == null) {
      sx = this.sw / 2;
      sy = this.sh / 2;
    }
    if (z > 1.001) this._settle();
    const px = (sx - this.tx) / this.z;
    const py = (sy - this.ty) / this.z;
    this.setView(z, sx - z * px, sy - z * py, animate);
  }

  zoomIn() {
    this.zoomAt(this.z * 1.5);
  }
  zoomOut() {
    this.zoomAt(this.z / 1.5);
  }
  zoomReset() {
    this.zoomAt(1);
  }
  toggleZoom(sx, sy) {
    if (this.z > 1.05) this.zoomAt(1, sx, sy);
    else this.zoomAt(this.o.zoomStep, sx, sy);
  }

  _stopInertia() {
    cancelAnimationFrame(this._inertia);
    this._inertia = 0;
  }

  _startInertia(vx, vy) {
    this._stopInertia();
    let last = performance.now();
    const step = (now) => {
      const dt = Math.min(48, now - last);
      last = now;
      const d = Math.pow(0.994, dt);
      vx *= d;
      vy *= d;
      const bx = this.tx;
      const by = this.ty;
      this.setView(this.z, this.tx + vx * dt, this.ty + vy * dt);
      if (this.tx === bx) vx = 0;
      if (this.ty === by) vy = 0;
      if (Math.hypot(vx, vy) > 0.02 && this.z > 1.001) this._inertia = requestAnimationFrame(step);
    };
    this._inertia = requestAnimationFrame(step);
  }

  /* ------------------------------------------------------------------ */
  /* Entrada: ponteiro, toque, roda                                     */
  /* ------------------------------------------------------------------ */

  _toBook(cx, cy) {
    const r = this.rect;
    const sx = cx - r.left;
    const sy = cy - r.top;
    return { sx, sy, x: (sx - this.tx) / this.z - this.spineX, y: (sy - this.ty) / this.z - this.top };
  }

  _bind() {
    const st = this.stage;
    st.addEventListener('pointerdown', (e) => this._down(e));
    st.addEventListener('pointermove', (e) => this._move(e));
    st.addEventListener('pointerup', (e) => this._up(e));
    st.addEventListener('pointercancel', (e) => this._up(e, true));
    st.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse' && !this.g) this._dropPeel();
    });
    st.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
    st.addEventListener('dblclick', (e) => {
      // no toque, o duplo toque já é tratado em _tap; e se os dois cliques acabaram de
      // virar páginas (clique duplo na borda), não é pedido de zoom
      if (this._ptype !== 'mouse' || e.target.closest('a') || (this.flip && this.flip.committed)) return;
      const b = this._toBook(e.clientX, e.clientY);
      if (this.z <= 1.01 && this._zone(b) !== 0) return;
      this.toggleZoom(b.sx, b.sy);
    });
    for (const t of ['gesturestart', 'gesturechange', 'gestureend']) st.addEventListener(t, (e) => e.preventDefault());
    st.addEventListener('dragstart', (e) => e.preventDefault());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this._settle();
      else this._measureIdle();
    });
    // a conexão voltou: tenta de novo as imagens das páginas à vista
    window.addEventListener('online', () => {
      for (const n of this.pagesAt(this.index)) this._loadFor(n);
    });
    if ('ResizeObserver' in window) {
      let first = true;
      new ResizeObserver(() => {
        if (first) {
          first = false;
          return;
        }
        this.layout();
      }).observe(st);
    } else {
      window.addEventListener('resize', () => this.layout());
    }
  }

  _down(e) {
    this._ptype = e.pointerType;
    // Ctrl+clique no macOS abre o menu de contexto e o "soltar" nunca chega: ignora
    if (e.pointerType === 'mouse' && (e.button !== 0 || e.ctrlKey)) return;
    if (e.target.closest('a')) return;
    this.rect = this.stage.getBoundingClientRect();
    this.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try {
      this.stage.setPointerCapture(e.pointerId);
    } catch (_) {}
    this._stopInertia();
    if (this.ptrs.size === 2) {
      // pinça: encerra qualquer virada em curso (arrasto não confirmado volta ao lugar)
      this._settle();
      this.stage.classList.remove('fb-grabbing');
      const [a, b] = [...this.ptrs.values()];
      const mxp = (a.x + b.x) / 2 - this.rect.left;
      const myp = (a.y + b.y) / 2 - this.rect.top;
      this.g = {
        type: 'pinch',
        d0: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        z0: this.z,
        px: (mxp - this.tx) / this.z,
        py: (myp - this.ty) / this.z,
        mx: mxp,
        my: myp,
      };
      this.zoomEl.style.transition = 'none';
      this.zoomEl.style.willChange = 'transform';
    } else if (this.ptrs.size === 1) {
      this.g = {
        type: 'pending',
        id: e.pointerId,
        ptype: e.pointerType,
        x0: e.clientX,
        y0: e.clientY,
        t0: performance.now(),
        samples: [],
      };
    }
  }

  _move(e) {
    const p = this.ptrs.get(e.pointerId);
    if (!p) {
      if (e.pointerType === 'mouse' && !e.buttons) this._hover(e);
      return;
    }
    // mouse "arrastando" sem botão apertado = o soltar se perdeu (menu, outra janela): encerra
    if (e.pointerType === 'mouse' && e.buttons === 0) {
      this._up(e, true);
      return;
    }
    p.x = e.clientX;
    p.y = e.clientY;
    const g = this.g;
    if (!g) return;

    if (g.type === 'pinch') {
      if (this.ptrs.size < 2) return;
      const [a, b] = [...this.ptrs.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const z = clamp(g.z0 * (d / g.d0), 0.75, this.o.maxZoom * 1.25);
      const mxp = (g.mx = (a.x + b.x) / 2 - this.rect.left);
      const myp = (g.my = (a.y + b.y) / 2 - this.rect.top);
      // durante a pinça deixa passar um pouco dos limites (efeito elástico)
      const was = this.z;
      this.z = z;
      this.tx = mxp - z * g.px;
      this.ty = myp - z * g.py;
      this.zoomEl.style.transform = `translate3d(${this.tx.toFixed(2)}px,${this.ty.toFixed(2)}px,0) scale(${z.toFixed(4)})`;
      this.stage.classList.toggle('fb-zoomed', z > 1.001);
      if (z !== was) this._emit('zoom', { z: clamp(z, 1, this.o.maxZoom) });
      return;
    }

    if (e.pointerId !== g.id) return;
    const dx = e.clientX - g.x0;
    const dy = e.clientY - g.y0;
    const now = performance.now();
    g.samples.push({ t: now, x: e.clientX, y: e.clientY });
    if (g.samples.length > 6) g.samples.shift();

    if (g.type === 'pending') {
      if (Math.hypot(dx, dy) < (g.ptype === 'mouse' ? 4 : 8)) return;
      if (this.z > 1.01) {
        g.type = 'pan';
        g.tx0 = this.tx - dx;
        g.ty0 = this.ty - dy;
        this.zoomEl.style.transition = 'none';
        this.stage.classList.add('fb-grabbing');
      } else {
        // dedo que sobrou de uma pinça não vira página
        if (g.noTap) {
          g.type = 'dead';
          return;
        }
        const start = this._toBook(g.x0, g.y0);
        let f = this.flip;
        if (f && (f.mode === 'peel' || f.mode === 'peel-out' || f.mode === 'hint')) {
          g.fromPeel = f.mode === 'peel';
          f.anim = null;
          f.mode = 'drag';
        } else {
          if (Math.abs(dy) > Math.abs(dx) * 1.7) {
            g.type = 'dead';
            return;
          }
          this._settle();
          const plan = this._plan(dx < 0 ? 1 : -1);
          if (!plan) {
            g.type = 'dead';
            return;
          }
          f = this._startFlip(plan, start.y >= this.H / 2 ? this.H : 0, 'drag');
        }
        g.type = 'flip';
        g.f = f; // o arrasto só comanda ESTA virada (teclado/roda podem iniciar outra no meio)
        // mantém parte da distância vertical entre o dedo e o canto: dobra mais natural
        g.oy = clamp(start.y, 0, this.H) - f.cy;
        this.stage.classList.add('fb-grabbing');
      }
    }

    if (g.type === 'flip') {
      const f = this.flip;
      if (!f || f !== g.f) return;
      const b = this._toBook(e.clientX, e.clientY);
      f.T = { x: f.s * b.x, y: b.y - g.oy * 0.72 };
      this._schedule();
    } else if (g.type === 'pan') {
      this.setView(this.z, g.tx0 + dx, g.ty0 + dy, false, 40);
    }
  }

  _velocity(g) {
    const s = g.samples;
    if (s.length < 2) return { vx: 0, vy: 0 };
    const b = s[s.length - 1];
    let a = s[0];
    for (const q of s) {
      if (b.t - q.t <= 110) {
        a = q;
        break;
      }
    }
    const dt = Math.max(1, b.t - a.t);
    if (performance.now() - b.t > 90) return { vx: 0, vy: 0 };
    return { vx: (b.x - a.x) / dt, vy: (b.y - a.y) / dt };
  }

  _up(e, cancelled) {
    if (!this.ptrs.has(e.pointerId)) return;
    this.ptrs.delete(e.pointerId);
    try {
      this.stage.releasePointerCapture(e.pointerId);
    } catch (_) {}
    const g = this.g;
    if (!g) return;

    if (g.type === 'pinch') {
      if (this.ptrs.size >= 2) return;
      this.g = null;
      // acomoda dentro dos limites, mantendo fixo o ponto entre os dedos
      let z = clamp(this.z, 1, this.o.maxZoom);
      if (z < 1.02) z = 1; // quase sem zoom = sem zoom (evita a barra de zoom "presa")
      const px = (g.mx - this.tx) / this.z;
      const py = (g.my - this.ty) / this.z;
      this.setView(z, g.mx - z * px, g.my - z * py, true);
      this._emit('zoom', { z: this.z });
      this._refreshQuality();
      // o dedo que ficou continua como arrasto (para mover a página ampliada)
      if (this.ptrs.size === 1) {
        const [id, p] = [...this.ptrs.entries()][0];
        this.g = { type: 'pending', id, ptype: e.pointerType, x0: p.x, y0: p.y, t0: performance.now(), samples: [], noTap: true };
      }
      return;
    }

    if (e.pointerId !== g.id) return;
    this.g = null;
    this.stage.classList.remove('fb-grabbing');

    if (g.type === 'pending') {
      if (!cancelled && !g.noTap) this._tap(e, g);
    } else if (g.type === 'flip') {
      const f = this.flip;
      if (!f || f !== g.f) return;
      const moved = Math.abs(e.clientX - g.x0);
      const slip = moved < Math.max(16, this.W * 0.04);
      // toque "escorregado" (mexeu poucos pixels, rapidinho): vale como toque, não como arrasto
      if (slip && !cancelled && performance.now() - g.t0 < 300) {
        if (g.fromPeel) {
          this._release(f, true); // clique no cantinho levantado: vira
        } else {
          this._finishFlip(false);
          this._tap(e, g);
        }
        return;
      }
      const { vx } = this._velocity(g);
      const v = vx * f.s; // velocidade no espaço da folha (negativa = indo virar)
      const tx = f.T ? f.T.x : f.P.x;
      let far; // a folha vai para o lado "virado"?
      if (cancelled || slip) far = f.reverse; // volta para onde estava
      else if (v < -0.32) far = true;
      else if (v > 0.32) far = false;
      else if (moved < this.W * 0.15) far = f.reverse; // arrasto curto e lento: desiste
      else far = tx < this.W * (this.mode === 'double' ? 0.3 : 0.45);
      this._release(f, f.reverse ? !far : far);
    } else if (g.type === 'pan') {
      const { vx, vy } = this._velocity(g);
      this.setView(this.z, this.tx, this.ty, false);
      if (Math.hypot(vx, vy) > 0.15) this._startInertia(vx, vy);
    }
  }

  /** Zona de clique: +1 avançar, -1 voltar, 0 nenhuma. */
  _zone(b) {
    const fp = this._footprint(this.index);
    const zw = this.W * (this.mode === 'double' ? 0.17 : 0.22);
    if (b.x > fp.x1 - zw) return 1;
    if (b.x < fp.x0 + zw) return -1;
    return 0;
  }

  _tap(e, g) {
    const now = performance.now();
    const b = this._toBook(e.clientX, e.clientY);
    // toque numa borda que vira página é navegação: dois toques seguidos ali viram duas
    // páginas, não dão zoom (mesma regra do clique duplo com o mouse)
    const zone = this.z <= 1.01 ? this._zone(b) : 0;
    const nav = zone !== 0 && !!this._plan(zone);
    if (g.ptype !== 'mouse') {
      const lt = this._lastTap;
      if (lt && !lt.nav && !nav && now - lt.t < 320 && Math.hypot(lt.x - e.clientX, lt.y - e.clientY) < 44) {
        this._lastTap = null;
        this.toggleZoom(b.sx, b.sy);
        return;
      }
      this._lastTap = { t: now, x: e.clientX, y: e.clientY, nav };
    }
    if (this.z > 1.01) return;
    const f = this.flip;
    if (f && f.mode === 'peel') {
      // clique no cantinho levantado: vira a página
      f.anim = null;
      this._release(f, true);
      return;
    }
    if (f && f.mode === 'hint') this._finishFlip(false);
    const zdir = this._zone(b);
    if (zdir > 0) this.next(b.y < this.H / 2 ? 'top' : 'bottom');
    else if (zdir < 0) this.prev(b.y < this.H / 2 ? 'top' : 'bottom');
  }

  /** Mouse parado perto de um canto: levanta a pontinha da página. */
  _hover(e) {
    if (this.z > 1.01 || this.g) return;
    let f = this.flip;
    if (f && f.mode !== 'peel' && f.mode !== 'peel-out') return;
    this.rect = this.stage.getBoundingClientRect();
    const b = this._toBook(e.clientX, e.clientY);
    const { W, H } = this;
    const zr = Math.max(46, W * 0.17);
    const fp = this._footprint(this.index);
    let hit = null;
    const cands = [];
    if (fp.x1 > 0) cands.push({ dir: 1, cx: W });
    if (fp.x0 < 0) cands.push({ dir: -1, cx: -W });
    for (const c of cands) {
      const inX = c.dir > 0 ? b.x > W - zr && b.x < W + 14 : b.x < -W + zr && b.x > -W - 14;
      if (!inX) continue;
      if (b.y > H - zr && b.y < H + 14) hit = { dir: c.dir, cy: H };
      else if (b.y < zr && b.y > -14) hit = { dir: c.dir, cy: 0 };
    }
    if (hit && this.mode === 'single' && hit.dir < 0) hit = null;
    // sobre um link, o canto não levanta: o clique é do link
    if (hit && e.target.closest && e.target.closest('a')) hit = null;
    if (!hit) {
      this._dropPeel();
      return;
    }
    if (f && (f.cy !== hit.cy || (f.toIndex > f.fromIndex ? 1 : -1) !== hit.dir)) {
      this._finishFlip(false);
      f = null;
    }
    if (!f) {
      const plan = this._plan(hit.dir);
      if (!plan) return;
      f = this._startFlip(plan, hit.cy, 'peel');
      f.tau = 70;
    }
    f.mode = 'peel';
    f.anim = null;
    const lx = f.s * b.x;
    const minP = Math.max(26, W * 0.085);
    const maxP = zr * 0.95;
    const px = clamp(W - lx, minP, maxP);
    const py = clamp(Math.abs(hit.cy - b.y), minP * 0.75, maxP);
    f.T = { x: W - px, y: hit.cy === 0 ? py : H - py };
    this.stage.classList.add('fb-peeling');
    this._schedule();
  }

  _dropPeel() {
    const f = this.flip;
    this.stage.classList.remove('fb-peeling');
    if (!f || f.mode !== 'peel') return;
    f.mode = 'peel-out';
    f.T = null;
    const p0 = { x: f.P.x, y: f.P.y };
    const end = { x: this.W, y: f.cy };
    f.anim = {
      t0: 0,
      dur: 240,
      ease: easeOut,
      path: (t) => ({ x: lerp(p0.x, end.x, t), y: lerp(p0.y, end.y, t) }),
      done: () => this._finishFlip(false),
    };
    this._schedule();
  }

  _wheel(e) {
    e.preventDefault();
    this.rect = this.stage.getBoundingClientRect();
    const unit = e.deltaMode === 1 ? 32 : 1;
    if (e.ctrlKey || e.metaKey) {
      const b = this._toBook(e.clientX, e.clientY);
      this.zoomAt(this.z * Math.exp(-e.deltaY * unit * 0.0045), b.sx, b.sy, false);
      // terminou quase sem zoom? volta para o tamanho normal (a barra de zoom não fica "presa")
      clearTimeout(this._wzTimer);
      this._wzTimer = setTimeout(() => {
        if (this.z > 1 && this.z <= 1.01) this.setView(1, 0, 0, true);
      }, 220);
      return;
    }
    if (this.z > 1.01) {
      this.setView(this.z, this.tx - e.deltaX * unit, this.ty - e.deltaY * unit);
      return;
    }
    const d = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * unit;
    const a = Math.abs(d);
    const now = performance.now();
    // roda de mouse com "dentes" (passos inteiros) x trackpad (fluxo contínuo com inércia)
    const notched =
      e.deltaMode === 1 ||
      (e.deltaX === 0 && a >= 50 && (e.wheelDeltaY !== undefined ? e.wheelDeltaY % 120 === 0 : a >= 100));
    if (notched) {
      if (now < this._wheelLock) return;
      // se for um trackpad que "pareceu" roda, o resto do gesto segue a regra de inércia
      this._wheelT = now;
      this._wheelFired = true;
      this._wheelAcc = 0;
      this._wheelMin = a;
    } else {
      const gap = now - this._wheelT;
      this._wheelT = now;
      if (gap > 180) {
        // pausa = gesto novo
        this._wheelAcc = 0;
        this._wheelFired = false;
      }
      if (!this._wheelFired) {
        // junta os pequenos deslocamentos até formar um "empurrão" de verdade
        if (this._wheelAcc * d < 0) this._wheelAcc = 0;
        this._wheelAcc += d;
        if (Math.abs(this._wheelAcc) < 30 || now < this._wheelLock) return;
      } else {
        // mesmo gesto, página já virada: a inércia só diminui; só um novo impulso (que cresce) vira outra
        if (now < this._wheelLock) {
          this._wheelMin = Infinity;
          return;
        }
        this._wheelMin = Math.min(this._wheelMin, a);
        if (a < 14 || a < this._wheelMin * 2) return;
      }
      this._wheelFired = true;
      this._wheelAcc = 0;
      this._wheelMin = a;
    }
    this._wheelLock = now + 620;
    if (d > 0) this.next();
    else this.prev();
  }
}
