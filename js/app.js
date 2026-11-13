/*
 * app.js — interface do flipbook: barras, miniaturas, controle de páginas,
 * zoom, tela cheia, som, teclado e link direto para a página (#p=12).
 * O conteúdo vem de book/book.json (gerado por tools/pdf2book.py).
 */

import { FlipBook } from './flipbook.js';
import { PageSound } from './sound.js';
import { pickLang, applyLang } from './i18n.js';

// textos da interface: começa no idioma do navegador; depois de ler o book.json
// passa a valer o "lang" definido lá (se houver)
let t = applyLang(pickLang());

// Pasta do livro. Padrão: book/. Para ter vários catálogos no mesmo site,
// crie outras pastas e abra com  index.html?book=nome-da-pasta
const BASE = (() => {
  const q = new URLSearchParams(location.search).get('book') || '';
  return /^[\w-]+(\/[\w-]+)*\/?$/.test(q) ? q.replace(/\/?$/, '/') : 'book/';
})();
const $ = (s, r = document) => r.querySelector(s);

const app = $('#app');
const stage = $('#stage');
const el = {
  title: $('#title'),
  brand: $('#brand'),
  tools: $('#tools'),
  zoombar: $('#zoombar'),
  zoomRange: $('#zoomRange'),
  pageLabel: $('#pageLabel'),
  pageTotal: $('#pageTotal'),
  pageRange: $('#pageRange'),
  tip: $('#tip'),
  tipImgs: $('#tipImgs'),
  tipLabel: $('#tipLabel'),
  prev: $('#btnPrev'),
  next: $('#btnNext'),
  full: $('#btnFull'),
  download: $('#btnDownload'),
  panel: $('#panel'),
  thumbs: $('#thumbs'),
  scrim: $('#scrim'),
  toast: $('#toast'),
  loaderTitle: $('#loaderTitle'),
  loaderMsg: $('#loaderMsg'),
};

const store = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch (_) {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch (_) {}
  },
};

function pageFromHash() {
  const m = /[#&]p=(\d+)/.exec(location.hash);
  return m ? parseInt(m[1], 10) : 0;
}

/** Espaço reservado para as barras e as setas: o livro ocupa o que sobra. */
function insets(sw, sh) {
  const small = sw < 720 || sh < 480;
  const top = $('.fb-top').offsetHeight || 48;
  const bottom = $('.fb-bottom').offsetHeight || 46;
  const side = small ? 10 : 74;
  return { top: top + (small ? 8 : 14), bottom: bottom + (small ? 14 : 24), left: side, right: side };
}

let toastTimer = 0;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('on'), 1900);
}

async function main() {
  let meta;
  try {
    const r = await fetch(BASE + 'book.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    meta = await r.json();
  } catch (err) {
    el.loaderMsg.textContent = `${t('loadError')} (${BASE}book.json)`;
    console.error(err);
    return;
  }

  t = applyLang(pickLang(meta.lang));
  const title = meta.title || 'Flipbook';
  document.title = title;
  el.title.textContent = title;
  el.loaderTitle.textContent = title;
  el.pageTotal.textContent = meta.pages;
  if (meta.logo) {
    const img = new Image();
    img.src = BASE + meta.logo;
    img.alt = meta.brand || '';
    el.brand.append(img);
  } else if (meta.brand) {
    const s = document.createElement('span');
    s.textContent = meta.brand;
    el.brand.append(s);
  }
  if (meta.pdf) {
    el.download.href = BASE + meta.pdf;
    el.download.setAttribute('download', meta.pdf.split('/').pop());
    el.download.hidden = false;
  }

  const sound = new PageSound();
  sound.enabled = meta.sound !== false && store.get('fb-sound') !== '0';
  app.classList.toggle('is-muted', !sound.enabled);

  const book = new FlipBook(stage, meta, {
    base: BASE,
    startPage: pageFromHash() || 1,
    insets,
    goToLabel: (n) => `${t('goTo')} ${n}`,
  });
  window.flipbook = book; // útil para depurar pelo console
  el.zoomRange.max = book.o.maxZoom;

  /* ---------------- sincronização da interface ---------------- */

  let thumbsMode = '';

  function sync(info = book.info()) {
    el.pageLabel.textContent = info.label;
    el.pageRange.min = info.min;
    el.pageRange.max = info.max;
    el.pageRange.value = info.index;
    el.prev.disabled = info.first;
    el.next.disabled = info.last;
    const b = book.bounds(info.index);
    app.style.setProperty('--ax0', Math.round(b.x0 - 62) + 'px');
    app.style.setProperty('--ax1', Math.round(b.x1 + 12) + 'px');
    app.classList.toggle('no-arrows', book.sw < 720 || book.sh < 480);
    const p = info.pages[0];
    // só mexe no endereço quando a página muda (o Safari limita chamadas de replaceState)
    if ((pageFromHash() || 1) !== p) {
      try {
        history.replaceState(null, '', p > 1 ? '#p=' + p : location.pathname + location.search);
      } catch (_) {}
    }
    markThumb(info.index);
  }

  function buildThumbs() {
    const info = book.info();
    if (thumbsMode === info.mode) return;
    thumbsMode = info.mode;
    el.thumbs.classList.toggle('cols-2', info.mode === 'single');
    const frag = document.createDocumentFragment();
    for (let i = info.min; i <= info.max; i++) {
      const pages = book.pagesAt(i);
      const b = document.createElement('button');
      b.className = 'fb-thumb';
      b.dataset.index = i;
      b.dataset.page = pages[0];
      const imgs = document.createElement('span');
      imgs.className = 'fb-thumb-imgs';
      for (const n of pages) {
        const im = new Image();
        im.loading = 'lazy';
        im.decoding = 'async';
        im.alt = `${t('page')} ${n}`;
        im.width = meta.pageWidth;
        im.height = meta.pageHeight;
        im.src = book.thumbUrl(n);
        imgs.append(im);
      }
      const lab = document.createElement('span');
      lab.textContent = pages.join(' - ');
      b.append(imgs, lab);
      frag.append(b);
    }
    el.thumbs.replaceChildren(frag);
  }

  function markThumb(index, scroll) {
    if (!thumbsMode) return;
    let cur = null;
    for (const b of el.thumbs.children) {
      const on = +b.dataset.index === index;
      b.classList.toggle('cur', on);
      if (on) cur = b;
    }
    if (cur && scroll) cur.scrollIntoView({ block: 'center' });
  }

  function openPanel(on) {
    if (on) {
      if (thumbsMode !== book.info().mode) thumbsMode = '';
      buildThumbs();
      markThumb(book.targetIndex, true);
      el.scrim.hidden = false;
      void el.scrim.offsetWidth; // aplica o estado inicial antes de animar (senão o escurecido "pula")
      el.scrim.classList.add('on');
    } else {
      el.scrim.classList.remove('on');
      setTimeout(() => {
        if (!el.panel.classList.contains('open')) el.scrim.hidden = true;
      }, 320);
    }
    el.panel.classList.toggle('open', on);
    el.panel.setAttribute('aria-hidden', String(!on));
  }

  book.addEventListener('change', (e) => sync(e.detail));
  book.addEventListener('layout', (e) => {
    if (thumbsMode && thumbsMode !== e.detail.mode && el.panel.classList.contains('open')) {
      thumbsMode = '';
      buildThumbs();
    }
    sync(e.detail);
  });
  book.addEventListener('flip', () => sound.play());
  book.addEventListener('zoom', (e) => {
    const z = e.detail.z;
    const on = z > 1.001;
    app.classList.toggle('is-zoomed', on);
    el.tools.hidden = on;
    el.zoombar.hidden = !on;
    el.zoomRange.value = z;
  });
  sync();

  /* ---------------- ações ---------------- */

  const canFs = !!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen);
  if (!canFs) el.full.hidden = true;

  function toggleFs() {
    const d = document;
    const root = d.documentElement;
    if (d.fullscreenElement || d.webkitFullscreenElement) {
      (d.exitFullscreen || d.webkitExitFullscreen).call(d);
    } else {
      const p = (root.requestFullscreen || root.webkitRequestFullscreen).call(root);
      if (p && p.catch) p.catch(() => {});
    }
  }
  for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) {
    document.addEventListener(ev, () => app.classList.toggle('is-full', !!(document.fullscreenElement || document.webkitFullscreenElement)));
  }

  async function share() {
    const url = location.href;
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      try {
        await navigator.share({ title, url });
      } catch (_) {}
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      toast(t('copied'));
    } catch (_) {
      window.prompt(t('copyPrompt'), url);
    }
  }

  const actions = {
    thumbs: () => openPanel(!el.panel.classList.contains('open')),
    'panel-close': () => openPanel(false),
    share,
    sound: () => {
      sound.enabled = !sound.enabled;
      store.set('fb-sound', sound.enabled ? '1' : '0');
      app.classList.toggle('is-muted', !sound.enabled);
      if (sound.enabled) sound.play();
    },
    zoom: () => book.zoomAt(book.o.zoomStep),
    'zoom-in': () => book.zoomIn(),
    'zoom-out': () => book.zoomOut(),
    'zoom-reset': () => book.zoomReset(),
    fullscreen: toggleFs,
  };

  app.addEventListener('click', (e) => {
    const t = e.target.closest('[data-act]');
    if (t && actions[t.dataset.act]) {
      actions[t.dataset.act]();
      return;
    }
    const th = e.target.closest('.fb-thumb');
    if (th) {
      book.goToPage(+th.dataset.page);
      if (book.sw < 900) openPanel(false);
    }
  });
  el.scrim.addEventListener('click', () => openPanel(false));
  el.prev.addEventListener('click', () => book.prev());
  el.next.addEventListener('click', () => book.next());

  el.zoomRange.addEventListener('input', () => book.zoomAt(parseFloat(el.zoomRange.value), null, null, false));

  /* controle de páginas com prévia */
  function showTip() {
    const i = +el.pageRange.value;
    const pages = book.pagesAt(i);
    const key = pages.join(',');
    if (el.tip.dataset.k !== key) {
      el.tip.dataset.k = key;
      el.tipLabel.textContent = `${t(pages.length > 1 ? 'pages' : 'page')} ${pages.join('-')}`;
      el.tipImgs.replaceChildren(
        ...pages.map((n) => {
          const im = new Image();
          im.alt = '';
          im.width = meta.pageWidth; // reserva o formato antes de a imagem chegar
          im.height = meta.pageHeight;
          im.src = book.thumbUrl(n);
          return im;
        })
      );
    }
    const min = +el.pageRange.min;
    const max = +el.pageRange.max;
    const pct = max > min ? (i - min) / (max - min) : 0;
    el.tip.hidden = false; // precisa estar visível para medir a largura
    const x = 7 + pct * (el.pageRange.offsetWidth - 14);
    const half = el.tip.offsetWidth / 2;
    const left = el.pageRange.getBoundingClientRect().left;
    // acompanha o controle, mas nunca sai da tela
    el.tip.style.left = Math.max(6 + half - left, Math.min(window.innerWidth - 6 - half - left, x)) + 'px';
  }
  const hideTip = () => {
    el.tip.hidden = true;
  };
  el.pageRange.addEventListener('input', showTip);
  el.pageRange.addEventListener('change', () => {
    hideTip();
    book.goToPage(book.pagesAt(+el.pageRange.value)[0]);
    el.pageRange.blur();
  });
  el.pageRange.addEventListener('pointerup', hideTip);
  el.pageRange.addEventListener('blur', hideTip);

  /* teclado */
  window.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
    if ((tag === 'button' || tag === 'a') && (e.key === ' ' || e.key === 'Enter')) return;
    // tecla segurada: uma página por animação (sem isso o livro dispara até o fim)
    const held = e.repeat && book.flip && book.flip.committed;
    switch (e.key) {
      case 'ArrowRight':
      case 'PageDown':
      case ' ':
        if (!held) book.next();
        break;
      case 'ArrowLeft':
      case 'PageUp':
        if (!held) book.prev();
        break;
      case 'Home':
        book.first();
        break;
      case 'End':
        book.last();
        break;
      case '+':
      case '=':
        book.zoomIn();
        break;
      case '-':
      case '_':
        book.zoomOut();
        break;
      case '0':
        book.zoomReset();
        break;
      case 'Escape':
        if (el.panel.classList.contains('open')) openPanel(false);
        else book.zoomReset();
        break;
      case 'f':
      case 'F':
        toggleFs();
        break;
      default:
        return;
    }
    e.preventDefault();
  });

  window.addEventListener('hashchange', () => {
    const p = pageFromHash() || 1;
    if (!book.info().pages.includes(p)) book.goToPage(p);
  });

  // toque longo em imagem não deve abrir o menu do navegador
  let lastPointer = 'mouse';
  stage.addEventListener('pointerdown', (e) => (lastPointer = e.pointerType), true);
  stage.addEventListener('contextmenu', (e) => {
    if (lastPointer !== 'mouse') e.preventDefault();
  });

  /* ---------------- entrada em cena ---------------- */

  const need = new Set(book.pagesAt(book.index).filter((n) => !(book.pages.get(n) && book.pages.get(n).have)));
  let shown = false;
  const reveal = () => {
    if (shown) return;
    shown = true;
    app.classList.remove('is-loading');
    // levanta o cantinho da capa para mostrar que dá para folhear
    // (não para quem pediu menos animações no sistema)
    const calm = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    setTimeout(() => {
      if (!calm && book.index === book.minIndex && !document.hidden) book.hint();
    }, 1200);
  };
  book.addEventListener('pageimage', (e) => {
    need.delete(e.detail.n);
    if (!need.size) reveal();
  });
  if (!need.size) reveal();
  setTimeout(reveal, 6000);
}

main();
