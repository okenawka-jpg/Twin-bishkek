"""Посадка деревьев: порода, количество, возраст, место; польза и полив. Проверяются направления эффектов, а не точные числа."""
import math

import pytest

from twin_bishkek.simulator import TREES, crown_at, defaults, get_simulator, grown_age, normalize

S = get_simulator()


def run(trees=(), **kw):
    return S.simulate({**defaults(kw.pop("season", "summer")), **kw, "trees": list(trees)})


def tree(sp="karagach", n=2000, age=10, **at):
    return dict(sp=sp, n=n, age=age, **(at or dict(d="jal")))


B = run()


def test_normalize_trees():
    ts = normalize(dict(trees=[
        dict(sp="baobab", n=10, d="jal"),                     # неизвестная порода
        dict(sp="lipa", n=10, d="nowhere"),                   # нет места
        dict(sp="lipa", n="abc", age=99.6, s="chuy"),
        dict(sp="dub", n=0.4, age=-3, pts=[[10.5, 10], [20, 10]]),
        dict(sp="el", n=5, d="jal", s="chuy"),                # район важнее улицы
    ]))["trees"]
    assert ts == [dict(sp="lipa", n=100, age=60, s="chuy"), dict(sp="dub", n=1, age=0, pts=[[11, 10], [20, 10]]),
                  dict(sp="el", n=5, age=0, d="jal")]
    assert len(normalize(dict(trees=[tree()] * 10))["trees"]) == TREES["max"]


def test_crown_grows_and_saturates():
    for sp in TREES["species"]:
        a = [crown_at(sp, y) for y in (0, 5, 15, 40)]
        assert a[0] == TREES["crown0"] and a[0] < a[1] < a[2] < a[3] < TREES["species"][sp]["crown"]
        assert crown_at(sp, grown_age(sp)) == pytest.approx(0.8 * TREES["species"][sp]["crown"])
    assert grown_age("topol") < grown_age("dub")  # тополь растёт быстрее дуба


def test_older_trees_give_more_shade_co2_and_comfort():
    young, old = run([tree(age=1)]), run([tree(age=20)])
    assert old.trees["canopy"] > young.trees["canopy"] > 0
    assert old.trees["co2"] > young.trees["co2"] and old.trees["pm"] > young.trees["pm"]
    assert old.city["comfort"] > young.city["comfort"] >= B.city["comfort"]
    assert old.districts["jal"]["green"] > B.districts["jal"]["green"]
    assert old.districts["jal"]["cool"] > 0 and old.trees["cool"] == old.districts["jal"]["cool"]


def test_canopy_and_benefits_follow_the_formulas():
    t = run([tree(sp="platan", n=1000, age=10)]).trees
    each = math.pi * crown_at("platan", 10) ** 2 / 4
    assert t["canopy"] == pytest.approx(each * 1000)
    assert t["co2"] == pytest.approx(each * 1000 * TREES["co2_rate"] / 1000)
    assert sum(c for _, c in t["hexes"]) == pytest.approx(t["canopy"])


def test_trees_slightly_clean_the_air_and_evergreens_work_in_winter():
    r = run([tree(n=20000, age=20, d="center")])
    assert r.city["pm"] < B.city["pm"]
    W = run(season="winter")
    dec = run([tree(sp="lipa", n=20000, age=40, d="center")], season="winter").districts["center"]["pm"]
    ever = run([tree(sp="sosna", n=20000, age=40, d="center")], season="winter").districts["center"]["pm"]
    assert ever < dec < W.districts["center"]["pm"]  # зимой голые лиственные задерживают меньше пыли


def test_no_cooling_in_winter():
    assert run([tree(age=20)], season="winter").trees["cool"] == 0


def test_watering_trucks_jam_streets_only_in_summer_morning():
    st = [tree(n=20000, age=0, s="chuy")]
    m, d = run(st, hour=8), run(st, hour=14)
    assert m.city["delay"] > run(hour=8).city["delay"]          # утром водовозы занимают полосу
    assert d.city["delay"] == pytest.approx(run(hour=14).city["delay"])  # днём не поливают
    assert run(st, season="winter", hour=8).city["delay"] == pytest.approx(run(season="winter", hour=8).city["delay"])
    w = m.trees["plantings"][0]["water"]
    assert w and all(S.s_street[i] == "chuy" for i in w)


def test_district_planting_is_watered_inside_yards_not_on_roads():
    assert run([tree(n=20000, age=0)], hour=8).city["delay"] == pytest.approx(run(hour=8).city["delay"])


def test_old_trees_need_fewer_trucks():
    young = run([tree(n=20000, age=0, s="chuy")]).trees
    old = run([tree(n=20000, age=10, s="chuy")]).trees
    assert old["trips"] < young["trips"]
    assert len(old["plantings"][0]["water"]) <= len(young["plantings"][0]["water"])


def test_decompose_has_trees_step():
    steps = S.decompose(normalize(dict(trees=[tree(age=20)])))
    assert "trees" in [s["key"] for s in steps]
