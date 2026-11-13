/*
 * i18n.js — textos da interface em português, inglês e espanhol.
 * O idioma vem de "lang" no book.json; sem isso, usa o idioma do navegador.
 */

const TEXTS = {
  pt: {
    tools: 'Ferramentas',
    thumbs: 'Miniaturas',
    share: 'Compartilhar',
    download: 'Baixar PDF',
    sound: 'Som ligado/desligado',
    zoom: 'Zoom',
    zoomIn: 'Aumentar zoom',
    zoomOut: 'Diminuir zoom',
    zoomClose: 'Fechar zoom',
    zoomLevel: 'Nível de zoom',
    fullscreen: 'Tela cheia',
    prev: 'Página anterior',
    next: 'Próxima página',
    slider: 'Ir para a página',
    close: 'Fechar',
    page: 'Página',
    pages: 'Páginas',
    goTo: 'Ir para a página',
    copied: 'Link copiado',
    copyPrompt: 'Copie o link:',
    loading: 'Carregando…',
    loadError: 'Não foi possível carregar o livro.',
  },
  en: {
    tools: 'Tools',
    thumbs: 'Thumbnails',
    share: 'Share',
    download: 'Download PDF',
    sound: 'Sound on/off',
    zoom: 'Zoom',
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    zoomClose: 'Close zoom',
    zoomLevel: 'Zoom level',
    fullscreen: 'Full screen',
    prev: 'Previous page',
    next: 'Next page',
    slider: 'Go to page',
    close: 'Close',
    page: 'Page',
    pages: 'Pages',
    goTo: 'Go to page',
    copied: 'Link copied',
    copyPrompt: 'Copy the link:',
    loading: 'Loading…',
    loadError: 'The book could not be loaded.',
  },
  es: {
    tools: 'Herramientas',
    thumbs: 'Miniaturas',
    share: 'Compartir',
    download: 'Descargar PDF',
    sound: 'Sonido sí/no',
    zoom: 'Zoom',
    zoomIn: 'Acercar',
    zoomOut: 'Alejar',
    zoomClose: 'Cerrar zoom',
    zoomLevel: 'Nivel de zoom',
    fullscreen: 'Pantalla completa',
    prev: 'Página anterior',
    next: 'Página siguiente',
    slider: 'Ir a la página',
    close: 'Cerrar',
    page: 'Página',
    pages: 'Páginas',
    goTo: 'Ir a la página',
    copied: 'Enlace copiado',
    copyPrompt: 'Copia el enlace:',
    loading: 'Cargando…',
    loadError: 'No se pudo cargar el libro.',
  },
};

/** Escolhe o idioma: o pedido (book.json) ou o do navegador; inglês se não houver tradução. */
export function pickLang(wanted) {
  const cands = [wanted, ...(navigator.languages || [navigator.language || ''])];
  for (const c of cands) {
    const code = String(c || '').slice(0, 2).toLowerCase();
    if (TEXTS[code]) return code;
  }
  return 'en';
}

/**
 * Aplica os textos na página e devolve a função t(chave).
 * Elementos com data-i18n="chave" recebem title + aria-label;
 * com data-i18n-text="chave", o próprio texto.
 */
export function applyLang(lang, root = document) {
  const dict = TEXTS[lang] || TEXTS.en;
  const t = (key) => dict[key] || TEXTS.en[key] || key;
  document.documentElement.lang = lang === 'pt' ? 'pt-BR' : lang;
  for (const el of root.querySelectorAll('[data-i18n]')) {
    const s = t(el.dataset.i18n);
    el.setAttribute('aria-label', s);
    if (el.tagName !== 'INPUT' && el.tagName !== 'NAV' && el.tagName !== 'ASIDE') el.title = s;
  }
  for (const el of root.querySelectorAll('[data-i18n-text]')) el.textContent = t(el.dataset.i18nText);
  return t;
}
