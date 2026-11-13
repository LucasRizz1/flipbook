/*
 * sound.js — som de página virando, sintetizado na hora (Web Audio).
 * Não usa arquivos de áudio: é ruído filtrado com envelope de "folha passando"
 * mais estalinhos de papel. Três variações para não soar repetitivo.
 */

export class PageSound {
  constructor() {
    this.enabled = true;
    this.ctx = null;
    this.bufs = [];
    this._last = -1;
    this._lastAt = 0;
  }

  _init() {
    if (this.ctx) return true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    try {
      this.ctx = new AC();
    } catch (_) {
      return false;
    }
    for (let v = 0; v < 3; v++) this.bufs.push(this._render(v));
    return true;
  }

  /** Gera um buffer com o som de uma virada. */
  _render(variant) {
    const sr = this.ctx.sampleRate;
    const dur = 0.4 + variant * 0.035;
    const n = Math.floor(sr * dur);
    const buf = this.ctx.createBuffer(1, n, sr);
    const d = buf.getChannelData(0);
    let lo = 0; // passa-baixa (corpo do som)
    let lo2 = 0; // passa-baixa mais grave, subtraído → efeito passa-faixa
    let crk = 0; // estalinho atual
    let wob = 0; // textura lenta e irregular do papel
    let wobT = 0;
    const land = 0.7 + variant * 0.03; // instante em que a folha "pousa"
    for (let i = 0; i < n; i++) {
      const t = i / n;
      const white = Math.random() * 2 - 1;

      // envelope: sobe rápido, sustenta caindo, pequeno "pouso" no fim
      const rise = Math.min(1, t / 0.09);
      const body = Math.pow(1 - t, 1.6);
      const pat = Math.exp(-Math.pow((t - land) / 0.045, 2)) * 0.55;
      const env = rise * body * 0.9 + pat * (1 - t);

      // frequência de corte varrendo (a folha acelera e desacelera)
      const sweep = 0.1 + 0.32 * Math.sin(Math.PI * Math.min(1, t * 1.15));
      lo += (white - lo) * sweep;
      lo2 += (lo - lo2) * 0.035;
      const band = lo - lo2;

      // textura irregular
      if (i >= wobT) {
        wob = 0.55 + Math.random() * 0.45;
        wobT = i + Math.floor(sr * (0.002 + Math.random() * 0.006));
      }

      // estalinhos: mais densos no começo e no pouso
      const density = 0.0025 * (Math.exp(-t * 9) * 2.2 + pat * 1.6 + 0.12);
      if (Math.random() < density) crk = (Math.random() * 2 - 1) * (0.5 + Math.random() * 0.5);
      crk *= 0.72;

      d[i] = (band * env * wob * 1.7 + crk * env * 0.5) * 0.85;
    }
    // fade final para não dar clique
    const tail = Math.floor(sr * 0.02);
    for (let i = 0; i < tail; i++) d[n - 1 - i] *= i / tail;
    return buf;
  }

  /**
   * Toca o som de uma virada. Os navegadores só liberam áudio depois de um gesto do
   * usuário (clique, toque, tecla): enquanto estiver bloqueado, a virada fica muda —
   * nada é enfileirado para "estourar" tudo junto mais tarde.
   */
  play(volume = 1) {
    if (!this.enabled || !this._init()) return;
    const ctx = this.ctx;
    if (ctx.state !== 'running') {
      const t0 = performance.now();
      let p;
      try {
        p = ctx.resume();
      } catch (_) {}
      if (p && p.then) {
        p.then(
          () => {
            if (ctx.state === 'running' && performance.now() - t0 < 200) this._fire(volume);
          },
          () => {}
        );
      }
      return;
    }
    this._fire(volume);
  }

  _fire(volume) {
    const ctx = this.ctx;
    // viradas em sequência muito rápida: não empilha sons
    const now = performance.now();
    if (now - this._lastAt < 90) return;
    this._lastAt = now;
    let v = Math.floor(Math.random() * this.bufs.length);
    if (v === this._last) v = (v + 1) % this.bufs.length;
    this._last = v;
    const src = ctx.createBufferSource();
    src.buffer = this.bufs[v];
    src.playbackRate.value = 0.92 + Math.random() * 0.18;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 320;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 6800;
    const gain = ctx.createGain();
    gain.gain.value = 0.42 * volume;
    src.connect(hp).connect(lp).connect(gain).connect(ctx.destination);
    src.start();
  }
}
