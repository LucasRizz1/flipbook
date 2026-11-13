# Flipbook

Visualizador de catálogos/revistas em formato de livro, com virada de página realista
(dobra, sombras e brilho), zoom com texto sempre nítido e suporte a celular. É um site
estático: HTML, CSS e JavaScript puros, sem dependências e sem etapa de build — roda direto
no GitHub Pages.

## Publicar um PDF

1. Instale as dependências do conversor (uma vez só):

   ```bash
   python -m pip install pymupdf pillow
   ```

2. Converta o PDF (isso substitui o conteúdo da pasta `book/`):

   ```bash
   python tools/pdf2book.py "caminho/do/catalogo.pdf" --title "Meu Catálogo"
   ```

3. Envie para o GitHub:

   ```bash
   git add -A
   git commit -m "Atualiza o catálogo"
   git push
   ```

   O site atualiza sozinho em um ou dois minutos.

O que o conversor gera:

- cada página em três tamanhos (miniatura, tela e zoom);
- uma **camada de texto vetorial** por página (o fundo sem texto + o texto em SVG): quando o
  zoom passa da resolução das imagens, o visualizador troca para ela e as letras continuam
  nítidas em qualquer ampliação. Cada página é conferida — se a recomposição não bater com o
  original, aquela página fica só com a imagem normal;
- **links clicáveis**: os links do PDF e também sites e e-mails que aparecem escritos no texto;
- uma cópia do PDF para o botão **Baixar**.

Opções:

| Opção | Para quê |
| --- | --- |
| `--title "Nome"` | título mostrado no topo |
| `--lang pt` / `en` / `es` | idioma dos botões e dicas (sem isso, usa o idioma do navegador de quem abre) |
| `--brand "Minha Empresa"` | texto pequeno no canto superior direito |
| `--out outra-pasta` | grava em outra pasta — dá para ter vários catálogos: abra com `index.html?book=outra-pasta` |
| `--sizes 400,1200,2400` | larguras das imagens em pixels |
| `--quality 82` · `--format jpg` | qualidade e formato das imagens |
| `--no-pdf` | não copia o PDF (some o botão Baixar) |
| `--no-vector-text` | não gera a camada de texto vetorial |
| `--no-auto-links` | não transforma sites/e-mails do texto em links |

## Testar no computador

```bash
python -m http.server 8765
```

Depois abra <http://localhost:8765>. (Abrir o `index.html` direto do disco não funciona,
porque o navegador bloqueia o carregamento do `book.json`.)

Para gerar um livro de demonstração sem PDF: `python tools/make_demo_pages.py`
(atenção: ele substitui o conteúdo de `book/`).

## Controles

| Ação | Computador | Celular |
| --- | --- | --- |
| Virar página | arrastar a página, clicar na borda, setas, teclado ← →, roda do mouse | deslizar o dedo ou tocar na borda |
| Zoom | duplo clique, botão de lupa, Ctrl + roda, teclas + e − | pinça ou duplo toque |
| Mover com zoom | arrastar | arrastar |
| Ir para uma página | barra inferior ou miniaturas | barra inferior ou miniaturas |
| Tela cheia | botão no canto inferior direito ou tecla F | botão (quando o navegador permite) |

O endereço guarda a página atual (`#p=12`), então dá para compartilhar o link de uma página.

## Estrutura

```
index.html            página única
css/flipbook.css      visual
js/flipbook.js        motor: geometria da dobra, sombras, gestos, zoom
js/app.js             interface: barras, miniaturas, teclado, link da página
js/i18n.js            textos da interface (português, inglês, espanhol)
js/sound.js           som de página (sintetizado, sem arquivos de áudio)
book/book.json        manifesto do livro (título, nº de páginas, tamanhos, links)
book/pages/...        imagens das páginas, fundos sem texto e textos em SVG
tools/pdf2book.py     conversor de PDF
tools/make_demo_pages.py   gera o livro de demonstração
```

### `book.json`

```json
{
  "title": "Meu Catálogo",
  "version": "20261113110545",
  "lang": "pt",
  "pages": 28,
  "pageWidth": 595.28,
  "pageHeight": 841.89,
  "sizes": [
    { "width": 400,  "path": "pages/400/{n}.webp" },
    { "width": 1200, "path": "pages/1200/{n}.webp" },
    { "width": 2400, "path": "pages/2400/{n}.webp" }
  ],
  "vector": {
    "bg": "pages/bg/{n}.webp",
    "bgWidth": 2400,
    "text": "pages/text/{n}.svg",
    "pages": [1, 2, 3]
  },
  "pdf": "catalogo.pdf",
  "brand": "Minha Empresa",
  "logo": "logo.svg",
  "links": { "27": [{ "x": 20.4, "y": 90.9, "w": 14.6, "h": 1.1, "url": "https://exemplo.com.br" }] }
}
```

- `links` usa porcentagens da página; troque `url` por `"page": 5` para um link interno.
- `version` muda a cada conversão e evita que o navegador mostre páginas antigas em cache.
- `"sound": false` desliga o som por padrão; `"maxZoom": 8` muda o limite do zoom.
- `logo` é um arquivo dentro da pasta do livro, mostrado no canto superior direito.

## Como a virada funciona

- A dobra é a mediatriz entre o canto original da folha e a posição do dedo/mouse.
  A parte da folha além dessa linha é espelhada sobre ela — é a "aba" que mostra o verso.
- Duas restrições mantêm a folha presa à lombada (o canto nunca se afasta mais que a largura
  da página do pé da lombada, nem mais que a diagonal do topo), então a dobra é sempre possível
  num papel de verdade.
- Frente, verso e página de baixo são elementos comuns recortados com `clip-path`; as luzes
  (sombra projetada, sombra na página revelada, brilho no vinco) são desenhadas num `<canvas>`
  por cima, no mesmo quadro.
- Em telas largas o livro abre em página dupla, com a capa sozinha; em telas em pé (celular)
  vira página única.
- As imagens carregam em camadas: miniatura primeiro, depois o tamanho da tela, a versão de
  alta resolução no zoom e, além dela, a camada de texto vetorial.
