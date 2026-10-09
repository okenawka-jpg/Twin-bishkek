"""Город: настоящая геометрия из OpenStreetMap + справочники.

Геометрию собирает `build_city.py` и кладёт в `city_real.json` (рядом с этим файлом).
Здесь она только читается. Единицы: «пиксели» схемы, 1 px = 25 м, север сверху.
`to_lonlat` переводит их обратно в градусы, чтобы рисовать на карте с подложкой.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

_PATH = Path(__file__).with_name("city_real.json")
if not _PATH.exists():
    raise FileNotFoundError(
        f"Нет файла {_PATH.name}. Положите его в src/twin_bishkek/ (его делает build_city.py из данных OSM)."
    )
_D = json.loads(_PATH.read_text(encoding="utf-8"))

W, H = _D["W"], _D["H"]
CENTER = (float(_D["CENTER"]["x"]), float(_D["CENTER"]["y"]))
OUTLINE = [tuple(p) for p in _D["OUTLINE"]]
GRID = _D["GRID"]
DISTRICTS = _D["DISTRICTS"]
DISTRICT_BY_ID = {d["id"]: d for d in DISTRICTS}
STREETS = _D["STREETS"]  # отрезки главных улиц: id, pts (2 точки), vc, lanes, hw
STREET_LABELS = _D["STREET_LABELS"]
RIVERS, CANALS = _D["RIVERS"], _D["CANALS"]
STADIUM = _D["STADIUM"]
VENUES = _D["VENUES"]  # места притяжения: стадионы (с вместимостью) и парки
STADIUMS = {v["id"]: v for v in VENUES if v["kind"] == "stadium"}
DEFAULT_VENUE = "omurzakov"

# Стройка и расширение улиц: ДОПУЩЕНИЯ, данных для проверки нет.
#   во время стройки: приезжает техника (доля трафика готового объекта), рядом сужается проезд, в воздухе пыль; жителей ещё нет;
#   после: работает обычное поведение объекта (жители, трафик, зелень).
BUILD = dict(traffic_k=0.6, min_traffic=0.05, cap_loss=0.2, dust=0.05)
WIDEN = 0.5  # «новая магистраль вдоль улицы»: +50% ёмкости (например, 4 → 6 полос) на центральном участке
REF_CAPACITY = 23000  # вместимость, при которой матч даёт базовую добавку потока 0.35
BRIDGES = _D["BRIDGES"]
CLOSURES = _D["CLOSURES"]
GEO = _D["GEO"]
TIME = _D["TIME"]  # суточные профили: traffic[час], air[сезон][час]

OBJECT_TYPES = {
    "jk": dict(name="ЖК", residents=4000, traffic=.08),
    "tc": dict(name="ТЦ", residents=0, traffic=.12),
    "park": dict(name="Парк", residents=0, traffic=0.0, green_per_person=1.5, pm_local=.06),
    "fun": dict(name="Аттракционы", residents=0, traffic=.10, green_per_person=.5, pm_local=.03),  # парк развлечений: едут машины, но часть территории зелёная
}

PRESETS = [
    dict(id="uc01", code="UC-01", name="Квота на ввоз ДВС", params=dict(fleet=20, ev=5)),
    dict(id="uc02", code="UC-02", name="Три ЖК в Джале", params=dict(objects=[dict(d="jal", t="jk", n=3)])),
    dict(id="uc03", code="UC-03", name="Матч и ремонт моста", params=dict(events=dict(match=True, bridge="alaarcha"))),
    dict(id="uc04", code="UC-04", name="Сокращение зелени", params=dict(green=-15)),
    dict(id="uc05", code="UC-05", name="Худший зимний день",
         params=dict(season="winter", fleet=20, ev=5, green=-10, objects=[dict(d="jal", t="jk", n=2)],
                     events=dict(closure="chuy", match=True))),
    dict(id="uc06", code="UC-06", name="Стройка трёх ЖК в Джале", params=dict(objects=[dict(d="jal", t="jk", n=3, ph="build")])),
    dict(id="uc07", code="UC-07", name="Новая магистраль вдоль Чуя", params=dict(events=dict(widen="chuy"))),
    dict(id="uc08", code="UC-08", name="Вечерний час пик (18:00)", params=dict(hour=18)),
    dict(id="uc09", code="UC-09", name="Зимняя ночь (22:00)", params=dict(season="winter", hour=22)),
]

# Шкала AQI US EPA (редакция 2024), кусочно-линейная
PM_BREAKS = [0, 9.0, 35.4, 55.4, 125.4, 225.4, 325.4]
AQI_BREAKS = [0, 50, 100, 150, 200, 300, 500]
AQI_CATS = ["Хорошо", "Умеренно", "Вредно для чувствительных групп", "Вредно", "Очень вредно", "Опасно"]


def to_lonlat(x: float, y: float) -> tuple[float, float]:
    """Пиксели схемы → (долгота, широта)."""
    g = GEO
    xk = (x + g["xmin"] - g["pad"]) * g["m_per_px"] / 1000
    yk = (g["ymax"] + g["pad"] - y) * g["m_per_px"] / 1000
    return g["lon0"] + xk / g["kx"], g["lat0"] + yk / g["ky"]


def point_in_poly(x: float, y: float, poly) -> bool:
    inside = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def build_grid() -> dict:
    """Шестиугольная сетка odd-r внутри контура; район соты — ближайший центр района с «живым» шумом границ."""
    R = float(GRID["R"])
    w, row_h = math.sqrt(3) * R, 1.5 * R
    hexes: list[dict] = []
    row = 0
    while True:
        y = GRID["y0"] + row * row_h
        if y > GRID["ymax"]:
            break
        col = 0
        while True:
            x = GRID["x0"] + col * w + (w / 2 if row % 2 else 0)
            if x > GRID["xmax"]:
                break
            if point_in_poly(x, y, OUTLINE):
                best, best_d = None, float("inf")
                for k, d in enumerate(DISTRICTS):
                    noise = 14 * math.sin(x * .041 + k * 1.7) * math.cos(y * .037 + k * .9)
                    dist = math.hypot(x - d["x"], y - d["y"]) + noise
                    if dist < best_d:
                        best_d, best = dist, d["id"]
                hexes.append(dict(i=len(hexes), col=col, row=row, x=x, y=y, d=best))
            col += 1
        row += 1
    return dict(R=R, w=w, row_h=row_h, hexes=hexes)


def hex_corner(h: dict, k: int, R: float) -> tuple[float, float]:
    a = math.radians(60 * k - 30)
    return h["x"] + R * math.cos(a), h["y"] + R * math.sin(a)
