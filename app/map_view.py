"""Карта Бишкека на реальной подложке (pydeck). Соты окрашены по AQI (шкала EPA, как в дизайне)."""
from __future__ import annotations

import copy

import pydeck as pdk

from twin_bishkek import city as C
from twin_bishkek.simulator import Result, Simulator

AQI_STOPS = [(25, "#4CB87A"), (75, "#EFD24A"), (125, "#F2953A"), (175, "#E8604C"), (250, "#8A4BA6"), (400, "#6A1F3D")]
_rgb = lambda h: [int(h[i:i + 2], 16) for i in (1, 3, 5)]  # noqa: E731
# Пробки в цветах навигаторов. Пороги V/C = 0.8 / 1.0 / 1.3 (замедление по BPR на 20% / 50% / 140%), как на сайте.
TRAFFIC = dict(free="#34B24F", dense="#F2B91E", jam="#E5392B", severe="#8C1520", closed="#12212E")


def congestion(vc: float, closed: int) -> str:
    if closed == 2:
        return "closed"
    return "severe" if vc >= 1.3 else "jam" if vc >= 1.0 else "dense" if vc >= 0.8 else "free"


DELTA = [(-10, "#155E8C"), (-4, "#5E97BF"), (-1, "#B5D2E6"), (1, "#DDE3E8"), (4, "#F1C9B6"), (10, "#DC8A63"), (1e9, "#B0461E")]


def aqi_color(a: float) -> list[int]:
    if a <= AQI_STOPS[0][0]:
        return _rgb(AQI_STOPS[0][1])
    for (a0, c0), (a1, c1) in zip(AQI_STOPS, AQI_STOPS[1:]):
        if a <= a1:
            t = (a - a0) / (a1 - a0)
            return [round(x + (y - x) * t) for x, y in zip(_rgb(c0), _rgb(c1))]
    return _rgb(AQI_STOPS[-1][1])


def delta_color(d: float) -> list[int]:
    for limit, c in DELTA:
        if d < limit or limit == 1e9:
            return _rgb(c)
    return _rgb(DELTA[-1][1])


def build_deck(sim: Simulator, res: Result, base: Result | None = None, dark: bool = False) -> pdk.Deck:
    """base != None → слой «Разница» (ΔAQI к сегодняшнему дню), иначе обычный AQI."""
    gj = copy.deepcopy(sim.hex_geojson())
    for f, aqi, pm in zip(gj["features"], res.aqi, res.pm):
        delta = float(aqi - base.aqi[f["properties"]["i"]]) if base is not None else 0.0
        f["properties"].update(
            color=(delta_color(delta) if base is not None else aqi_color(float(aqi))) + [150],
            aqi=round(float(aqi)), pm=round(float(pm), 1), delta=round(delta, 1),
            name=C.DISTRICT_BY_ID[f["properties"]["district"]]["name"],
        )
    hexes = pdk.Layer("GeoJsonLayer", gj, get_fill_color="properties.color", get_line_color=[18, 33, 46, 40],
                      line_width_min_pixels=0.5, pickable=True, stroked=True, filled=True)
    st = copy.deepcopy(sim.streets_geojson())
    for f in st["features"]:
        i = f["properties"]["i"]
        c = congestion(float(res.seg_vc[i]), int(res.seg_closed[i]))
        f["properties"]["color"] = _rgb(TRAFFIC[c]) + [255]
        f["properties"]["jam"] = c
    streets = pdk.Layer("GeoJsonLayer", st, get_line_color="properties.color", get_line_width=4, line_width_min_pixels=2)
    lon, lat = C.to_lonlat(*C.CENTER)
    return pdk.Deck(
        layers=[hexes, streets],
        initial_view_state=pdk.ViewState(longitude=lon, latitude=lat - 0.01, zoom=10.6, pitch=0),
        map_style="dark_no_labels" if dark else "light_no_labels",
        tooltip={"html": "<b>{name}</b><br/>AQI {aqi} · PM2.5 {pm} мкг/м³<br/>Δ к сегодня: {delta}"},
    )
