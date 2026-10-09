"""Модель каскада: Решение → Трафик (BPR) → PM2.5 → AQI → Комфорт района.

Один в один перенос design/prototype/js/model.js. Все параметры демо-калибровки, их
надо заменить реальными (см. ml.py / calibrate). Чистая функция simulate(params) без
скрытого состояния: одинаковый вход → одинаковый выход.
"""
from __future__ import annotations

import math
import time
from dataclasses import dataclass, field

import numpy as np

from . import city as C

P = dict(
    bpr_alpha=0.5, bpr_beta=4.0, f_cap=3.5,  # BPR: t = t0·(1 + α·(V/C)^β)
    peak_k=0.3,             # сжатие часа пик: поток выше среднесуточного берём на 30% (подгонка к индексу 2GIS ≈4/10 в 18:00, демо)
    hour_k=1.27,            # общий множитель почасового профиля: среднее по 24 часам остаётся ≈8.4 мин, как у «Сегодня»
    vc_scale=1.052,         # общий множитель базовой загрузки улиц: подгонка средней задержки лета к 8.4 мин (демо-цель)
    ref_lanes=4.0,          # полос у «эталонной» улицы: ёмкость отрезка = lanes / ref_lanes
    bridge_r=16.0,          # px: радиус вокруг моста, внутри которого улица закрывается (оба направления)
    T0=22.0,                # мин — средняя поездка без заторов
    V0=40.0,                # км/ч — скорость свободного потока
    base_ev=5.0,            # % EV в парке сегодня
    sigma_i=55.0, cut_i=150.0,
    tp_summer_p95=19.9,     # мкг/м³ транспортного PM2.5 у самых нагруженных сот летом (подогнано под датчики OpenAQ: лето ≈ 14)
    bg_summer=(4.0, 4.0),   # фон = a + b × доля частного сектора
    bg_winter=(20.0, 100.0),
    winter_traffic=2.27,      # зимой выхлоп «залипает» у земли (инверсия, холодные пуски): подогнано, чтобы зима осталась ≈ 70
    green_k=0.4,
    green_norm=16.0,
    weights=dict(air=0.35, road=0.25, green=0.2, social=0.2),
)

# Новые дороги через город (ДОПУЩЕНИЯ, демонстрационные; один в один с P.road в site/js/model.js):
#   cap — ёмкость полосы к обычной улице (нет светофоров → больше), time — время в пути к обычной улице,
#   attract — доля потока близких параллельных улиц, которую забирает дорога, emit — выхлоп вдоль трассы
#   (у тоннеля 0: доля portal выходит у порталов), cross — ёмкость пересекаемых улиц (новые светофоры).
ROAD = dict(
    max=3, seg_len=70.0, reach=50.0, cut=150.0, base_use=0.25, induced=0.1, fill=0.9,
    kinds=dict(
        tunnel=dict(cap=1.25, time=0.8, attract=0.45, emit=0.0, portal=0.6, cross=1.0),
        elevated=dict(cap=1.25, time=0.8, attract=0.4, emit=0.8, portal=0.0, cross=1.0),
        surface=dict(cap=1.0, time=1.0, attract=0.3, emit=1.0, portal=0.0, cross=0.9),
    ),
    build=dict(
        tunnel=dict(cap_loss=0.03, portal_loss=0.3, trucks=0.06, dust=0.08),
        elevated=dict(cap_loss=0.15, portal_loss=0.0, trucks=0.03, dust=0.05),
        surface=dict(cap_loss=0.2, portal_loss=0.0, trucks=0.03, dust=0.05),
    ),
    months=dict(tunnel=36, elevated=24, surface=12),
)

# Посадка деревьев (один в один с P.trees в site/js/model.js). Источники — docs/ИСТОЧНИКИ_И_ОГРАНИЧЕНИЯ.md:
#   pm_rate — PM2.5, задержанный 1 м² кроны за год (Nowak 2013: 0,13–0,36 г), co2_rate — CO₂ на 1 м² кроны за год
#   (Nowak 2013: 0,28 кг C ≈ 1,03 кг CO₂), cool_per — °C на +1 п.п. площади крон района (WRI: ~0,3 °C на 10 п.п.).
#   Кроны пород, скорость роста, pm_local, полив и пробки от водовозов — ДОПУЩЕНИЯ.
TREES = dict(
    max=6, crown0=1.5, pm_rate=0.25, co2_rate=1.03, cool_per=0.03, pm_local=0.05, winter_bare=0.15, leaf_on=0.6,
    young_age=3, water_l=100, truck_l=10000, water_loss=0.5, water_from=6, water_to=10, mature_water=0.2, near=10.0,
    species=dict(
        platan=dict(name="Платан (чинара)", crown=18, tau=12, ever=False, pm=1.0),
        karagach=dict(name="Карагач (вяз)", crown=10, tau=6, ever=False, pm=1.1),
        lipa=dict(name="Липа", crown=10, tau=12, ever=False, pm=1.0),
        dub=dict(name="Дуб", crown=16, tau=18, ever=False, pm=1.0),
        topol=dict(name="Тополь (без пуха)", crown=12, tau=5, ever=False, pm=0.9),
        klen=dict(name="Клён", crown=10, tau=8, ever=False, pm=0.9),
        gledichia=dict(name="Гледичия", crown=10, tau=8, ever=False, pm=0.7),
        sosna=dict(name="Сосна", crown=7, tau=12, ever=True, pm=1.3),
        el=dict(name="Ель тянь-шаньская", crown=5, tau=15, ever=True, pm=1.4),
    ),
)
_STREET_IDS = {s["id"] for s in C.STREETS}


def crown_at(sp: str, age: float) -> float:
    """Крона дерева (м) через age лет после посадки: от саженца crown0 до взрослой, экспоненциальное приближение."""
    S = TREES["species"][sp]
    return TREES["crown0"] + (S["crown"] - TREES["crown0"]) * (1 - math.exp(-age / S["tau"]))


def water_trips(t: dict) -> float:
    """Рейсов водовоза в неделю летом: молодые деревья поливают с машины, взрослые — в основном арыки (mature_water)."""
    T = TREES
    return t["n"] * T["water_l"] * (1.0 if t["age"] < T["young_age"] else T["mature_water"]) / T["truck_l"]


def grown_age(sp: str) -> float:
    """Через сколько лет крона дойдёт до 80% взрослой («выросло»)."""
    S = TREES["species"][sp]
    return -S["tau"] * math.log(1 - (0.8 * S["crown"] - TREES["crown0"]) / (S["crown"] - TREES["crown0"]))


def _norm_pts(raw, min_len: float):
    pts: list[list[int]] = []
    for q in raw if isinstance(raw, (list, tuple)) else []:
        if not isinstance(q, (list, tuple)) or len(q) < 2 or len(pts) >= 40:
            continue
        x0, y0 = _num(q[0], None), _num(q[1], None)
        if x0 is None or y0 is None:
            continue
        pt = [int(math.floor(_clamp(x0, 0, C.W) + 0.5)), int(math.floor(_clamp(y0, 0, C.H) + 0.5))]
        if pts and pts[-1] == pt:
            continue
        pts.append(pt)
    length = sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(pts, pts[1:]))
    return pts if len(pts) >= 2 and length >= min_len else None


def norm_tree(t) -> dict | None:
    """Посадка: порода, количество, сколько лет прошло, и где: район (d), вдоль улицы (s) или по линии (pts)."""
    if not isinstance(t, dict) or t.get("sp") not in TREES["species"]:
        return None
    out = dict(sp=t["sp"], n=int(_clamp(math.floor(_num(t.get("n"), 100.0) + 0.5), 1, 100000)),
               age=int(_clamp(math.floor(_num(t.get("age"), 0.0) + 0.5), 0, 60)))
    if t.get("d") in C.DISTRICT_BY_ID:
        out["d"] = t["d"]
    elif t.get("s") in _STREET_IDS:
        out["s"] = t["s"]
    else:
        pts = _norm_pts(t.get("pts"), 4)
        if not pts:
            return None
        out["pts"] = pts
    return out

_clamp = lambda v, a, b: min(b, max(a, v))  # noqa: E731


def _peak(g):
    """Профиль часа: общий множитель P['hour_k'] (держит среднее по суткам ≈8.4 мин), затем всё, что выше среднесуточного потока, смягчаем коэффициентом P['peak_k']."""
    g = g * P["hour_k"]
    return g if g <= 1.0 else 1.0 + P["peak_k"] * (g - 1.0)


def _gauss(d, sigma):
    return np.exp(-(np.asarray(d) ** 2) / (2 * sigma * sigma))


def aqi_from_pm(pm):
    """Кусочно-линейная шкала EPA; для pm ≤ 0 → 0, выше последнего порога → 500."""
    pm = np.asarray(pm, dtype=float)
    out = np.interp(pm, C.PM_BREAKS, C.AQI_BREAKS)
    return np.where(pm > 0, out, 0.0)


def cat_from_aqi(a):
    a = np.asarray(a)
    return np.digitize(a, [50, 100, 150, 200, 300], right=True).astype(np.uint8)


def visibility(aqi: float) -> dict:
    value = _clamp(1 - (aqi - 40) / 190, 0.03, 1.0)
    key = "clear" if value >= 0.75 else "haze" if value >= 0.35 else "none"
    verdict = dict(clear="Горы видно", haze="В дымке", none="Гор не видно")[key]
    return dict(value=value, key=key, verdict=verdict)


def comfort_parts(aqi, delay, green, load, w=None):
    w = w or P["weights"]
    s = (w["air"] + w["road"] + w["green"] + w["social"]) or 1.0
    aqi_n, del_n = min(aqi / 300, 1), min(delay / 30, 1)
    gr_n, so_n = min(green / P["green_norm"], 1), min(max(load - 1, 0), 1)
    parts = dict(
        air=100 * w["air"] * (1 - aqi_n) / s,
        road=100 * w["road"] * (1 - del_n) / s,
        green=100 * w["green"] * gr_n / s,
        social=100 * w["social"] * (1 - so_n) / s,
    )
    return parts, sum(parts.values())


def defaults(season: str = "summer") -> dict:
    return dict(season=season, hour=None, fleet=0.0, ev=P["base_ev"], green=0.0, objects=[], roads=[], trees=[],
                events=dict(closure=None, match=False, bridge=None, venue=C.DEFAULT_VENUE, widen=None))


def _round_half_up(x: float) -> int:
    return int(math.floor(x + 0.5))  # как Math.round в JS (round() в Python округляет .5 к чётному)


def norm_road(r) -> dict | None:
    """Новая дорога: тип, полосы, стадия и точки трассы (целые пиксели схемы, 1 px = 25 м). Мусор → None."""
    if not isinstance(r, dict) or r.get("kind") not in ROAD["kinds"]:
        return None
    pts: list[list[int]] = []
    for q in r.get("pts") or []:
        if not isinstance(q, (list, tuple)) or len(q) < 2 or len(pts) >= 40:
            continue
        x0, y0 = _num(q[0], None), _num(q[1], None)
        if x0 is None or y0 is None:
            continue
        pt = [_round_half_up(_clamp(x0, 0, C.W)), _round_half_up(_clamp(y0, 0, C.H))]
        if pts and pts[-1] == pt:
            continue
        pts.append(pt)
    length = sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(pts, pts[1:]))
    if len(pts) < 2 or length < 20:  # короче 500 м — не дорога
        return None
    lanes = int(_clamp(_round_half_up(_num(r.get("lanes"), 4.0)), 2, 8))
    return dict(kind=r["kind"], lanes=lanes, ph="build" if r.get("ph") == "build" else "done", pts=pts)


def road_segs(r: dict) -> dict:
    """Отрезки трассы не длиннее seg_len (как у улиц) в виде массивов numpy."""
    rows = []
    for (x1, y1), (x2, y2) in zip(r["pts"], r["pts"][1:]):
        ln = math.hypot(x2 - x1, y2 - y1)
        n = max(1, math.ceil(ln / ROAD["seg_len"]))
        for k in range(n):
            ax, ay = x1 + (x2 - x1) * k / n, y1 + (y2 - y1) * k / n
            bx, by = x1 + (x2 - x1) * (k + 1) / n, y1 + (y2 - y1) * (k + 1) / n
            rows.append((ax, ay, bx, by, ln / n, (x2 - x1) / ln, (y2 - y1) / ln))
    a = np.array(rows, dtype=float)
    return dict(ax=a[:, 0], ay=a[:, 1], bx=a[:, 2], by=a[:, 3], mx=(a[:, 0] + a[:, 2]) / 2, my=(a[:, 1] + a[:, 3]) / 2,
                len=a[:, 4], ux=a[:, 5], uy=a[:, 6])


def _dist_pts_to_seg(px, py, ax, ay, bx, by):
    """Расстояние от точек (массивы px, py) до одного отрезка."""
    dx, dy = bx - ax, by - ay
    t = np.clip(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy), 0, 1)
    return np.hypot(px - (ax + t * dx), py - (ay + t * dy))


def _dist_to_road(px, py, rs: dict) -> np.ndarray:
    """Матрица расстояний: строки — точки, столбцы — отрезки трассы."""
    return np.stack([_dist_pts_to_seg(px, py, rs["ax"][j], rs["ay"][j], rs["bx"][j], rs["by"][j]) for j in range(len(rs["len"]))], axis=1)


def _dist_to_ends(px, py, r: dict):
    (ax, ay), (bx, by) = r["pts"][0], r["pts"][-1]
    return np.minimum(np.hypot(px - ax, py - ay), np.hypot(px - bx, py - by))


def _crosses(sax, say, sbx, sby, tax, tay, tbx, tby):
    """Пересекаются ли отрезки s (массивы) и t (один), строго, без касания концами."""
    o = lambda ax, ay, bx, by, cx, cy: (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)  # noqa: E731
    d1, d2 = o(tax, tay, tbx, tby, sax, say), o(tax, tay, tbx, tby, sbx, sby)
    d3, d4 = o(sax, say, sbx, sby, tax, tay), o(sax, say, sbx, sby, tbx, tby)
    return (d1 * d2 < 0) & (d3 * d4 < 0)


def _num(v, default):
    try:
        v = float(v)
        return v if math.isfinite(v) else default
    except (TypeError, ValueError):
        return default


def _hour(v):
    """Час суток 0…23 или None («в среднем за сутки»)."""
    if v is None or v == "":
        return None
    try:
        h = float(v)
    except (TypeError, ValueError):
        return None
    return int(_clamp(round(h), 0, 23)) if math.isfinite(h) else None


def _whole(x: float):
    """2.0 → 2 (целые остаются целыми, как раньше), 0.26 → 0.26."""
    return int(x) if float(x).is_integer() else x


def _tmul(v):
    """Почасовая поправка нагрузки, выученная по замерам 2GIS (live.learn): 24 числа в диапазоне 0.75…1.25, иначе None."""
    if not isinstance(v, (list, tuple)) or len(v) != 24:
        return None
    try:
        m = [float(x) for x in v]
    except (TypeError, ValueError):
        return None
    return tuple(_clamp(x, 0.75, 1.25) if math.isfinite(x) else 1.0 for x in m)


def normalize(p: dict | None) -> dict:
    p = p or {}
    ev = p.get("events") or {}
    merged: dict[tuple[str, str, str], list[float]] = {}  # (район, тип, стадия) → [сумма масштабов n, сумма n·tk]
    for o in p.get("objects") or []:
        if o.get("d") not in C.DISTRICT_BY_ID or o.get("t") not in C.OBJECT_TYPES:
            continue
        k = (o["d"], o["t"], "build" if o.get("ph") == "build" else "done")  # стадия: строится / построен
        n = _clamp(round(_num(o.get("n"), 1), 2), 0.05, 9)  # масштаб объекта: 1 = типовой ЖК/ТЦ/парк (дробный: «0,3 ЖК»)
        tk = _clamp(_num(o.get("tk"), 1.0), 0.2, 3.0)  # поправка нагрузки на улицы (например, нехватка парковок)
        cur = merged.setdefault(k, [0.0, 0.0])
        cur[0] += n
        cur[1] += n * tk
    return dict(
        season="winter" if p.get("season") == "winter" else "summer",
        hour=_hour(p.get("hour")),
        tmul=_tmul(p.get("tmul")),  # только Python-сервер; в браузерной JS-модели поправки нет
        fleet=_clamp(_num(p.get("fleet"), 0.0), -30, 50),
        ev=_clamp(_num(p.get("ev"), P["base_ev"]), 0, 100),
        green=_clamp(_num(p.get("green"), 0.0), -30, 30),
        objects=[dict(d=d, t=t, ph=ph, n=_whole(_clamp(round(v[0], 2), 0.05, 9)), tk=round(v[1] / v[0], 3)) for (d, t, ph), v in merged.items()],
        roads=[r for r in map(norm_road, p.get("roads") if isinstance(p.get("roads"), list) else []) if r][:ROAD["max"]],
        trees=[t for t in map(norm_tree, p.get("trees") if isinstance(p.get("trees"), list) else []) if t][:TREES["max"]],
        events=dict(
            closure=ev.get("closure") if ev.get("closure") in C.CLOSURES else None,
            match=bool(ev.get("match")),
            bridge=ev.get("bridge") if ev.get("bridge") in C.BRIDGES else None,
            venue=ev.get("venue") if ev.get("venue") in C.STADIUMS else C.DEFAULT_VENUE,
            widen=ev.get("widen") if ev.get("widen") in C.CLOSURES else None,
        ),
    )


def preset_params(preset_id: str) -> dict:
    for pr in C.PRESETS:
        if pr["id"] == preset_id:
            base = defaults(pr["params"].get("season", "summer"))
            merged = {**base, **pr["params"], "events": {**base["events"], **pr["params"].get("events", {})}}
            return normalize(merged)
    return defaults()


@dataclass
class Result:
    params: dict
    pm: np.ndarray
    aqi: np.ndarray
    cat: np.ndarray
    seg_vc: np.ndarray
    seg_f: np.ndarray
    seg_closed: np.ndarray
    seg_v: np.ndarray
    city: dict
    districts: dict
    vis: dict
    ms: float = 0.0
    roads: list = field(default_factory=list)  # новые дороги: параметры + отрезки трассы и загрузка (для карты)
    trees: dict = field(default_factory=dict)  # посадки деревьев: крона, тень, пыль, CO₂, полив, кроны по сотам

    def to_dict(self, hexes: bool = False, segments: bool = False) -> dict:
        d = dict(params=self.params, city=self.city, districts=self.districts, vis=self.vis, ms=self.ms, roads=self.roads, trees=self.trees)
        if segments:
            d["segments"] = dict(vc=self.seg_vc.round(4).tolist(), f=self.seg_f.round(4).tolist(),
                                 closed=self.seg_closed.tolist(), V=self.seg_v.round(4).tolist())
        if hexes:
            d["hexes"] = dict(pm=self.pm.round(2).tolist(), aqi=self.aqi.round(1).tolist(), cat=self.cat.tolist())
        return d


class Simulator:
    def __init__(self) -> None:
        self.grid = C.build_grid()
        self.hexes = self.grid["hexes"]
        self._build_segments()
        self._build_weights()
        self._calibrate()

    # ---------- подготовка ----------
    def _build_segments(self) -> None:
        seg = []
        for st in C.STREETS:
            pts = st["pts"]
            for i in range(len(pts) - 1):
                (x1, y1), (x2, y2) = pts[i], pts[i + 1]
                ln = math.hypot(x2 - x1, y2 - y1)
                n = max(1, math.ceil(ln / 70))
                for k in range(n):
                    ax, ay = x1 + (x2 - x1) * k / n, y1 + (y2 - y1) * k / n
                    bx, by = x1 + (x2 - x1) * (k + 1) / n, y1 + (y2 - y1) * (k + 1) / n
                    mx, my = (ax + bx) / 2, (ay + by) / 2
                    dc = math.hypot(mx - C.CENTER[0], my - C.CENTER[1])
                    lanes = float(st.get("lanes", P["ref_lanes"]))
                    seg.append(dict(street=st["id"], ax=ax, ay=ay, bx=bx, by=by, mx=mx, my=my, len=ln / n,
                                    lanes=lanes, cap=lanes / P["ref_lanes"],
                                    vc0=st["vc"] * (0.85 + 0.35 * float(_gauss(dc, 200))) * P["vc_scale"]))
        self.seg = seg
        self.n_seg = len(seg)
        self.s_len = np.array([s["len"] for s in seg])
        self.s_mx = np.array([s["mx"] for s in seg])
        self.s_my = np.array([s["my"] for s in seg])
        self.s_vc0 = np.array([s["vc0"] for s in seg])
        self.s_cap = np.array([s["cap"] for s in seg])
        self.s_street = np.array([s["street"] for s in seg])
        self.s_ax = np.array([s["ax"] for s in seg]); self.s_ay = np.array([s["ay"] for s in seg])  # noqa: E702
        self.s_bx = np.array([s["bx"] for s in seg]); self.s_by = np.array([s["by"] for s in seg])  # noqa: E702

    def _nearest_seg(self, street: str, x: float, y: float) -> int:
        idx = np.where(self.s_street == street)[0]
        d = np.hypot(self.s_mx[idx] - x, self.s_my[idx] - y)
        return int(idx[int(np.argmin(d))])

    def _segs_near(self, street: str, x: float, y: float, r: float) -> np.ndarray:
        """Все отрезки улицы в радиусе r от точки (оба направления моста); если таких нет — ближайший."""
        idx = np.where(self.s_street == street)[0]
        d = np.hypot(self.s_mx[idx] - x, self.s_my[idx] - y)
        near = idx[d <= r]
        return near if len(near) else idx[[int(np.argmin(d))]]

    def _dist_point_seg(self, px: float, py: float) -> np.ndarray:
        ax = np.array([s["ax"] for s in self.seg]); ay = np.array([s["ay"] for s in self.seg])
        bx = np.array([s["bx"] for s in self.seg]); by = np.array([s["by"] for s in self.seg])
        dx, dy = bx - ax, by - ay
        t = np.clip(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy), 0, 1)
        return np.hypot(px - (ax + t * dx), py - (ay + t * dy))

    def _build_weights(self) -> None:
        nh = len(self.hexes)
        self.hx = np.array([h["x"] for h in self.hexes])
        self.hy = np.array([h["y"] for h in self.hexes])
        self.h_dist = [h["d"] for h in self.hexes]
        W = np.zeros((nh, self.n_seg))
        for hi, h in enumerate(self.hexes):
            d = self._dist_point_seg(h["x"], h["y"])
            W[hi] = np.where(d < P["cut_i"], self.s_len * _gauss(d, P["sigma_i"]), 0.0)
        self.W_hex = W
        self.h_density = 0.55 + 0.9 * _gauss(np.hypot(self.hx - C.CENTER[0], self.hy - C.CENTER[1]), 240)
        self.dist_w, self.hex_by_d = {}, {}
        for d in C.DISTRICTS:
            dd = np.hypot(self.s_mx - d["x"], self.s_my - d["y"])
            self.dist_w[d["id"]] = np.where(dd < 260, self.s_len * _gauss(dd, 120), 0.0)
            self.hex_by_d[d["id"]] = np.array([i for i, h in enumerate(self.hexes) if h["d"] == d["id"]], dtype=int)
        self.h_priv = np.array([C.DISTRICT_BY_ID[h["d"]]["priv"] for h in self.hexes])

    def _calibrate(self) -> None:
        self.kT = 1.0
        base = self._traffic(normalize(defaults("summer")))
        I = np.sort(self._intensity(base["V"]))
        p95 = I[int(math.floor(len(I) * 0.95))]
        self.kT = P["tp_summer_p95"] / (p95 * (1 - P["base_ev"] / 100))

    # ---------- ядро ----------
    def _intensity(self, V: np.ndarray) -> np.ndarray:
        return (self.W_hex @ V) * self.h_density

    # ---------- деревья ----------
    def _tree_spots(self, t: dict) -> list[tuple[float, float, float]]:
        """Где стоят деревья: точки (x, y, доля), доли в сумме 1. Район — равномерно по сотам; улица — по её отрезкам
        пропорционально длине; линия — кусками по ~10 px (250 м)."""
        if "d" in t:
            ids = self.hex_by_d[t["d"]]
            return [(self.hx[i], self.hy[i], 1 / len(ids)) for i in ids]
        if "s" in t:
            idx = np.where(self.s_street == t["s"])[0]
            L = float(self.s_len[idx].sum())
            return [(self.s_mx[i], self.s_my[i], self.s_len[i] / L) for i in idx]
        pts = t["pts"]
        L = sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(pts, pts[1:]))
        out = []
        for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
            ln = math.hypot(x2 - x1, y2 - y1)
            n = max(1, math.ceil(ln / 10))
            out += [(x1 + (x2 - x1) * (k + 0.5) / n, y1 + (y2 - y1) * (k + 0.5) / n, ln / n / L) for k in range(n)]
        return out

    def _tree_street_segs(self, t: dict) -> np.ndarray:
        """Отрезки улиц, вдоль которых стоят деревья (их поливают водовозы прямо с проезжей части)."""
        if "d" in t:
            return np.array([], dtype=int)
        if "s" in t:
            return np.where(self.s_street == t["s"])[0]
        pts = np.array(t["pts"], dtype=float)
        rs = dict(ax=pts[:-1, 0], ay=pts[:-1, 1], bx=pts[1:, 0], by=pts[1:, 1], len=np.hypot(*(pts[1:] - pts[:-1]).T))
        return np.where(_dist_to_road(self.s_mx, self.s_my, rs).min(axis=1) < TREES["near"])[0]

    def _water_block(self, t: dict, season: str, hour):
        """Водовозы у деревьев вдоль улиц: только лето. Одновременно работает trucks машин (рейсы за день / часы полива,
        рейс ~1 час), каждая занимает полосу на одном отрезке улицы (−water_loss ёмкости); отрезки — равномерно по посадке.
        В выбранный час: только с water_from до water_to; в среднем за сутки — доля этих часов. → (индексы, потеря) или None."""
        T = TREES
        if season != "summer" or "d" in t:
            return None
        hours = T["water_to"] - T["water_from"] + 1
        share = hours / 24 if hour is None else (1.0 if T["water_from"] <= hour <= T["water_to"] else 0.0)
        segs = self._tree_street_segs(t)
        if not share or not len(segs):
            return None
        trucks = min(len(segs), max(1, math.ceil(water_trips(t) / 7 / hours)))
        at = [int(segs[int(math.floor((k + 0.5) * len(segs) / trucks))]) for k in range(trucks)]
        return at, T["water_loss"] * share

    def _traffic(self, p: dict, g: float = 1.0, hour=None) -> dict:
        """Поток F (в единицах эталонной ёмкости) и ёмкость по отрезкам; V/C = F / ёмкость. hour — для полива деревьев."""
        n = self.n_seg
        F = self.s_vc0 * self.s_cap          # базовый поток = загрузка × ёмкость (больше полос → больше машин)
        Cap = self.s_cap.copy()
        closed = np.zeros(n, dtype=np.uint8)
        for t in p.get("trees", []):  # водовозы поливают деревья вдоль улиц и занимают полосу
            wb = self._water_block(t, p["season"], hour)
            if wb:
                for i in wb[0]:
                    Cap[i] *= 1 - wb[1]
        if p["events"]["widen"]:  # новая магистраль вдоль улицы: больше ёмкость на центральном участке
            for i in range(n):
                if self.seg[i]["street"] == p["events"]["widen"] and math.hypot(self.s_mx[i] - C.CENTER[0], self.s_my[i] - C.CENTER[1]) <= 240:
                    Cap[i] = self.s_cap[i] * (1 + C.WIDEN)
        for o in p["objects"]:
            t, at = C.OBJECT_TYPES[o["t"]], C.DISTRICT_BY_ID[o["d"]]
            d_site = np.hypot(self.s_mx - at["x"], self.s_my - at["y"])
            if o["ph"] == "build":
                # стройка: приезжает техника, проезд рядом сужается (жителей и обычного трафика объекта ещё нет)
                F += max(t["traffic"], C.BUILD["min_traffic"]) * C.BUILD["traffic_k"] * o["n"] * _gauss(d_site, 70)
                Cap *= np.maximum(0.5, 1 - C.BUILD["cap_loss"] * _gauss(d_site, 14))
            elif t["traffic"]:
                F += t["traffic"] * o["n"] * o.get("tk", 1.0) * _gauss(d_site, 70)
        if p["events"]["match"]:
            v = C.STADIUMS[p["events"]["venue"]]  # больше зрителей → больше машин: добавка пропорциональна вместимости
            F += 0.35 * v["capacity"] / C.REF_CAPACITY * _gauss(np.hypot(self.s_mx - v["x"], self.s_my - v["y"]), 90)
        roads = [self._road(r, F, Cap) for r in p.get("roads", [])]  # меняет F и Cap на месте
        fleet_k = (1 + p["fleet"] / 100) * g
        F *= fleet_k  # EV тоже машины: прирост парка нагружает улицы; g — время суток (1 = среднесуточный день)
        for x in roads:
            x["V"] *= fleet_k

        if p["events"]["closure"]:
            cl = C.CLOSURES[p["events"]["closure"]]
            for i in range(n):
                if self.seg[i]["street"] != p["events"]["closure"]:
                    continue
                if math.hypot(self.s_mx[i] - C.CENTER[0], self.s_my[i] - C.CENTER[1]) > 240:
                    continue
                Cap[i], closed[i] = 0.5 * self.s_cap[i], 1
                moved = 0.3 * F[i]
                F[i] -= moved
                for pid in cl["parallels"]:
                    F[self._nearest_seg(pid, self.s_mx[i], self.s_my[i])] += moved / len(cl["parallels"])
        if p["events"]["bridge"]:
            b = C.BRIDGES[p["events"]["bridge"]]
            idx = self._segs_near(b["street"], b["x"], b["y"], P["bridge_r"])
            moved = float(F[idx].sum())
            F[idx], closed[idx] = 0.0, 2
            for sid, share in b["alt"]:
                js = self._segs_near(sid, b["x"], b["y"], P["bridge_r"])
                F[js] += moved * share / len(js)
        shut = closed == 2
        vc = np.where(shut, 0.0, F / Cap)
        f = np.where(shut, 1.0, np.minimum(P["f_cap"], 1 + P["bpr_alpha"] * vc ** P["bpr_beta"]))
        for x in roads:  # у новой дороги своё время в пути: без светофоров быстрее (K.time)
            if x["open"]:
                x["vc"] = x["V"] / x["C"]
                x["f"] = x["K"]["time"] * np.minimum(P["f_cap"], 1 + P["bpr_alpha"] * x["vc"] ** P["bpr_beta"])
            else:
                x["vc"], x["f"] = np.zeros_like(x["V"]), np.ones_like(x["V"])
        return dict(V=F, C=Cap, vc=vc, f=f, closed=closed, roads=roads)

    def _road(self, r: dict, F: np.ndarray, Cap: np.ndarray) -> dict:
        """Новая дорога. Строится: сужение улиц вдоль трассы (у тоннеля — у порталов) и грузовики, своей дороги ещё нет.
        Построена: забирает часть потока у близких параллельных улиц (+induced: новые поездки), плюс базовое
        использование base_use·ёмкость; обычная дорога добавляет светофоры на пересекаемых улицах."""
        K, rs = ROAD["kinds"][r["kind"]], road_segs(r)
        m = len(rs["len"])
        RV, RC = np.zeros(m), np.full(m, r["lanes"] / P["ref_lanes"] * K["cap"])
        dist = _dist_to_road(self.s_mx, self.s_my, rs)  # (отрезки улиц × отрезки трассы)
        if r["ph"] == "build":
            B = ROAD["build"][r["kind"]]
            d, de = dist.min(axis=1), _dist_to_ends(self.s_mx, self.s_my, r)
            Cap *= np.maximum(0.5, 1 - B["cap_loss"] * _gauss(d, 15))
            if B["portal_loss"]:
                Cap *= np.maximum(0.5, 1 - B["portal_loss"] * _gauss(de, 20))
            F += B["trucks"] * (_gauss(de, 50) if r["kind"] == "tunnel" else _gauss(d, 40))
        else:
            if K["cross"] < 1:
                for j in range(m):
                    hit = _crosses(self.s_ax, self.s_ay, self.s_bx, self.s_by, rs["ax"][j], rs["ay"][j], rs["bx"][j], rs["by"][j])
                    Cap[hit] *= K["cross"]
            best = np.argmin(dist, axis=1)
            bd = dist[np.arange(self.n_seg), best]
            align = np.abs(((self.s_bx - self.s_ax) * rs["ux"][best] + (self.s_by - self.s_ay) * rs["uy"][best]) / self.s_len)
            want = np.where(bd < ROAD["cut"], K["attract"] * _gauss(bd, ROAD["reach"]) * align * F, 0.0)
            # отрезки одной параллельной улицы идут друг за другом, по ним едут те же машины: поток переходит на отрезок
            # трассы пропорционально длине, которую улица проходит вдоль него (len·align / длина отрезка трассы)
            gain = want * (1 + ROAD["induced"]) * self.s_len * align / rs["len"][best]
            D = np.zeros(m)
            np.add.at(D, best, gain)
            # переходят, пока дорога не заполнится до fill: дальше ехать по ней уже не быстрее (упрощённое равновесие)
            room = np.maximum(0.0, (ROAD["fill"] - ROAD["base_use"]) * RC)
            k = np.where(D > room, room / np.where(D > 0, D, 1.0), 1.0)
            F -= want * k[best]
            np.add.at(RV, best, gain * k[best])
            RV += ROAD["base_use"] * RC
        return dict(r=r, K=K, segs=rs, V=RV, C=RC, open=r["ph"] == "done")

    def _road_intensity(self, roads: list[dict]) -> np.ndarray:
        """Выхлоп новых дорог у сот: вдоль трассы ×emit, у тоннеля доля portal выходит у двух порталов."""
        I = np.zeros(len(self.hexes))
        for x in roads:
            if not x["open"]:
                continue
            rs, K = x["segs"], x["K"]
            if K["emit"]:
                d = _dist_to_road(self.hx, self.hy, rs)
                I += (np.where(d < P["cut_i"], _gauss(d, P["sigma_i"]), 0.0) * (x["V"] * rs["len"] * K["emit"])).sum(axis=1)
            if K["portal"]:
                tot = float((x["V"] * rs["len"]).sum())
                for ex, ey in (x["r"]["pts"][0], x["r"]["pts"][-1]):
                    d = np.hypot(self.hx - ex, self.hy - ey)
                    I += np.where(d < P["cut_i"], tot * K["portal"] / 2 * _gauss(d, P["sigma_i"]), 0.0)
        return I * self.h_density

    def simulate(self, raw: dict | None = None) -> Result:
        t0 = time.perf_counter()
        p = normalize(raw)
        winter = p["season"] == "winter"
        hour = p["hour"]
        tr_air = self._traffic(p)  # выбросы считаем по среднесуточному потоку: суточный ритм воздуха берём из датчиков (иначе учли бы дважды)
        g_hour = None if hour is None else _peak(C.TIME["traffic"][hour] * (p["tmul"][hour] if p.get("tmul") else 1.0))
        tr = tr_air if hour is None else self._traffic(p, g_hour, hour)  # дорога: нагрузка выбранного часа (с поправкой по замерам 2GIS, если есть)

        ice = 1 - p["ev"] / 100  # выхлоп дают только ДВС
        mg = 1 - P["green_k"] * p["green"] / 100
        bg = np.where(
            winter,
            P["bg_winter"][0] + P["bg_winter"][1] * self.h_priv,
            P["bg_summer"][0] + P["bg_summer"][1] * self.h_priv,
        )
        tp = self.kT * (self._intensity(tr_air["V"]) + self._road_intensity(tr_air["roads"])) * ice * (P["winter_traffic"] if winter else 1.0)

        # Деревья: крона через age лет → площадь крон по сотам (canopy) и «работающая» на пыль площадь (зимой лиственные голые)
        T, nh = TREES, len(self.hexes)
        hex_area = 3 * math.sqrt(3) / 2 * self.grid["R"] ** 2 * 625  # м², 1 px = 25 м
        canopy, canopy_pm = np.zeros(nh), np.zeros(nh)
        plantings = []
        for t in p["trees"]:
            S = T["species"][t["sp"]]
            crown = crown_at(t["sp"], t["age"])
            each = math.pi * crown * crown / 4
            total = each * t["n"]
            pm_k = S["pm"] * ((1.0 if S["ever"] else T["winter_bare"]) if winter else 1.0)
            for x, y, w in self._tree_spots(t):
                hi = int(np.argmin(np.hypot(self.hx - x, self.hy - y)))
                canopy[hi] += total * w
                canopy_pm[hi] += total * w * pm_k
            year_pm = 1.0 if S["ever"] else T["leaf_on"] + (1 - T["leaf_on"]) * T["winter_bare"]  # лиственные ~7 месяцев в году
            plantings.append(dict(**t, crown=crown, each=each, total=total, grown=grown_age(t["sp"]),
                                  pmKg=total * T["pm_rate"] * S["pm"] * year_pm / 1000, co2t=total * T["co2_rate"] / 1000,
                                  trips=water_trips(t), water=(self._water_block(t, "summer", T["water_from"]) or [[]])[0]))
        mp = np.where(canopy_pm > 0, 1 - T["pm_local"] * np.minimum(1.0, canopy_pm / hex_area), 1.0)  # кроны задерживают часть пыли
        for x in tr_air["roads"]:  # пыль стройки дороги: вдоль трассы, у тоннеля — у порталов
            if x["open"]:
                continue
            B, r = ROAD["build"][x["r"]["kind"]], x["r"]
            near = _gauss(_dist_to_ends(self.hx, self.hy, r), 50) if r["kind"] == "tunnel" else _gauss(_dist_to_road(self.hx, self.hy, x["segs"]).min(axis=1), 40)
            mp *= 1 + B["dust"] * near
        for o in p["objects"]:
            at = C.DISTRICT_BY_ID[o["d"]]
            if o["ph"] == "build":  # пыль стройки: локально чуть больше PM
                mp *= 1 + C.BUILD["dust"] * o["n"] * _gauss(np.hypot(self.hx - at["x"], self.hy - at["y"]), 60)
                continue
            pm_local = C.OBJECT_TYPES[o["t"]].get("pm_local")
            if not pm_local:
                continue
            mp *= 1 - pm_local * o["n"] * _gauss(np.hypot(self.hx - at["x"], self.hy - at["y"]), 80)
        pm = (bg + tp) * mg * np.maximum(0.5, mp)
        if hour is not None:
            pm = pm * C.TIME["air"][p["season"]][hour]  # реальный суточный ритм PM2.5 по датчикам
        aqi = aqi_from_pm(pm)
        cat = cat_from_aqi(aqi)

        live = tr["closed"] != 2
        w = self.s_len * tr["V"] * live
        num, den = float((w * tr["f"]).sum()), float(w.sum())
        open_roads = [x for x in tr["roads"] if x["open"]]
        for x in open_roads:
            wr = x["segs"]["len"] * x["V"]
            num += float((wr * x["f"]).sum()); den += float(wr.sum())  # noqa: E702
        f_city = num / den if den else 1.0

        districts, pop_sum, pm_sum = {}, 0.0, 0.0
        for d in C.DISTRICTS:
            mine = [o for o in p["objects"] if o["d"] == d["id"]]
            residents = sum(C.OBJECT_TYPES[o["t"]]["residents"] * o["n"] for o in mine if o["ph"] == "done")
            pop = d["pop"] + residents / 1000
            ids = self.hex_by_d[d["id"]]
            dpm = float(pm[ids].mean()) if len(ids) else 0.0
            wd = self.dist_w[d["id"]] * live
            wn_, wd_ = float((wd * tr["f"]).sum()), float(wd.sum())
            for x in open_roads:
                dd = np.hypot(x["segs"]["mx"] - d["x"], x["segs"]["my"] - d["y"])
                wr = np.where(dd < 260, x["segs"]["len"] * _gauss(dd, 120), 0.0)
                wn_ += float((wr * x["f"]).sum()); wd_ += float(wr.sum())  # noqa: E702
            F = wn_ / wd_ if wd_ else 1.0
            canopy_d = float(canopy[ids].sum()) if len(ids) else 0.0
            area_d = len(ids) * hex_area
            extra_green = sum(o["n"] * C.OBJECT_TYPES[o["t"]].get("green_per_person", 0.0) for o in mine if o["ph"] == "done") \
                + canopy_d / (pop * 1000)  # кроны новых деревьев: м² зелени на жителя
            cool = 0.0 if winter or not area_d else T["cool_per"] * 100 * min(1.0, canopy_d / area_d)  # °C прохладнее летом
            green = d["green"] * (1 + p["green"] / 100) * d["pop"] / pop + extra_green
            school, clinic = d["school"] * pop / d["pop"], d["clinic"] * pop / d["pop"]
            daqi, delay = float(aqi_from_pm(dpm)), P["T0"] * (F - 1)
            parts, total = comfort_parts(daqi, delay, green, max(school, clinic))
            districts[d["id"]] = dict(id=d["id"], name=d["name"], pop=pop, pm=dpm, aqi=daqi,
                                      cat=int(cat_from_aqi(daqi)), delay=delay, speed=P["V0"] / F,
                                      green=green, school=school, clinic=clinic, comfort=total, parts=parts, canopy=canopy_d, cool=cool)
            pop_sum += pop
            pm_sum += pop * dpm

        city_pm = pm_sum / pop_sum
        city_aqi = float(aqi_from_pm(city_pm))
        parts = dict(air=0.0, road=0.0, green=0.0, social=0.0)
        comfort = 0.0
        for r in districts.values():
            wgt = r["pop"] / pop_sum
            comfort += wgt * r["comfort"]
            for k in parts:
                parts[k] += wgt * r["parts"][k]
        city = dict(pm=city_pm, aqi=city_aqi, cat=int(cat_from_aqi(city_aqi)), delay=P["T0"] * (f_city - 1),
                    speed=P["V0"] / f_city, comfort=comfort, parts=parts)
        roads = [dict(**x["r"], segs=np.stack([x["segs"][k] for k in ("ax", "ay", "bx", "by")], axis=1).round(2).tolist(),
                      vc=x["vc"].round(4).tolist(), f=x["f"].round(4).tolist(), V=x["V"].round(4).tolist()) for x in tr["roads"]]
        trees = dict(n=sum(t["n"] for t in plantings), canopy=sum(t["total"] for t in plantings), pm=sum(t["pmKg"] for t in plantings),
                     co2=sum(t["co2t"] for t in plantings), trips=sum(t["trips"] for t in plantings),
                     cool=max((r["cool"] for r in districts.values()), default=0.0),
                     plantings=plantings, hexes=[[int(i), float(canopy[i])] for i in np.nonzero(canopy)[0]])
        return Result(p, pm, aqi, cat, tr["vc"], tr["f"], tr["closed"], tr["V"], city, districts,
                      visibility(city_aqi), (time.perf_counter() - t0) * 1000, roads, trees)

    # ---------- разложение эффекта (водопад) ----------
    STEPS = [("fleet", "Автопарк"), ("ev", "Доля EV"), ("green", "Зелень"), ("objects", "Застройка"), ("roads", "Новые дороги"),
             ("trees", "Деревья"), ("events", "События"), ("hour", "Время суток")]

    def decompose(self, raw: dict | None) -> list[dict]:
        p = normalize(raw)
        cur = {**defaults(p["season"]), "tmul": p["tmul"]}
        pick = lambda r: {k: r.city[k] for k in ("aqi", "delay", "comfort", "pm", "speed")}  # noqa: E731
        prev = pick(self.simulate(cur))
        out = [dict(key="base", label="Сегодня", value=prev)]
        for key, label in self.STEPS:
            cur = {**cur, key: p[key]}
            v = pick(self.simulate(cur))
            out.append(dict(key=key, label=label, value=v, delta={k: v[k] - prev[k] for k in ("aqi", "delay", "comfort")}))
            prev = v
        return out

    # ---------- геометрия для карты ----------
    def hex_geojson(self) -> dict:
        feats = []
        for h in self.hexes:
            ring = [C.to_lonlat(*C.hex_corner(h, k, self.grid["R"])) for k in range(6)]
            ring.append(ring[0])
            feats.append(dict(type="Feature", properties=dict(i=h["i"], district=h["d"]),
                              geometry=dict(type="Polygon", coordinates=[[list(c) for c in ring]])))
        return dict(type="FeatureCollection", features=feats)

    def streets_geojson(self) -> dict:
        feats = [dict(type="Feature", properties=dict(i=i, id=sg["street"], lanes=sg["lanes"]),
                      geometry=dict(type="LineString", coordinates=[list(C.to_lonlat(sg["ax"], sg["ay"])),
                                                                    list(C.to_lonlat(sg["bx"], sg["by"]))]))
                 for i, sg in enumerate(self.seg)]
        return dict(type="FeatureCollection", features=feats)


_SIM: Simulator | None = None


def get_simulator() -> Simulator:
    global _SIM
    if _SIM is None:
        _SIM = Simulator()
    return _SIM
