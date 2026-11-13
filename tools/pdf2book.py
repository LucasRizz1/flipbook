#!/usr/bin/env python3
"""
pdf2book.py — transforma um PDF no conteúdo do flipbook.

    python tools/pdf2book.py catalogo.pdf --title "Meu Catálogo"

Gera, dentro de book/:
    book.json                 manifesto lido pelo flipbook
    pages/<largura>/<n>.webp  cada página em 3 tamanhos (miniatura, tela, zoom)
    pages/bg/<n>.webp         a página sem o texto  ┐ usados juntos no zoom fundo:
    pages/text/<n>.svg        só o texto, vetorial  ┘ o texto fica nítido em qualquer ampliação
    <arquivo>.pdf             cópia do PDF para o botão "Baixar" (use --no-pdf para não copiar)

Links do PDF (sites, e-mails, links internos) viram áreas clicáveis; endereços de site e
e-mails escritos no texto também são detectados e ficam clicáveis.

Requisitos (uma vez só):
    python -m pip install pymupdf pillow
"""
import argparse
import json
import os
import re
import shutil
import sys
import time
import unicodedata

TLDS = "com|net|org|gov|edu|ind|io|co|br|info|biz|app|dev|me|tv|us|uk|pt|es|ar|mx|cl|de|fr|it"
DOMAIN_RE = re.compile(rf"^(?:https?://)?(?:[a-z0-9-]+\.)+(?:{TLDS})(?:\.[a-z]{{2}})?(?:[/?#]\S*)?$", re.I)
EMAIL_RE = re.compile(r"^[\w.+-]+@(?:[\w-]+\.)+[a-z]{2,}$", re.I)


def ascii_name(name, fallback):
    """Nome simples para usar em URL: sem acentos, espaços ou símbolos."""
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii")
    s = re.sub(r"-{2,}", "-", re.sub(r"[^A-Za-z0-9._-]+", "-", s)).strip("-.")
    return s or fallback


def main():
    ap = argparse.ArgumentParser(description="Converte um PDF para o formato do flipbook.")
    ap.add_argument("pdf", help="caminho do arquivo PDF")
    ap.add_argument("--title", help="título mostrado no flipbook (padrão: nome do arquivo)")
    ap.add_argument("--out", default=None, help="pasta de saída (padrão: book/ ao lado deste script)")
    ap.add_argument("--sizes", default="400,1200,2400", help="larguras em pixels, da menor para a maior")
    ap.add_argument("--quality", type=int, default=82, help="qualidade das imagens (1-100)")
    ap.add_argument("--format", choices=["webp", "jpg"], default="webp", help="formato das imagens")
    ap.add_argument("--lang", choices=["pt", "en", "es"], default=None, help="idioma da interface (padrão: o do navegador)")
    ap.add_argument("--brand", default=None, help="texto pequeno no canto superior direito")
    ap.add_argument("--no-pdf", action="store_true", help="não copiar o PDF (esconde o botão Baixar)")
    ap.add_argument("--no-vector-text", action="store_true", help="não gerar a camada de texto vetorial do zoom")
    ap.add_argument("--no-auto-links", action="store_true", help="não transformar sites e e-mails do texto em links")
    ap.add_argument(
        "--site-url",
        default=None,
        help="endereço público do site (ex.: https://usuario.github.io/flipbook/): grava no index.html "
        "a prévia com título e capa que aparece ao compartilhar o link (WhatsApp, redes sociais)",
    )
    ap.add_argument("--description", default=None, help="frase curta para a prévia de compartilhamento")
    args = ap.parse_args()

    try:
        import pymupdf as fitz  # PyMuPDF (nome novo do módulo)
    except ImportError:
        try:
            import fitz  # versões antigas do PyMuPDF
        except ImportError:
            sys.exit("Falta o PyMuPDF. Instale com:  python -m pip install pymupdf pillow")
    try:
        from PIL import Image, ImageChops, ImageFilter
    except ImportError:
        sys.exit("Falta o Pillow. Instale com:  python -m pip install pymupdf pillow")

    src = os.path.abspath(args.pdf)
    if not os.path.isfile(src):
        sys.exit(f"Arquivo não encontrado: {args.pdf}")

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out = os.path.abspath(args.out or os.path.join(root, "book"))
    try:
        sizes = sorted({int(s) for s in args.sizes.split(",") if s.strip()})
    except ValueError:
        sys.exit("--sizes deve ser uma lista de números, ex.: 400,1200,2400")
    if not sizes or sizes[0] < 50 or sizes[-1] > 6000:
        sys.exit("--sizes: use larguras entre 50 e 6000 pixels")
    if not 1 <= args.quality <= 100:
        sys.exit("--quality deve ficar entre 1 e 100")

    try:
        doc = fitz.open(src)
    except Exception as e:  # arquivo corrompido ou que não é PDF
        sys.exit(f"Não foi possível abrir o PDF: {e}")
    if doc.needs_pass:
        sys.exit("O PDF está protegido por senha.")
    if not doc.is_pdf:
        sys.exit("O arquivo não é um PDF.")
    n_pages = doc.page_count
    if n_pages == 0:
        sys.exit("O PDF não tem páginas.")

    fmt = args.format
    ext = "webp" if fmt == "webp" else "jpg"
    first = doc[0].rect
    pw, ph = first.width, first.height
    aspect = ph / pw
    title = args.title or os.path.splitext(os.path.basename(src))[0]

    def save(img, path):
        if fmt == "webp":
            img.save(path, "WEBP", quality=args.quality, method=5)
        else:
            img.save(path, "JPEG", quality=args.quality, optimize=True, progressive=True)

    def render(page, width, alpha=False):
        """Renderiza a página na largura pedida; devolve uma imagem PIL."""
        r = page.rect
        zoom = min(width / r.width, (width * aspect) / r.height)
        pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=alpha, colorspace=fitz.csRGB)
        return Image.frombytes("RGBA" if alpha else "RGB", (pix.width, pix.height), pix.samples)

    def fit(img, width):
        """Garante o mesmo formato em todas as páginas (centraliza em branco as diferentes)."""
        box = (width, round(width * aspect))
        if abs(img.width - box[0]) <= 1 and abs(img.height - box[1]) <= 1:
            return img
        canvas = Image.new("RGB", box, "white")
        canvas.paste(img, ((box[0] - img.width) // 2, (box[1] - img.height) // 2))
        return canvas

    # prepara a saída: apaga só o que este script gerou antes
    os.makedirs(out, exist_ok=True)
    old_pdf = None
    try:
        with open(os.path.join(out, "book.json"), encoding="utf-8") as f:
            old_pdf = json.load(f).get("pdf")
    except (OSError, ValueError):
        pass
    pages_dir = os.path.join(out, "pages")
    if os.path.isdir(pages_dir):
        shutil.rmtree(pages_dir)
    for s in sizes:
        os.makedirs(os.path.join(pages_dir, str(s)))
    use_vector = not args.no_vector_text
    if use_vector:
        os.makedirs(os.path.join(pages_dir, "bg"))
        os.makedirs(os.path.join(pages_dir, "text"))

    links = {}
    vector_pages = []
    total_bytes = 0
    t_start = time.time()
    for i in range(n_pages):
        page = doc[i]
        r = page.rect
        n = i + 1
        same_shape = abs(r.height / r.width - aspect) < 0.01

        for s in sizes:
            path = os.path.join(pages_dir, str(s), f"{n}.{ext}")
            save(fit(render(page, s), s), path)
            total_bytes += os.path.getsize(path)

        # ---- camada de texto vetorial (para zoom fundo) ----
        if use_vector and same_shape and page.get_text("text").strip():
            try:
                ok = False
                only_text = fitz.open()
                only_text.insert_pdf(doc, from_page=i, to_page=i)
                pt = only_text[0]
                pt.add_redact_annot(pt.rect, fill=False)
                pt.apply_redactions(images=1, graphics=2, text=1)  # tira imagens e desenhos, fica o texto
                no_text = fitz.open()
                no_text.insert_pdf(doc, from_page=i, to_page=i)
                pb = no_text[0]
                pb.add_redact_annot(pb.rect, fill=False)
                pb.apply_redactions(images=0, graphics=0, text=0)  # tira só o texto
                # confere: fundo + texto tem de reproduzir a página original
                check = 900
                ref = render(page, check)
                comp = render(pb, check).convert("RGBA")
                layer = render(pt, check, alpha=True)
                if layer.size == comp.size == ref.size:
                    comp.alpha_composite(layer)
                    hist = ImageChops.difference(ref, comp.convert("RGB")).convert("L").histogram()
                    bad = sum(hist[40:]) / (ref.width * ref.height)
                    ok = bad < 0.01 and not pb.get_text("text").strip()
                if ok:
                    svg = pt.get_svg_image(matrix=fitz.Identity, text_as_path=True)
                    # enxuga o SVG: atributos que o navegador não usa
                    svg = re.sub(r' data-text="[^"]*"', "", svg)
                    svg = svg.replace(' xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"', "")
                    bg_path = os.path.join(pages_dir, "bg", f"{n}.{ext}")
                    save(fit(render(pb, sizes[-1]), sizes[-1]), bg_path)
                    svg_path = os.path.join(pages_dir, "text", f"{n}.svg")
                    with open(svg_path, "w", encoding="utf-8") as f:
                        f.write(svg)
                    total_bytes += os.path.getsize(bg_path) + os.path.getsize(svg_path)
                    vector_pages.append(n)
                only_text.close()
                no_text.close()
            except Exception as e:  # qualquer problema: a página fica só com a imagem normal
                print(f"\n  aviso: página {n} sem texto vetorial ({e})")

        # ---- links ----
        page_links = []

        def add_link(rect, **target):
            rect = rect & r  # só a parte dentro da página
            if rect.is_empty or rect.width < 1 or rect.height < 1:
                return
            page_links.append(
                {
                    "x": round(100 * (rect.x0 - r.x0) / r.width, 3),
                    "y": round(100 * (rect.y0 - r.y0) / r.height, 3),
                    "w": round(100 * rect.width / r.width, 3),
                    "h": round(100 * rect.height / r.height, 3),
                    **target,
                }
            )

        annot_rects = []
        for lk in page.get_links():
            rect = lk.get("from")
            if rect is None:
                continue
            uri = lk.get("uri")
            if uri and re.match(r"^(https?:|mailto:|tel:)", uri, re.I):
                add_link(rect, url=uri)
                annot_rects.append(rect)
            elif lk.get("kind") in (fitz.LINK_GOTO, fitz.LINK_NAMED) and isinstance(lk.get("page"), int) and 0 <= lk["page"] < n_pages:
                add_link(rect, page=lk["page"] + 1)
                annot_rects.append(rect)

        if same_shape and not args.no_auto_links:
            for x0, y0, x1, y1, word, *_ in page.get_text("words"):
                w = word.strip("()[]<>{}\"'“”‘’").rstrip(".,;:!?")
                if not w or len(w) < 5:
                    continue
                if EMAIL_RE.match(w):
                    url = "mailto:" + w.lower()
                elif DOMAIN_RE.match(w):
                    explicit = re.match(r"^(https?://|www\.)", w, re.I)
                    # "fim.It começa" (frase sem espaço) não é site: sem www/http, exige tudo
                    # minúsculo ou tudo maiúsculo
                    if not explicit and not (w.islower() or w.isupper()):
                        continue
                    m = re.match(r"^(https?://)?([^/?#]+)(.*)$", w, re.I)
                    url = (m.group(1) or "https://").lower() + m.group(2).lower() + m.group(3)
                else:
                    continue
                rect = fitz.Rect(x0, y0, x1, y1) + (-1.5, -1.5, 1.5, 1.5)
                if any(rect.intersects(a) for a in annot_rects):
                    continue
                add_link(rect, url=url)
        if not same_shape:
            page_links = []  # página de formato diferente foi centralizada: as posições não valeriam
        if page_links:
            links[str(n)] = page_links

        if sys.stdout.isatty():
            print(f"  página {n}/{n_pages}", end="\r", flush=True)
        elif n % 5 == 0 or n == n_pages:
            print(f"  página {n}/{n_pages}", flush=True)

    manifest = {
        "title": title,
        "version": time.strftime("%Y%m%d%H%M%S"),
        "pages": n_pages,
        "pageWidth": round(pw, 2),
        "pageHeight": round(ph, 2),
        "sizes": [{"width": s, "path": f"pages/{s}/{{n}}.{ext}"} for s in sizes],
        "links": links,
    }
    if vector_pages:
        manifest["vector"] = {
            "bg": f"pages/bg/{{n}}.{ext}",
            "bgWidth": sizes[-1],
            "text": "pages/text/{n}.svg",
            "pages": vector_pages,
        }
    if args.lang:
        manifest["lang"] = args.lang
    if args.brand:
        manifest["brand"] = args.brand

    # PDF para o botão "Baixar"
    if old_pdf and re.fullmatch(r"[A-Za-z0-9._-]+\.pdf", old_pdf):
        old_path = os.path.join(out, old_pdf)
        if os.path.isfile(old_path) and not os.path.samefile(old_path, src):
            os.remove(old_path)
    if not args.no_pdf:
        pdf_name = ascii_name(os.path.basename(src), "catalogo.pdf")
        if not pdf_name.lower().endswith(".pdf"):
            pdf_name += ".pdf"
        dest = os.path.join(out, pdf_name)
        if not (os.path.exists(dest) and os.path.samefile(dest, src)):
            shutil.copyfile(src, dest)
        manifest["pdf"] = pdf_name

    with open(os.path.join(out, "book.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    # ---- prévia de compartilhamento: cartão 1200x630 com a capa ----
    card = Image.new("RGB", (1200, 630), (233, 233, 233))
    scale = min(566 / first.height, 1100 / first.width)
    cover = render(doc[0], max(50, round(first.width * scale)))
    cx, cy = (1200 - cover.width) // 2, (630 - cover.height) // 2
    shadow = Image.new("L", card.size, 0)
    shadow.paste(120, (cx - 2, cy + 6, cx + cover.width + 2, cy + cover.height + 10))
    card.paste((120, 120, 120), mask=shadow.filter(ImageFilter.GaussianBlur(12)))
    card.paste(cover, (cx, cy))
    card.save(os.path.join(out, "cover.jpg"), "JPEG", quality=86, optimize=True, progressive=True)

    if args.site_url:
        index_path = os.path.join(root, "index.html")
        if os.path.normcase(out) != os.path.normcase(os.path.join(root, "book")):
            print("Aviso: --site-url só vale para o livro principal (pasta book/); index.html não foi alterado.")
        elif not os.path.isfile(index_path):
            print("Aviso: index.html não encontrado; a prévia de compartilhamento não foi gravada.")
        else:
            esc = lambda s: s.replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;").replace(">", "&gt;")
            base = args.site_url.strip().rstrip("/") + "/"
            tags = [
                '<meta property="og:type" content="website">',
                f'<meta property="og:title" content="{esc(title)}">',
                f'<meta property="og:url" content="{esc(base)}">',
                f'<meta property="og:image" content="{esc(base)}book/cover.jpg?v={manifest["version"]}">',
                '<meta property="og:image:width" content="1200">',
                '<meta property="og:image:height" content="630">',
                '<meta name="twitter:card" content="summary_large_image">',
            ]
            if args.description:
                tags.insert(2, f'<meta property="og:description" content="{esc(args.description)}">')
                tags.insert(0, f'<meta name="description" content="{esc(args.description)}">')
            start, end = "<!-- social:start -->", "<!-- social:end -->"
            with open(index_path, encoding="utf-8") as f:
                html = f.read()
            if start in html and end in html:
                block = start + "\n  " + "\n  ".join(tags) + "\n  " + end
                html = html[: html.index(start)] + block + html[html.index(end) + len(end) :]
                html = re.sub(r"<title>.*?</title>", lambda m: f"<title>{esc(title)}</title>", html, count=1, flags=re.S)
                with open(index_path, "w", encoding="utf-8", newline="\n") as f:
                    f.write(html)
                print("Prévia de compartilhamento gravada no index.html.")
            else:
                print("Aviso: marcadores social:start/social:end não encontrados no index.html.")

    n_links = sum(len(v) for v in links.values())
    print(
        f"Pronto em {time.time() - t_start:.0f}s: {n_pages} páginas, {total_bytes / 1e6:.1f} MB de imagens, "
        f"{len(vector_pages)} páginas com texto vetorial, {n_links} links."
    )
    print(f"Saída: {out}")
    print('Para publicar:  git add -A && git commit -m "Atualiza o catálogo" && git push')


if __name__ == "__main__":
    main()
