"""Тесты инвариантов модели (перенос TC-01…TC-16 из design/prototype/js/selftest.js).
Проверяются направления изменений и инварианты, а не точные числа."""
import math
import random

import numpy as np
import pytest

from twin_bishkek import city as C
from twin_bishkek.simulator import P, defaults, get_simulator, normalize, preset_params

S = get_simulator()


def run(patch=None, season="summer"):
    d = defaults(season)
    patch = patch or {}
    return S.simulate({**d, **patch, "events": {**d["events"], **patch.get("events", {})}})


B = run()


def test_calibration_matches_design_targets():
    # Калибровка по датчикам OpenAQ: лето PM2.5 ≈ 14 (AQI ≈ 59), зима PM2.5 ≈ 70 (AQI ≈ 160).
    # Задержка 8.4 мин и скорость 29 км/ч: демо-цели (реальных данных о пробках пока нет).
    assert B.city["pm"] == pytest.approx(14.0, abs=1.5)
    assert B.city["aqi"] == pytest.approx(59.5, abs=5)
    assert B.city["delay"] == pytest.approx(8.4, abs=1.5)
    assert B.city["speed"] == pytest.approx(29, abs=2)
    assert B.city["comfort"] == pytest.approx(76.5, abs=4)
    w = run(season="winter").city
    assert w["pm"] == pytest.approx(70, abs=6) and w["aqi"] == pytest.approx(160, abs=15)


def test_tc01_default_is_base():
    r = run()
    assert all(r.city[k] == B.city[k] for k in ("pm", "aqi", "delay", "speed", "comfort"))


def test_tc02_fleet_up_ev0():
    r = run(dict(fleet=20, ev=0))
    assert r.city["delay"] > B.city["delay"] and r.city["speed"] < B.city["speed"] and r.city["pm"] > B.city["pm"]


def test_tc03_all_growth_is_ev():
    ev = 100 * (1 - (1 - P["base_ev"] / 100) / 1.2)
    r = run(dict(fleet=20, ev=ev))
    assert r.city["delay"] > B.city["delay"]
    assert abs(r.city["pm"] - B.city["pm"]) < 1e-6


def test_tc04_ev_cuts_pm_not_delay():
    a, b = run(dict(fleet=20, ev=5)), run(dict(fleet=20, ev=35))
    assert abs(a.city["delay"] - b.city["delay"]) < 1e-9 and b.city["pm"] < a.city["pm"]


def test_tc05_tc06_green():
    up, down = run(dict(green=10)), run(dict(green=-15))
    assert up.city["pm"] < B.city["pm"] and up.city["comfort"] > B.city["comfort"]
    assert down.city["pm"] > B.city["pm"] and down.city["comfort"] < B.city["comfort"]


def test_tc07_jk_is_local():
    r = run(dict(objects=[dict(d="jal", t="jk", n=1)]))
    assert r.districts["jal"]["delay"] > B.districts["jal"]["delay"]
    for d in ("tunguch", "alamedin", "uchkun"):  # районы дальше 10 км от Джала
        assert abs(r.districts[d]["delay"] - B.districts[d]["delay"]) < 0.1
        assert abs(r.districts[d]["aqi"] - B.districts[d]["aqi"]) < 0.5


def test_tc08_more_jk_more_effect():
    one, three = run(dict(objects=[dict(d="jal", t="jk", n=1)])), run(dict(objects=[dict(d="jal", t="jk", n=3)]))
    assert three.city["delay"] >= one.city["delay"]
    assert three.districts["jal"]["school"] > one.districts["jal"]["school"]


def test_tc09_match_jams_near_stadium():
    r = run(dict(events=dict(match=True)))
    near = np.hypot(S.s_mx - C.STADIUM["x"], S.s_my - C.STADIUM["y"]) < 150
    assert (r.seg_vc[near] >= B.seg_vc[near]).all() and (r.seg_vc[near] > B.seg_vc[near] + 0.1).any()


def test_tc10_match_plus_bridge():
    m, b = run(dict(events=dict(match=True))), run(dict(events=dict(bridge="alaarcha")))
    both = run(dict(events=dict(match=True, bridge="alaarcha")))
    d = lambda r: r.city["delay"] - B.city["delay"]  # noqa: E731
    assert d(both) >= max(d(m), d(b)) - 1e-9


def test_tc11_monotone_fleet():
    prev = -math.inf
    for fl in range(-30, 51, 5):
        d = run(dict(fleet=fl)).city["delay"]
        assert d >= prev - 1e-9
        prev = d


@pytest.mark.parametrize("season", ["summer", "winter"])
def test_tc12_extremes_are_finite(season):
    for ev in (0, 100):
        for fleet in (-30, 50):
            for green in (-30, 30):
                r = run(dict(fleet=fleet, ev=ev, green=green,
                             objects=[dict(d="center", t="tc", n=9), dict(d="jal", t="jk", n=9), dict(d="jal", t="park", n=9)],
                             events=dict(match=True, closure="chuy", bridge="alamedin")), season)
                vals = [r.city["pm"], r.city["aqi"], r.city["delay"], r.city["speed"], r.city["comfort"], *r.aqi]
                assert all(math.isfinite(v) for v in vals)
                assert 0 <= r.city["aqi"] <= 500 and 0 <= r.city["comfort"] <= 100 and r.cat.max() <= 5


def test_tc13_deterministic_and_stateless():
    p = preset_params("uc05")
    a, b = S.simulate(p), S.simulate(p)
    assert a.city == b.city and np.array_equal(a.pm, b.pm)
    S.simulate(preset_params("uc05"))
    r = S.simulate(defaults("summer"))  # TC-15: сброс возвращает базу
    assert r.city["pm"] == B.city["pm"] and r.city["delay"] == B.city["delay"]


def test_tc14_fast_enough():
    rnd = random.Random(7)
    times = []
    for _ in range(100):
        r = S.simulate(dict(season=rnd.choice(["summer", "winter"]), fleet=rnd.uniform(-30, 50), ev=rnd.uniform(0, 100),
                            green=rnd.uniform(-30, 30),
                            events=dict(match=rnd.random() > .5, closure="chuy" if rnd.random() > .7 else None)))
        times.append(r.ms)
    assert sorted(times)[94] < 500  # требование ТЗ: < 0,5 с


def test_normalize_rejects_garbage():
    p = normalize(dict(fleet="abc", ev=float("nan"), objects=[dict(d="nope", t="jk"), dict(d="jal", t="zzz")],
                       events=dict(closure="x", bridge="y", venue="zzz", widen="q")))
    assert p["fleet"] == 0 and p["ev"] == P["base_ev"] and p["objects"] == []
    assert p["events"] == dict(closure=None, match=False, bridge=None, venue="omurzakov", widen=None)


def test_decompose_sums_to_total():
    p = preset_params("uc05")
    steps = S.decompose(p)
    total = S.simulate(p).city["aqi"]
    assert steps[-1]["value"]["aqi"] == pytest.approx(total)
    assert sum(s["delta"]["aqi"] for s in steps[1:]) == pytest.approx(total - steps[0]["value"]["aqi"])


def test_arena_match_is_local_and_heavier_there_than_old_stadium():
    v = C.STADIUMS["arena"]
    near = np.hypot(S.s_mx - v["x"], S.s_my - v["y"]) < 100   # 2.5 км вокруг «Бишкек Арены»
    far = np.hypot(S.s_mx - v["x"], S.s_my - v["y"]) > 320    # дальше 8 км
    old = run(dict(events=dict(match=True, venue="omurzakov")))
    new = run(dict(events=dict(match=True, venue="arena")))
    assert new.seg_vc[near].max() > old.seg_vc[near].max() + 0.5   # 51 тыс. зрителей у края города → затор рядом
    assert np.abs(new.seg_vc[far] - B.seg_vc[far]).max() < 0.01   # далеко от Арены ничего не меняется


def test_default_venue_keeps_old_behavior():
    a = run(dict(events=dict(match=True)))
    b = run(dict(events=dict(match=True, venue="omurzakov")))
    assert a.city == b.city


def test_attractions_park_adds_traffic_and_a_little_green():
    r = run(dict(objects=[dict(d="asanbay", t="fun", n=1)]))
    assert r.districts["asanbay"]["delay"] > B.districts["asanbay"]["delay"]
    assert r.districts["asanbay"]["green"] > B.districts["asanbay"]["green"]


def test_venues_are_inside_the_map():
    for v in C.VENUES:
        assert C.point_in_poly(v["x"], v["y"], C.OUTLINE), v["name"]


def _three_jk(ph):
    return dict(objects=[dict(d="jal", t="jk", n=3, ph=ph)])


def test_build_phase_has_dust_and_traffic_but_no_residents():
    bld, done = run(_three_jk("build")), run(_three_jk("done"))
    assert bld.districts["jal"]["pop"] == B.districts["jal"]["pop"]            # жителей ещё нет
    assert done.districts["jal"]["pop"] > B.districts["jal"]["pop"]            # после стройки жители появились
    assert bld.districts["jal"]["delay"] > B.districts["jal"]["delay"]         # техника и сужение проезда
    assert bld.districts["jal"]["pm"] > B.districts["jal"]["pm"]               # пыль
    assert done.districts["jal"]["school"] > bld.districts["jal"]["school"]    # школы перегружаются только после заселения


def test_build_and_done_do_not_merge():
    r = run(dict(objects=[dict(d="jal", t="jk", n=1, ph="build"), dict(d="jal", t="jk", n=1, ph="done")]))
    assert sorted(o["ph"] for o in r.params["objects"]) == ["build", "done"]


def test_new_arterial_reduces_delay_and_closure_wins():
    w = run(dict(events=dict(widen="chuy")))
    c = run(dict(events=dict(closure="chuy")))
    both = run(dict(events=dict(widen="chuy", closure="chuy")))
    assert w.city["delay"] < B.city["delay"] < c.city["delay"]
    assert both.city["delay"] == pytest.approx(c.city["delay"])               # ремонт перебивает расширение на тех же отрезках


def test_new_presets_exist():
    from twin_bishkek.simulator import preset_params
    assert preset_params("uc06")["objects"][0]["ph"] == "build"
    assert preset_params("uc07")["events"]["widen"] == "chuy"


def test_hour_none_keeps_daily_average():
    assert run(dict(hour=None)).city == B.city


def test_rush_hours_are_worse_than_night_for_traffic():
    night, morning, noon, evening, late = (run(dict(hour=h)).city["delay"] for h in (3, 8, 15, 18, 22))
    assert morning > noon and evening > noon                       # утренний и вечерний пики
    assert night < noon and late < 1.5                             # к ночи пробки заканчиваются (≈1 мин против ≈19 вечером)


def test_lunch_bump_between_peaks():
    assert run(dict(hour=13)).city["delay"] > run(dict(hour=15)).city["delay"]


def test_air_is_worst_in_the_evening_when_jams_are_over():
    # главный вывод по реальным датчикам: пробки к 22:00 заканчиваются, а воздух именно тогда хуже всего
    for season in ("summer", "winter"):
        late, afternoon = run(dict(hour=22), season), run(dict(hour=15), season)
        assert late.city["pm"] > afternoon.city["pm"]
        assert late.city["delay"] < afternoon.city["delay"]


def test_hour_average_matches_daily_baseline_delay():
    mean = sum(run(dict(hour=h)).city["delay"] for h in range(24)) / 24
    assert mean == pytest.approx(B.city["delay"], rel=0.05)         # профиль согласован с «Сегодня»


def test_hour_is_validated():
    assert normalize(dict(hour=25))["hour"] == 23
    assert normalize(dict(hour="abc"))["hour"] is None
    assert normalize(dict(hour=""))["hour"] is None


def test_time_presets():
    from twin_bishkek.simulator import preset_params
    assert preset_params("uc08")["hour"] == 18
    assert preset_params("uc09")["season"] == "winter" and preset_params("uc09")["hour"] == 22


# ---- дробный масштаб объекта и поправка нагрузки tk (план изменений: семьи, парковки)
def test_fractional_object_scale_is_kept():
    r = run(dict(objects=[dict(d="jal", t="jk", n=0.26, ph="done")]))
    assert r.params["objects"][0]["n"] == 0.26 and r.params["objects"][0]["tk"] == 1.0
    assert run(dict(objects=[dict(d="jal", t="jk", n=2)])).params["objects"][0]["n"] == 2  # целые остаются целыми


def test_parking_shortage_factor_loads_streets_more():
    ok = run(dict(objects=[dict(d="jal", t="jk", n=1, tk=1.0)]))
    bad = run(dict(objects=[dict(d="jal", t="jk", n=1, tk=1.4)]))
    assert bad.districts["jal"]["delay"] > ok.districts["jal"]["delay"] > B.districts["jal"]["delay"]


def test_objects_with_different_tk_merge_by_weight():
    r = run(dict(objects=[dict(d="jal", t="jk", n=1, tk=1.0), dict(d="jal", t="jk", n=3, tk=1.4)]))
    o = r.params["objects"][0]
    assert o["n"] == 4 and abs(o["tk"] - 1.3) < 1e-9


def test_object_scale_and_tk_are_clamped():
    o = run(dict(objects=[dict(d="jal", t="jk", n=100, tk=50)])).params["objects"][0]
    assert o["n"] == 9 and o["tk"] == 3.0
    o = run(dict(objects=[dict(d="jal", t="jk", n=0.001, tk=0)])).params["objects"][0]
    assert o["n"] == 0.05 and o["tk"] == 0.2


def test_evening_peak_is_not_all_red_like_2gis():
    """Подгонка к индексу 2GIS ≈4/10 в 18:00: в базовом состоянии большинство улиц не «затор»,
    а зелёного и жёлтого вместе не меньше 75% (пороги цвета те же, что в site/js/map.js)."""
    r = run(dict(hour=18))
    vc = r.seg_vc
    jam = float((vc >= 1.25).mean())
    assert 0.05 < jam < 0.30 and float((vc >= 1.5).mean()) < 0.05
    assert float((vc < 1.25).mean()) >= 0.75
    assert 12 < r.city["delay"] < 25                                 # заметно хуже, чем днём, но не 30+ минут
