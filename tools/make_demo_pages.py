#!/usr/bin/env python3
"""
Gera um livro de demonstração (páginas em SVG) para testar o flipbook
sem precisar de um PDF. Não tem dependências.

    python tools/make_demo_pages.py            # cria book/ com 16 páginas

Para publicar um PDF de verdade, use tools/pdf2book.py.
"""
import json
import math
import os
import sys

W, H = 596, 842
PAGES = 16
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "book")

BLUE = "#2f5fd0"
INK = "#2b2f36"
SOFT = "#6c727c"
PALETTE = ["#2f5fd0", "#1f9d8a", "#e0703a", "#7a4fd1", "#c93f5a", "#2c88b8"]

LOREM = (
    "Este é um texto de demonstração para avaliar a nitidez da tipografia durante a virada "
    "da página e no zoom. Substitua este conteúdo pelo seu catálogo em PDF usando o script "
    "de conversão incluído no projeto. Linhas, tabelas e imagens ajudam a perceber sombras, "
    "brilhos e a dobra do papel em cada etapa da animação."
).split()


def wrap(words, per_line):
    lines, cur = [], []
    for w in words:
        cur.append(w)
        if len(" ".join(cur)) > per_line:
            cur.pop()
            lines.append(" ".join(cur))
            cur = [w]
    if cur:
        lines.append(" ".join(cur))
    return lines


def paragraph(x, y, width_chars, n_words, size=9.2, lh=13.2, color=SOFT, start=0):
    words = [LOREM[(start + i) % len(LOREM)] for i in range(n_words)]
    out = []
    for i, line in enumerate(wrap(words, width_chars)):
        out.append(
            f'<text x="{x}" y="{y + i * lh:.1f}" font-size="{size}" fill="{color}">{line}</text>'
        )
    return "\n".join(out), y + len(wrap(words, width_chars)) * lh


def picture(x, y, w, h, c1, c2, seed, uid):
    """Uma 'foto' abstrata: gradiente + formas, só para ter imagem na página."""
    shapes = []
    for i in range(7):
        a = seed * 1.7 + i * 0.9
        cx = x + w * (0.5 + 0.42 * math.sin(a * 1.3))
        cy = y + h * (0.55 + 0.38 * math.cos(a * 0.8))
        r = min(w, h) * (0.12 + 0.1 * abs(math.sin(a * 2.1)))
        op = 0.10 + 0.12 * abs(math.cos(a))
        shapes.append(f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="{r:.1f}" fill="#fff" opacity="{op:.2f}"/>')
    bars = []
    for i in range(5):
        bh = h * (0.18 + 0.5 * abs(math.sin(seed + i * 1.1)))
        bx = x + w * 0.12 + i * w * 0.16
        bars.append(
            f'<rect x="{bx:.1f}" y="{y + h - bh:.1f}" width="{w * 0.1:.1f}" height="{bh:.1f}" fill="#fff" opacity=".2"/>'
        )
    return f"""
<defs>
  <linearGradient id="g{uid}" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="{c1}"/><stop offset="1" stop-color="{c2}"/>
  </linearGradient>
  <clipPath id="c{uid}"><rect x="{x}" y="{y}" width="{w}" height="{h}" rx="3"/></clipPath>
</defs>
<g clip-path="url(#c{uid})">
  <rect x="{x}" y="{y}" width="{w}" height="{h}" fill="url(#g{uid})"/>
  {''.join(shapes)}
  {''.join(bars)}
</g>"""


def shade(hex_color, k):
    r, g, b = (int(hex_color[i : i + 2], 16) for i in (1, 3, 5))
    f = lambda v: max(0, min(255, int(v * k)))
    return f"#{f(r):02x}{f(g):02x}{f(b):02x}"


def svg(body, bg="#ffffff"):
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" font-family="Arial, Helvetica, sans-serif">
<rect width="{W}" height="{H}" fill="{bg}"/>
{body}
</svg>
"""


def cover():
    body = f"""
<line x1="0" y1="430" x2="{W}" y2="430" stroke="{BLUE}" stroke-width="1"/>
<line x1="448" y1="0" x2="448" y2="{H}" stroke="{BLUE}" stroke-width="1"/>
<g transform="translate(78 330)">
  <path d="M0 34 22 0l22 34H30l-8-13-8 13Z" fill="{BLUE}"/>
  <path d="M10 48h44l-9 14H1Z" fill="{BLUE}" opacity=".7"/>
  <text x="70" y="44" font-size="34" font-weight="700" fill="{INK}" letter-spacing="-.5">Flipbook</text>
</g>
<text x="78" y="478" font-size="19" font-weight="700" fill="{BLUE}">CATÁLOGO DE DEMONSTRAÇÃO</text>
<text x="78" y="504" font-size="19" font-weight="700" fill="{BLUE}">FOLHEIE, DÊ ZOOM E TESTE</text>
<text x="78" y="530" font-size="19" font-weight="700" fill="{BLUE}">NO CELULAR</text>
<g transform="translate(78 760)">
  <path d="M0 0h196l14 12v18H0Z" fill="none" stroke="{BLUE}" stroke-width="1"/>
  <text x="12" y="20" font-size="12" fill="{BLUE}">Arraste o canto da página →</text>
</g>
<text transform="translate(540 800) rotate(-90)" font-size="13" fill="{BLUE}" letter-spacing="1">seu-site.com.br</text>
"""
    return svg(body, "#e6e7ea")


def back_cover():
    body = f"""
<line x1="0" y1="430" x2="{W}" y2="430" stroke="{BLUE}" stroke-width="1"/>
<line x1="148" y1="0" x2="148" y2="{H}" stroke="{BLUE}" stroke-width="1"/>
<text x="190" y="380" font-size="26" font-weight="700" fill="{INK}">Obrigado!</text>
<text x="190" y="408" font-size="12" fill="{SOFT}">Este é o fim do catálogo de demonstração.</text>
<text x="190" y="470" font-size="12" fill="{BLUE}">contato@seu-site.com.br</text>
<text x="190" y="490" font-size="12" fill="{BLUE}">+55 (00) 0000-0000</text>
"""
    return svg(body, "#e6e7ea")


def content(n):
    color = PALETTE[n % len(PALETTE)]
    dark = shade(color, 0.72)
    right = n % 2 == 1  # páginas ímpares ficam à direita
    mx = 46
    parts = []
    uid = n * 10

    # cabeçalho
    parts.append(f'<line x1="{mx}" y1="52" x2="{W - mx}" y2="52" stroke="{color}" stroke-width="1"/>')
    parts.append(
        f'<text x="{mx if not right else W - mx}" y="44" font-size="9" fill="{SOFT}" '
        f'text-anchor="{"start" if not right else "end"}" letter-spacing="1.2">CATÁLOGO DEMO · SEÇÃO {(n + 1) // 2:02d}</text>'
    )

    layout = n % 3
    if layout == 0:
        parts.append(f'<rect x="{mx}" y="78" width="{W - 2 * mx}" height="54" fill="{color}"/>')
        parts.append(f'<text x="{mx + 16}" y="113" font-size="22" font-weight="700" fill="#fff">Linha de produtos {n:02d}</text>')
        p, y = paragraph(mx, 166, 46, 52, start=n)
        parts.append(p)
        parts.append(picture(mx + 262, 152, W - 2 * mx - 262, 150, color, dark, n, uid + 1))
        parts.append(f'<rect x="{mx}" y="340" width="{W - 2 * mx}" height="30" fill="{color}"/>')
        parts.append(f'<text x="{mx + 12}" y="360" font-size="13" font-weight="700" fill="#fff">Especificações</text>')
        # tabela
        ty = 388
        cols = [mx, mx + 150, mx + 290, mx + 400]
        heads = ["Modelo", "Capacidade (kg/h)", "Potência (cv)", "Código"]
        parts.append(f'<rect x="{mx}" y="{ty}" width="{W - 2 * mx}" height="20" fill="{dark}"/>')
        for cx, hd in zip(cols, heads):
            parts.append(f'<text x="{cx + 8}" y="{ty + 14}" font-size="8.5" font-weight="700" fill="#fff">{hd}</text>')
        for r in range(6):
            ry = ty + 20 + r * 19
            if r % 2 == 0:
                parts.append(f'<rect x="{mx}" y="{ry}" width="{W - 2 * mx}" height="19" fill="#f1f3f7"/>')
            vals = [f"FX-{n}{r + 1}0", f"{(r + 2) * 1250:,}".replace(",", "."), f"{30 + r * 15} + {20 + r * 5}", f"{n:02d}.{r + 1:03d}.{(n * 37 + r * 11) % 900 + 100}"]
            for cx, v in zip(cols, vals):
                parts.append(f'<text x="{cx + 8}" y="{ry + 13}" font-size="8.5" fill="{INK}">{v}</text>')
        parts.append(picture(mx, 548, W - 2 * mx, 210, dark, color, n + 3, uid + 2))
    elif layout == 1:
        parts.append(f'<text x="{mx}" y="110" font-size="30" font-weight="700" fill="{INK}">Soluções sob medida</text>')
        parts.append(f'<rect x="{mx}" y="124" width="64" height="4" fill="{color}"/>')
        parts.append(picture(mx, 150, W - 2 * mx, 250, color, dark, n * 2, uid + 1))
        p, y = paragraph(mx, 436, 44, 60, start=n * 3)
        parts.append(p)
        p2, _ = paragraph(mx + 262, 436, 44, 60, start=n * 5)
        parts.append(p2)
        for i in range(3):
            bx = mx + i * ((W - 2 * mx + 14) / 3)
            bw = (W - 2 * mx - 28) / 3
            parts.append(f'<rect x="{bx:.1f}" y="640" width="{bw:.1f}" height="118" rx="4" fill="#f3f5f9" stroke="{color}" stroke-width=".8"/>')
            parts.append(f'<circle cx="{bx + 26:.1f}" cy="668" r="13" fill="{color}"/>')
            parts.append(f'<text x="{bx + 26:.1f}" y="672.5" font-size="12" font-weight="700" fill="#fff" text-anchor="middle">{i + 1}</text>')
            parts.append(f'<text x="{bx + 14:.1f}" y="702" font-size="11" font-weight="700" fill="{INK}">Etapa {i + 1}</text>')
            pp, _ = paragraph(bx + 14, 718, 26, 12, size=8, lh=11, start=n + i * 7)
            parts.append(pp)
    else:
        parts.append(picture(mx, 78, 240, 330, color, dark, n * 3, uid + 1))
        parts.append(f'<text x="{mx + 262}" y="104" font-size="24" font-weight="700" fill="{color}">Tecnologia</text>')
        parts.append(f'<text x="{mx + 262}" y="132" font-size="24" font-weight="700" fill="{INK}">e desempenho</text>')
        p, y = paragraph(mx + 262, 164, 42, 78, start=n * 2)
        parts.append(p)
        parts.append(f'<rect x="{mx}" y="440" width="{W - 2 * mx}" height="1" fill="{color}"/>')
        # gráfico de barras
        gx, gy, gw, gh = mx, 474, W - 2 * mx, 170
        parts.append(f'<text x="{gx}" y="{gy - 8}" font-size="11" font-weight="700" fill="{INK}">Eficiência por modelo (%)</text>')
        for i in range(8):
            v = 0.35 + 0.6 * abs(math.sin(n * 0.7 + i * 0.9))
            bw = gw / 8 - 12
            bx = gx + i * (gw / 8) + 6
            parts.append(f'<rect x="{bx:.1f}" y="{gy + gh - v * gh:.1f}" width="{bw:.1f}" height="{v * gh:.1f}" fill="{color}" opacity="{0.55 + 0.45 * v:.2f}"/>')
            parts.append(f'<text x="{bx + bw / 2:.1f}" y="{gy + gh - v * gh - 5:.1f}" font-size="8" fill="{SOFT}" text-anchor="middle">{int(v * 100)}</text>')
            parts.append(f'<text x="{bx + bw / 2:.1f}" y="{gy + gh + 13}" font-size="8" fill="{SOFT}" text-anchor="middle">M{i + 1}</text>')
        parts.append(f'<line x1="{gx}" y1="{gy + gh}" x2="{gx + gw}" y2="{gy + gh}" stroke="{INK}" stroke-width=".8"/>')
        p3, _ = paragraph(mx, 690, 92, 58, start=n * 4)
        parts.append(p3)

    # rodapé com número da página
    fx = W - mx - 26 if right else mx
    parts.append(f'<path d="M{fx} 788h26v20h-20l-6-6Z" fill="{color}"/>')
    parts.append(f'<text x="{fx + 13}" y="802" font-size="10" font-weight="700" fill="#fff" text-anchor="middle">{n}</text>')
    parts.append(
        f'<text x="{fx - 12 if right else fx + 38}" y="802" font-size="11" font-weight="700" fill="{INK}" '
        f'text-anchor="{"end" if right else "start"}">Flipbook Demo</text>'
    )
    return svg("\n".join(parts))


def main():
    pages_dir = os.path.join(OUT, "pages")
    os.makedirs(pages_dir, exist_ok=True)
    for n in range(1, PAGES + 1):
        if n == 1:
            s = cover()
        elif n == PAGES:
            s = back_cover()
        else:
            s = content(n)
        with open(os.path.join(pages_dir, f"{n}.svg"), "w", encoding="utf-8") as f:
            f.write(s)
    manifest = {
        "title": "Flipbook Demo",
        "pages": PAGES,
        "pageWidth": W,
        "pageHeight": H,
        "sizes": [{"width": W, "vector": True, "path": "pages/{n}.svg"}],
        "links": {str(PAGES): [{"x": 31.5, "y": 54.3, "w": 30, "h": 2.6, "url": "https://github.com"}]},
    }
    with open(os.path.join(OUT, "book.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print(f"OK: {PAGES} páginas de demonstração em {os.path.normpath(OUT)}")


if __name__ == "__main__":
    sys.exit(main())
