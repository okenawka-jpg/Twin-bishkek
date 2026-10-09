"""Сборка «настоящего города» из данных OpenStreetMap  →  data/processed/city_real.json

    python build_city.py            →  src/twin_bishkek/city_real.json   (нужны numpy, scipy, scikit-image; сайту и бэкенду они НЕ нужны)

Что делает:
  * контур застроенной части (по плотности дорог), а не вся административная граница;
  * главные улицы (primary/secondary/trunk) нарезаны на отрезки ≤ 350 м, у каждого число полос;
  * 12 районов поставлены по настоящим координатам микрорайонов из OSM;
  * реки Ала-Арча и Аламедин, канал БЧК, мосты = места, где улицы пересекают реки;
  * стадион (координаты из открытого источника).
Всё переводится в «пиксели» схемы: 1 px = 25 м, север сверху.
"""
from __future__ import annotations

import json
import math
import re
from collections import defaultdict
from pathlib import Path

import numpy as np
from scipy import ndimage
from skimage import measure

ROOT = Path(__file__).resolve().parent
OSM = ROOT / "data" / "raw" / "osm"
OUT = ROOT / "src" / "twin_bishkek" / "city_real.json"

# --- проекция -------------------------------------------------------------
LON0, LAT0 = 74.60, 42.875
KX = 111.32 * math.cos(math.radians(LAT0))  # км на градус долготы
KY = 110.57
M_PER_PX = 25.0
HEX_R = 17.0
MAX_PIECE_M = 350.0


def km(lon, lat):
    return (np.asarray(lon, float) - LON0) * KX, (np.asarray(lat, float) - LAT0) * KY


def txt(v):
    if isinstance(v, list):
        return ", ".join(str(x) for x in v)
    return "" if v is None else str(v)


def read(name):
    return json.loads((OSM / f"{name}.geojson").read_text(encoding="utf-8"))["features"]


# --- улицы: нормализация названий ----------------------------------------
_TR = str.maketrans({"ү": "у", "ө": "о", "ң": "н", "ё": "е"})
_STOP = ("проспекти", "проспектисы", "проспект", "көчөсү", "улица", "бульвары", "бульвар", "тар", "переулок")

# ключ → (id улицы, как подписывать на карте). Остальные улицы получают id из названия.
KNOWN = {
    "чуй": ("chuy", "пр. Чуй"),
    "манас": ("manas", "ул. Манаса"),
    "жибек жолу": ("zhibek", "пр. Жибек Жолу"),
    "иса ахунбаев": ("akhunbaev", "ул. Ахунбаева"),
    "ахунбаева исы": ("akhunbaev", "ул. Ахунбаева"),
    "чынгыз айтматов": ("aitmatov", "пр. Айтматова"),
    "чингиза айтматова": ("aitmatov", "пр. Айтматова"),
    "аалы токомбаев": ("tokombaev", "пр. Токомбаева"),
    "жусуп абдрахманов": ("abdrakhmanov", "ул. Абдрахманова"),
    "дең сяопиң": ("dengxiaoping", "пр. Дэн Сяопина"),
    "шабдан баатыр": ("shabdan", "ул. Шабдан Баатыра"),
    "анкара": ("ankara", "ул. Анкара"),
}


# Места притяжения. Координаты: карточки 2ГИС (скриншоты пользователя, 07.10.2026).
#   «Евразия»  — из адресной строки (центр парка), площадь по полигону 2ГИС 10.4 га;
#   «Бишкек Арена» и «Асман Парк» — по положению на карте (масштаб проверен по проспекту Токомбаева из OSM), точность ±30–100 м.
#   Старый стадион: 42°52'29.17"N 74°35'31.54"E (открытый источник). Вместимость: 23 000 (Омурзакова), 51 000 («Бишкек Арена»).
VENUES_SRC = [
    dict(id="omurzakov", kind="stadium", name="Стадион им. Омурзакова", lon=74 + 35 / 60 + 31.54 / 3600, lat=42 + 52 / 60 + 29.17 / 3600, capacity=23000),
    dict(id="arena", kind="stadium", name="Бишкек Арена", lon=74.52459, lat=42.82757, capacity=51000),
    dict(id="eurasia", kind="park", name="Парк «Евразия»", lon=74.52073, lat=42.82762, ha=10.4),
    dict(id="asman", kind="park", name="Асман Парк", lon=74.61946, lat=42.81876),
]


# Время суток (множители к «Сегодня» = среднесуточному дню; индекс = час 0…23).
#   traffic — ДОПУЩЕНИЕ по описанию местного жителя: утренний пик, обеденный всплеск, вечерний пик после работы, к 22:00 пробки заканчиваются.
#           Нормировано так, что средняя нагрузка, которую «чувствуют» поездки, равна 1. Измерений нет.
#   air — РЕАЛЬНЫЙ суточный ритм PM2.5 из датчиков OpenAQ (зима: янв–мар 2025–2026, лето: июн–авг 2025), сглажен по 3 часа.
#         Вечером и ночью воздух хуже всего (зимой в 22:00 ≈ ×1.4), днём лучше (≈ ×0.75). Летом данных меньше, профиль менее надёжен.
TIME = {
    "traffic": [
     0.232,
     0.167,
     0.14,
     0.14,
     0.186,
     0.372,
     0.696,
     1.115,
     1.346,
     1.207,
     0.929,
     0.882,
     0.975,
     1.067,
     0.929,
     0.929,
     1.115,
     1.346,
     1.393,
     1.207,
     0.929,
     0.696,
     0.464,
     0.325
    ],
    "air": {
     "winter": [
      1.306,
      1.225,
      1.106,
      0.972,
      0.894,
      0.836,
      0.813,
      0.843,
      0.874,
      0.914,
      0.875,
      0.838,
      0.784,
      0.773,
      0.753,
      0.766,
      0.814,
      0.91,
      1.069,
      1.213,
      1.326,
      1.376,
      1.363,
      1.357
     ],
     "summer": [
      1.187,
      1.17,
      1.141,
      1.083,
      1.032,
      1.014,
      1.029,
      1.052,
      1.027,
      0.977,
      0.918,
      0.86,
      0.806,
      0.754,
      0.734,
      0.738,
      0.753,
      0.774,
      0.842,
      1.037,
      1.243,
      1.338,
      1.286,
      1.206
     ]
    }
}


def norm_name(raw: str) -> str:
    n = raw.split(",")[0].strip().lower().translate(_TR)
    for w in _STOP:
        n = re.sub(rf"\b{w}\b", " ", n)
    return re.sub(r"\s+", " ", n).strip()


def display_label(raw: str) -> str:
    """«Курманжан датка көчөсү» → «ул. Курманжан датка»: короче и по-русски."""
    n = raw.split(",")[0].strip()
    for suf, pre in (("көчөсү", "ул. "), ("проспекти", "пр. "), ("бульвары", "бул. ")):
        if n.endswith(suf):
            return pre + n[: -len(suf)].strip()
    return n


def street_key(raw: str):
    n = norm_name(raw)
    if not n:
        return "other", None
    for k, (sid, label) in KNOWN.items():
        kk = norm_name(k)
        if n == kk or n.startswith(kk + " ") or n.endswith(" " + kk):
            return sid, label
    slug = re.sub(r"[^a-z0-9]+", "-", n.translate(str.maketrans("абвгдеёжзийклмнопрстуфхцчшщъыьэюя", "abvgdeejzijklmnoprstufhccss_y_eua"))).strip("-")
    return ("s-" + slug) if slug else "other", display_label(raw)


# --- читаем дороги ---------------------------------------------------------
def load_roads():
    out = []
    for f in read("roads"):
        p = f["properties"]
        hw = txt(p.get("highway")).split(", ")[0]
        c = np.array(f["geometry"]["coordinates"], float)
        out.append(dict(u=p.get("u"), v=p.get("v"), name=txt(p.get("name")), hw=hw, lanes=txt(p.get("lanes")),
                        maxspeed=txt(p.get("maxspeed")), oneway=txt(p.get("oneway")).lower() == "true", pts=c))
    return out


def lanes_line(e) -> float:
    """Число полос нарисованной линии: двусторонняя улица — обе стороны вместе, односторонняя — её полосы."""
    m = re.match(r"\d+", e["lanes"].split(";")[0].split(",")[0].strip()) if e["lanes"] and e["lanes"] != "None" else None
    if m:
        return float(int(m.group()))
    base = {"trunk": 3.0, "primary": 2.0, "secondary": 1.5}.get(e["hw"], 1.0)  # нет данных → типично для класса
    return base if e["oneway"] else base * 2


def dedupe_two_way(edges):
    """osmnx пишет двустороннюю улицу двумя строками (u→v и v→u). Оставляем одну: она описывает обе стороны."""
    seen, out = set(), []
    for e in edges:
        if not e["oneway"]:
            key = frozenset((e["u"], e["v"]))
            if key in seen:
                continue
            seen.add(key)
        out.append(e)
    return out


# --- контур застроенной части ---------------------------------------------
def build_outline(roads):
    cell = 0.5
    boundary = [np.array(r) for f in read("boundary") for r in
                (f["geometry"]["coordinates"] if f["geometry"]["type"] == "Polygon"
                 else [ring for poly in f["geometry"]["coordinates"] for ring in poly[:1]])]
    # плотность дорог по клеткам
    xs = np.concatenate([km(r["pts"][:, 0], r["pts"][:, 1])[0] for r in roads])
    ys = np.concatenate([km(r["pts"][:, 0], r["pts"][:, 1])[1] for r in roads])
    x0, y0 = math.floor(xs.min() / cell) - 2, math.floor(ys.min() / cell) - 2
    nx, ny = math.ceil(xs.max() / cell) + 3 - x0, math.ceil(ys.max() / cell) + 3 - y0
    dens = np.zeros((ny, nx))
    for r in roads:
        x, y = km(r["pts"][:, 0], r["pts"][:, 1])
        for i in range(len(x) - 1):
            L = math.hypot(x[i + 1] - x[i], y[i + 1] - y[i])
            cx, cy = int(((x[i] + x[i + 1]) / 2) // cell) - x0, int(((y[i] + y[i + 1]) / 2) // cell) - y0
            dens[cy, cx] += L
    mask = dens >= 1.0
    # только внутри административной границы
    inside = np.zeros_like(mask)
    gx = (np.arange(nx) + x0 + 0.5) * cell
    gy = (np.arange(ny) + y0 + 0.5) * cell
    for ring in boundary:
        bx, by = km(ring[:, 0], ring[:, 1])
        from matplotlib.path import Path as MPath
        P = MPath(np.column_stack([bx, by]))
        XX, YY = np.meshgrid(gx, gy)
        inside |= P.contains_points(np.column_stack([XX.ravel(), YY.ravel()])).reshape(inside.shape)
    mask &= inside
    mask = ndimage.binary_closing(mask, structure=np.ones((3, 3)), iterations=2)
    mask = ndimage.binary_fill_holes(mask)
    lab, n = ndimage.label(mask)
    sizes = ndimage.sum(mask, lab, range(1, n + 1))
    mask = lab == (1 + int(np.argmax(sizes)))
    soft = ndimage.gaussian_filter(mask.astype(float), 1.0)
    cont = max(measure.find_contours(np.pad(soft, 1), 0.45), key=len)
    cont = measure.approximate_polygon(cont, tolerance=0.45)
    # индексы клеток → км
    poly_km = np.column_stack([(cont[:, 1] - 1 + x0 + 0.5) * cell, (cont[:, 0] - 1 + y0 + 0.5) * cell])
    return poly_km, mask, (x0, y0, cell)


def point_in_poly(x, y, poly):
    inside = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


# --- нарезка улиц на отрезки ------------------------------------------------
def chains_of(edges):
    """Склеивает рёбра одной улицы в цепочки по общим узлам (u, v), только через узлы степени 2."""
    inc = defaultdict(list)
    for i, e in enumerate(edges):
        inc[e["u"]].append(i)
        inc[e["v"]].append(i)
    used, chains = set(), []
    for s in range(len(edges)):
        if s in used:
            continue
        used.add(s)
        seq = [(s, False)]  # (индекс ребра, развёрнуто ли)
        for direction in (0, 1):
            cur, rev = (seq[-1] if direction == 0 else seq[0])
            while True:
                e = edges[cur]
                end = (e["u"] if rev else e["v"]) if direction == 0 else (e["v"] if rev else e["u"])
                nxt = [k for k in inc[end] if k != cur]
                if len(inc[end]) != 2 or len(nxt) != 1 or nxt[0] in used:
                    break
                k = nxt[0]
                used.add(k)
                ek = edges[k]
                if direction == 0:
                    rk = ek["v"] == end  # следующее ребро должно начинаться с узла end
                    seq.append((k, rk))
                else:
                    rk = ek["u"] == end  # предыдущее должно заканчиваться в узле end
                    seq.insert(0, (k, rk))
                cur, rev = k, rk
        chains.append(seq)
    return chains


def polyline_of(edges, seq):
    """Ломаная цепочки + число полос на каждом её подотрезке."""
    pts, seg_lanes = [], []
    for k, rev in seq:
        c = edges[k]["pts"][::-1] if rev else edges[k]["pts"]
        pts.append(c if not pts else c[1:])
        seg_lanes.extend([lanes_line(edges[k])] * (len(c) - 1))
    return np.vstack(pts), np.array(seg_lanes)


def cut_pieces(P_km, seg_lanes, max_len_km):
    """Режет ломаную на равные отрезки ≤ max_len; для каждого возвращает концы (км) и среднее число полос."""
    seg = np.hypot(np.diff(P_km[:, 0]), np.diff(P_km[:, 1]))
    cum = np.concatenate([[0], np.cumsum(seg)])
    L = cum[-1]
    if L < 1e-6:
        return []
    n = max(1, math.ceil(L / max_len_km))
    cuts = np.linspace(0, L, n + 1)
    xs = np.interp(cuts, cum, P_km[:, 0])
    ys = np.interp(cuts, cum, P_km[:, 1])
    out = []
    for i in range(n):
        lo, hi = cuts[i], cuts[i + 1]
        ov = np.clip(np.minimum(cum[1:], hi) - np.maximum(cum[:-1], lo), 0, None)  # пересечение подотрезков с куском
        lanes = float((ov * seg_lanes).sum() / ov.sum()) if ov.sum() > 0 else float(seg_lanes[0])
        out.append((xs[i], ys[i], xs[i + 1], ys[i + 1], round(lanes * 2) / 2))  # шаг 0.5 полосы
    return out


def main():
    roads = load_roads()
    poly_km, mask, (mx0, my0, mcell) = build_outline(roads)

    # границы схемы в пикселях
    pad = 60  # px
    xmin, xmax = poly_km[:, 0].min() * 1000 / M_PER_PX, poly_km[:, 0].max() * 1000 / M_PER_PX
    ymin, ymax = poly_km[:, 1].min() * 1000 / M_PER_PX, poly_km[:, 1].max() * 1000 / M_PER_PX
    W, H = int(math.ceil(xmax - xmin + 2 * pad)), int(math.ceil(ymax - ymin + 2 * pad))

    def px(x_km, y_km):
        return (x_km * 1000 / M_PER_PX - xmin + pad, ymax - y_km * 1000 / M_PER_PX + pad)

    def px_ll(lon, lat):
        x, y = km(lon, lat)
        return px(float(x), float(y))

    def inv(X, Y):  # пиксели → (lon, lat)
        xk = (X + xmin - pad) * M_PER_PX / 1000
        yk = (ymax + pad - Y) * M_PER_PX / 1000
        return LON0 + xk / KX, LAT0 + yk / KY

    outline = [[round(a, 1), round(b, 1)] for a, b in (px(x, y) for x, y in poly_km)]

    # --- главные улицы
    inside = lambda lon, lat: point_in_poly(*[float(v) for v in km(lon, lat)], poly_km)  # noqa: E731
    arterial = []
    for e in dedupe_two_way(roads):
        if e["hw"] not in ("trunk", "primary", "secondary"):
            continue
        mid = e["pts"][len(e["pts"]) // 2]
        if inside(mid[0], mid[1]):
            e["sid"], e["label"] = street_key(e["name"])
            arterial.append(e)
    by_street = defaultdict(list)
    for e in arterial:
        by_street[e["sid"]].append(e)

    VC = {"trunk": 0.90, "primary": 0.86, "secondary": 0.74}  # базовая загрузка V/C по классу (допущение, не измерение)
    streets, labels_src = [], {}
    for sid, edges in by_street.items():
        for seq in chains_of(edges):
            P_all, seg_lanes = polyline_of(edges, seq)
            hw = edges[seq[0][0]]["hw"]
            x, y = km(P_all[:, 0], P_all[:, 1])
            for (x1, y1, x2, y2, ln) in cut_pieces(np.column_stack([x, y]), seg_lanes, MAX_PIECE_M / 1000):
                (X1, Y1), (X2, Y2) = px(x1, y1), px(x2, y2)
                if math.hypot(X2 - X1, Y2 - Y1) < 1.0:  # вырожденный отрезок (< 25 м) не нужен
                    continue
                streets.append(dict(id=sid, pts=[[round(X1, 1), round(Y1, 1)], [round(X2, 1), round(Y2, 1)]],
                                    vc=VC[hw], lanes=max(1.0, ln), hw=hw))
            labels_src.setdefault(sid, []).append((P_all, edges[seq[0][0]]["label"]))
    print(f"улиц-групп: {len(by_street)}, отрезков: {len(streets)}")

    # подписи: для самых длинных именованных улиц
    street_len = {sid: sum(float(np.hypot(*np.diff(np.column_stack(km(P[:, 0], P[:, 1])), axis=0).T).sum()) for P, _ in v)
                  for sid, v in labels_src.items()}
    street_labels = []
    for sid, L in sorted(street_len.items(), key=lambda kv: -kv[1]):
        if sid == "other" or len(street_labels) >= 10:
            continue
        P, label = max(labels_src[sid], key=lambda t: len(t[0]))
        if not label:
            continue
        mid = P[len(P) // 2]
        X, Y = px_ll(mid[0], mid[1])
        a, b = P[max(0, len(P) // 2 - 3)], P[min(len(P) - 1, len(P) // 2 + 3)]
        (xa, ya), (xb, yb) = px_ll(a[0], a[1]), px_ll(b[0], b[1])
        rot = math.degrees(math.atan2(yb - ya, xb - xa))
        rot = rot + 180 if rot > 90 else rot - 180 if rot < -90 else rot
        street_labels.append(dict(id=sid, name=label, x=round(X, 1), y=round(Y - 4, 1), rot=round(rot, 1), km=round(L, 1)))
    print("подписи:", [(s["name"], s["km"]) for s in street_labels])

    # --- центр, районы, стадион
    chuy = np.vstack([e["pts"] for e in roads if norm_name(e["name"]) == "чуй"])
    erk = np.vstack([e["pts"] for e in roads if norm_name(e["name"]) == "эркиндик"])
    d = np.hypot(chuy[:, None, 0] - erk[None, :, 0], chuy[:, None, 1] - erk[None, :, 1])
    i, j = np.unravel_index(d.argmin(), d.shape)
    c_lon, c_lat = (chuy[i] + erk[j]) / 2
    CENTER = px_ll(c_lon, c_lat)

    places = read("places")

    def centroid(g):
        t = g["type"]
        if t == "Point":
            return np.array(g["coordinates"][:2], float)
        ring = np.array(g["coordinates"][0] if t == "Polygon" else g["coordinates"][0][0], float)
        return ring[:, :2].mean(0)

    def find(*subs, kinds=None):
        out = []
        for f in places:
            nm = (f["properties"].get("name") or f["properties"].get("name:ru") or "")
            if any(s.lower() in nm.lower() for s in subs):
                out.append(centroid(f["geometry"]))
        return np.array(out)

    anchors = {  # id → (лон, лат) по данным OSM; None → ниже
        "akordo": find("Ак-Ордо жилмассив"), "archa": find("Арча-Бешик"), "alamedin": find("Аламедин-1"),
        "vostok": find("Восток-5"), "tunguch": find("Тунгуч"), "asanbay": find("Асанбай"),
        "kokjar": find("Кок-Жар микрорайон"), "north": find("Дордой"), "jal": find("Джал-23", "Жал-15"), "uchkun": find("Учкун"),
        "south": find("Юг-2"),
    }
    pts = {k: v.mean(0) for k, v in anchors.items() if len(v)}
    missing = [k for k, v in anchors.items() if not len(v)]
    if missing:
        raise SystemExit(f"не нашёл микрорайоны в places.geojson: {missing}")
    pts["center"] = np.array([c_lon, c_lat])
    # «Запад»: центр тяжести школ/поликлиник в западной части ядра города
    soc = []
    for f in read("social"):
        c = centroid(f["geometry"])
        x, y = km(c[0], c[1])
        if -6.0 <= x <= -1.5 and -2.5 <= y <= 2.5:
            soc.append(c)
    pts["west"] = np.array(soc).mean(0)

    DIST_DEMO = {  # демо-характеристики районов (население, частный сектор, зелень, нагрузка школ/поликлиник)
        "center": ("Центр", 120, .05, 14, .86, .90), "west": ("Запад", 110, .25, 7, .95, .94),
        "akordo": ("Ак-Ордо", 60, .85, 4, 1.04, 1.02), "archa": ("Арча-Бешик", 55, .80, 4, 1.02, .98),
        "uchkun": ("Учкун", 50, .70, 5, .97, .95), "alamedin": ("Аламедин-1", 75, .30, 8, .93, .90),
        "vostok": ("Восток-5", 70, .15, 9, .96, .92), "tunguch": ("Тунгуч", 65, .20, 8, .98, .93),
        "asanbay": ("Асанбай", 85, .10, 10, .99, .95), "kokjar": ("Кок-Жар", 55, .45, 6, .94, .92),
        "jal": ("Джал", 95, .15, 9, .98, .94), "south": ("Юг-2", 80, .20, 8, .96, .93),
        "north": ("Дордой", 60, .35, 3, 1.00, .97),
    }
    districts = []
    for did, (name, pop, priv, green, school, clinic) in DIST_DEMO.items():
        X, Y = px_ll(*pts[did])
        districts.append(dict(id=did, name=name, x=round(X, 1), y=round(Y, 1), pop=pop, priv=priv, green=green,
                              school=school, clinic=clinic))

    # Стадион им. Долона Омурзакова: 42°52'29.17"N 74°35'31.54"E (открытый источник, проверьте при желании)
    s_lon, s_lat = 74 + 35 / 60 + 31.54 / 3600, 42 + 52 / 60 + 29.17 / 3600
    SX, SY = px_ll(s_lon, s_lat)

    venues = []
    for v in VENUES_SRC:
        VX, VY = px_ll(v["lon"], v["lat"])
        venues.append({**{k: x for k, x in v.items() if k not in ("lon", "lat")}, "x": round(VX, 1), "y": round(VY, 1)})
    print("места:", [(v["name"], v["x"], v["y"]) for v in venues])

    # --- реки и канал
    water = read("water")

    def runs_in_frame(line):
        """Линия в пикселях, разрезанная на куски, целиком лежащие в кадре (без перескоков через пустоту)."""
        x, y = km(line[:, 0], line[:, 1])
        runs, cur = [], []
        for xx, yy in zip(x, y):
            X, Y = px(float(xx), float(yy))
            if -20 <= X <= W + 20 and -20 <= Y <= H + 20:
                cur.append([round(X, 1), round(Y, 1)])
            else:
                if len(cur) > 1:
                    runs.append(cur)
                cur = []
        if len(cur) > 1:
            runs.append(cur)
        return runs

    def plen(run):
        return sum(math.hypot(run[i + 1][0] - run[i][0], run[i + 1][1] - run[i][1]) for i in range(len(run) - 1))

    def parts_named(name, kind):
        return [np.array(f["geometry"]["coordinates"], float) for f in water
                if (f["properties"].get("name") or "") == name and f["properties"].get("waterway") == kind
                and f["geometry"]["type"] == "LineString"]

    rivers, river_lines_ll = [], {}
    for rid, nm, shown in (("alaarcha", "Ала-Арча", "Ала-Арча"), ("alamedin", "Аламүдүн", "Аламедин")):
        parts = parts_named(nm, "river")
        river_lines_ll[rid] = parts
        runs = sorted([r for p in parts for r in runs_in_frame(p)], key=plen, reverse=True)
        for k, run in enumerate(runs):
            item = dict(id=rid, name=shown, pts=run)
            if k == 0:  # подпись только на самом длинном куске
                mid = run[int(len(run) * 0.7)]
                item["label"] = dict(x=round(mid[0] + 14, 1), y=mid[1], rot=-84)
            rivers.append(item)

    canals = []
    for k, nm in enumerate(("Чоң Чүй каналы", "Чыгыш Чоң Чүй каналы", "Түштүк Чоң Чүй каналы", "Орто Чоң Чүй каналы")):
        runs = sorted([r for p in parts_named(nm, "canal") for r in runs_in_frame(p)], key=plen, reverse=True)
        for j, run in enumerate(runs):
            item = dict(id="bchk%d" % k, name="БЧК", pts=run)
            if k == 0 and j == 0:
                mid = run[len(run) // 2]
                item["label"] = dict(x=mid[0], y=round(mid[1] - 8, 1))
            canals.append(item)
    print("реки (кусков):", len(rivers), "| канал (кусков):", len(canals))

    # --- мосты: пересечения улиц с реками
    def seg_inter(p1, p2, p3, p4):
        d1, d2 = p2 - p1, p4 - p3
        den = d1[0] * d2[1] - d1[1] * d2[0]
        if abs(den) < 1e-12:
            return None
        t = ((p3[0] - p1[0]) * d2[1] - (p3[1] - p1[1]) * d2[0]) / den
        u = ((p3[0] - p1[0]) * d1[1] - (p3[1] - p1[1]) * d1[0]) / den
        return (p1 + t * d1) if 0 <= t <= 1 and 0 <= u <= 1 else None

    crossings = defaultdict(list)  # река → [(улица, x_px, y_px)]
    for rid, parts in river_lines_ll.items():
        for part in parts:
            for a in range(len(part) - 1):
                for e in arterial:
                    if e["hw"] not in ("primary", "secondary", "trunk") or e["sid"] == "other":
                        continue
                    E = e["pts"]
                    if (min(part[a][0], part[a + 1][0]) > E[:, 0].max() or max(part[a][0], part[a + 1][0]) < E[:, 0].min()
                            or min(part[a][1], part[a + 1][1]) > E[:, 1].max() or max(part[a][1], part[a + 1][1]) < E[:, 1].min()):
                        continue
                    for b in range(len(E) - 1):
                        pt = seg_inter(part[a], part[a + 1], E[b], E[b + 1])
                        if pt is not None:
                            crossings[rid].append((e["sid"], *px_ll(pt[0], pt[1])))
    bridges = {}
    main_pref = ["chuy", "akhunbaev", "zhibek", "aitmatov", "manas"]
    for rid, shown in (("alaarcha", "через Ала-Арчу"), ("alamedin", "через Аламедин")):
        cr = [c for c in crossings[rid] if 0 <= c[1] <= W and 0 <= c[2] <= H]
        if not cr:
            continue
        best = None
        for pref in main_pref:
            cands = [c for c in cr if c[0] == pref]
            if cands:
                best = min(cands, key=lambda c: math.hypot(c[1] - CENTER[0], c[2] - CENTER[1]))
                break
        best = best or min(cr, key=lambda c: math.hypot(c[1] - CENTER[0], c[2] - CENTER[1]))
        others = {}
        for sid, X, Y in cr:
            if sid == best[0]:
                continue
            dd = math.hypot(X - best[1], Y - best[2])
            if sid not in others or dd < others[sid][0]:
                others[sid] = (dd, X, Y)
        alt = sorted(others.items(), key=lambda kv: kv[1][0])[:2]
        shares = [0.6, 0.4] if len(alt) == 2 else [1.0]
        bridges[rid] = dict(name=shown, street=best[0], x=round(best[1], 1), y=round(best[2], 1),
                            alt=[[sid, s] for (sid, _), s in zip(alt, shares)])
    print("мосты:", {k: (v["street"], v["alt"]) for k, v in bridges.items()})

    # --- перекрытия: три главные улицы + две ближайшие параллельные
    def axis_angle(sid):
        pts_ = np.array([[(s["pts"][0][0] + s["pts"][1][0]) / 2, (s["pts"][0][1] + s["pts"][1][1]) / 2] for s in streets if s["id"] == sid])
        if len(pts_) < 3:
            return None, None
        c = pts_.mean(0)
        u, s_, vt = np.linalg.svd(pts_ - c)
        return c, vt[0]

    closures = {}
    nice = {sid: label for sid, label in KNOWN.values()}
    cand_ids = [sid for sid, L in sorted(street_len.items(), key=lambda kv: -kv[1]) if sid != "other" and L > 5]
    for sid in ("chuy", "zhibek", "akhunbaev", "aitmatov"):
        if sid not in street_len:
            continue
        c0, ax0 = axis_angle(sid)
        scored = []
        for other in cand_ids:
            if other == sid:
                continue
            c1, ax1 = axis_angle(other)
            if c1 is None or abs(float(ax0 @ ax1)) < 0.9:  # только параллельные
                continue
            nrm = np.array([-ax0[1], ax0[0]])
            scored.append((abs(float((c1 - c0) @ nrm)), other))
        scored.sort()
        closures[sid] = dict(name=nice[sid], parallels=[o for _, o in scored[:2]])
    print("перекрытия:", closures)

    data = dict(
        W=W, H=H, CENTER=dict(x=round(CENTER[0], 1), y=round(CENTER[1], 1)), OUTLINE=outline,
        GRID=dict(R=HEX_R, x0=24, y0=24, xmax=W - 24, ymax=H - 24),
        DISTRICTS=districts, STREETS=streets, STREET_LABELS=street_labels,
        RIVERS=rivers, CANALS=canals, STADIUM=dict(x=round(SX, 1), y=round(SY, 1), name="Стадион им. Долона Омурзакова"),
        BRIDGES=bridges, CLOSURES=closures, VENUES=venues, TIME=TIME,
        GEO=dict(lon0=LON0, lat0=LAT0, kx=KX, ky=KY, m_per_px=M_PER_PX, xmin=xmin, ymax=ymax, pad=pad),
    )
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"готово: {OUT} ({OUT.stat().st_size // 1024} КБ), схема {W}×{H} px")


if __name__ == "__main__":
    main()
