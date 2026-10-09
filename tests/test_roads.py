"""Новые дороги через город: тоннель, эстакада, обычная. Проверяются направления эффектов и инварианты, а не точные числа."""
import numpy as np
import pytest

from twin_bishkek.simulator import ROAD, defaults, get_simulator, normalize

S = get_simulator()
EW = [[300, 470], [540, 470], [820, 490]]  # с запада на восток через центр, вдоль Чуя


def run(roads=(), **kw):
    return S.simulate({**defaults(kw.pop("season", "summer")), **kw, "roads": list(roads)})


def road(kind, ph="done", pts=EW, lanes=4):
    return dict(kind=kind, ph=ph, pts=pts, lanes=lanes)


B = run()


def test_normalize_roads():
    rs = normalize(dict(roads=[
        dict(kind="nope", pts=EW),                               # неизвестный тип
        dict(kind="tunnel", pts=[[1, 1], [1, 1]]),               # одна точка
        dict(kind="tunnel", pts=[[0, 0], [5, 5]]),               # короче 500 м
        dict(kind="surface", pts=[[10.5, 20.4], ["x", 3], [400, 20]], lanes="abc", ph="build"),
        dict(kind="elevated", pts=EW, lanes=20), dict(kind="tunnel", pts=EW), dict(kind="tunnel", pts=EW),
    ]))["roads"]
    assert len(rs) == ROAD["max"]
    assert rs[0] == dict(kind="surface", lanes=4, ph="build", pts=[[11, 20], [400, 20]])  # .5 вверх, как Math.round в JS
    assert rs[1]["lanes"] == 8
    assert normalize({})["roads"] == [] and normalize(dict(roads="x"))["roads"] == []


def test_no_roads_is_base():
    assert run().city == B.city


@pytest.mark.parametrize("kind", ["tunnel", "elevated", "surface"])
def test_built_road_cuts_delay_and_carries_traffic(kind):
    r = run([road(kind)])
    assert r.city["delay"] < B.city["delay"] - 0.5
    assert len(r.roads) == 1 and min(r.roads[0]["V"]) > 0
    assert max(r.roads[0]["vc"]) <= ROAD["fill"] + 0.05  # переходят, пока дорога не заполнится


@pytest.mark.parametrize("kind", ["tunnel", "elevated", "surface"])
def test_construction_makes_things_worse_and_road_is_closed(kind):
    r = run([road(kind, "build")])
    assert r.city["delay"] > B.city["delay"] and r.city["aqi"] >= B.city["aqi"]
    assert max(r.roads[0]["V"]) == 0 and max(r.roads[0]["vc"]) == 0


def test_tunnel_is_best_for_air_and_surface_is_worst_during_works():
    built = {k: run([road(k)]).city for k in ROAD["kinds"]}
    works = {k: run([road(k, "build")]).city for k in ROAD["kinds"]}
    assert built["tunnel"]["aqi"] < B.city["aqi"] < built["surface"]["aqi"]  # тоннель уводит выхлоп к порталам
    assert built["tunnel"]["aqi"] < built["elevated"]["aqi"] < built["surface"]["aqi"]
    assert works["surface"]["delay"] > works["elevated"]["delay"] > works["tunnel"]["delay"]


def test_surface_road_adds_signals_on_crossed_streets():
    ns = [[555, 250], [555, 700]]  # с севера на юг поперёк Чуя и Жибек Жолу
    t = S._traffic(normalize(dict(roads=[road("surface", pts=ns)])))
    e = S._traffic(normalize(dict(roads=[road("elevated", pts=ns)])))
    assert (t["C"] < e["C"] - 1e-9).sum() > 0  # на пересечениях у обычной дороги меньше ёмкость


def test_tunnel_pollutes_only_at_portals():
    r, b = run([road("tunnel")]), B
    ends = [EW[0], EW[-1]]
    d_end = np.min([np.hypot(S.hx - x, S.hy - y) for x, y in ends], axis=0)
    portal = d_end < 25
    assert (r.pm[portal] - b.pm[portal]).max() > 0  # у порталов воздух хуже


def test_more_lanes_cut_delay_more():
    assert run([road("surface", lanes=6)]).city["delay"] < run([road("surface", lanes=2)]).city["delay"]


def test_decompose_has_roads_step_and_sums():
    p = normalize(dict(fleet=10, roads=[road("tunnel")], events=dict(closure="chuy")))
    steps = S.decompose(p)
    assert [s["key"] for s in steps][4:6] == ["objects", "roads"]
    assert steps[-1]["value"]["delay"] == pytest.approx(S.simulate(p).city["delay"])


def test_road_result_is_serializable():
    d = run([road("elevated")]).to_dict()
    assert d["roads"][0]["kind"] == "elevated" and len(d["roads"][0]["segs"][0]) == 4
