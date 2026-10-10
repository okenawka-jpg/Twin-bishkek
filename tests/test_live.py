"""Тесты «живых данных»: хранилище, троттлинг замеров, сборщик, обучение по 2GIS."""
from datetime import datetime, timedelta

import pytest

from twin_bishkek import city as C
from twin_bishkek import live
from twin_bishkek.simulator import Simulator

TZ = live.TZ
CITY = dict(lon=74.60, lat=42.87, zoom=11.0)


def store(tmp_path):
    return live.LiveStore(tmp_path / "t.sqlite3")


def at(day, hour, minute=0):
    return datetime(2026, 10, day, hour, minute, tzinfo=TZ)  # 5 окт 2026 = понедельник


def test_traffic_is_throttled_per_view(tmp_path):
    s = store(tmp_path)
    assert s.add_traffic(5.0, **CITY, now=at(5, 8, 0))["stored"]
    assert s.add_traffic(6.0, **CITY, now=at(5, 8, 10))["throttled"]  # тот же вид, меньше 15 минут
    assert s.add_traffic(6.0, **CITY, now=at(5, 8, 16))["stored"]
    assert s.add_traffic(6.0, lon=74.70, lat=42.90, zoom=11.0, now=at(5, 8, 10))["stored"]  # другой вид карты
    assert s.status()["traffic_observations"] == 3


def test_traffic_rejects_garbage(tmp_path):
    s = store(tmp_path)
    for bad in (dict(score=11, **CITY), dict(score=float("nan"), **CITY), dict(score=5, lon=10, lat=42.87, zoom=11),
                dict(score=5, lon=74.6, lat=42.87, zoom=0)):
        with pytest.raises(ValueError):
            s.add_traffic(**bad)
    assert s.status()["traffic_observations"] == 0


def test_weekend_is_labelled(tmp_path):
    s = store(tmp_path)
    s.add_traffic(4.0, **CITY, now=at(10, 12))  # суббота
    assert s.hourly("weekend")[12]["n"] == 1 and s.hourly("weekday")[12]["n"] == 0


def test_environment_snapshot_is_deduplicated(tmp_path):
    s = store(tmp_path)
    env = dict(air=dict(time="2026-10-08T12:00", pm2_5=21.5, pm10=30.0, us_aqi=72), weather=dict(time="2026-10-08T12:00", temperature_2m=14.2, wind_speed_10m=6.0))
    assert s.save_environment(env) is True
    assert s.save_environment(env) is False  # тот же момент провайдера
    got = s.latest_environment()
    assert got["air"]["pm2_5"] == 21.5 and s.status()["environment_snapshots"] == 1


def test_collector_survives_network_errors(tmp_path):
    s = store(tmp_path)

    def boom():
        raise RuntimeError("нет сети")

    c = live.Collector(s, fetch=boom)
    assert c.tick() is False and "нет сети" in c.last_error
    c2 = live.Collector(s, fetch=lambda: dict(air=dict(time="t1", pm2_5=10), weather=dict(time="t1")))
    assert c2.tick() is True and c2.last_error is None and s.status()["environment_snapshots"] == 1


def _fill(s, days, shape, noise=0.0):
    """Подмешиваем замеры: балл 2GIS = 1 + 6·g(h) (идеально совпадающий с моделью ритм) в рабочие дни, весь город."""
    for d in days:
        for h in range(6, 23):
            s.add_traffic(1 + 6 * shape(h) + noise, **CITY, now=at(d, h, 5))


def test_learn_needs_enough_data(tmp_path):
    s = store(tmp_path)
    _fill(s, [5], lambda h: C.TIME["traffic"][h])
    L = live.learn(s.hourly(), C.TIME["traffic"])
    assert not L["usable"] and L["mult"] == [1.0] * 24 and "Мало данных" in L["reason"]


def test_learn_agrees_when_model_matches_2gis(tmp_path):
    s = store(tmp_path)
    prof = C.TIME["traffic"]
    for d in (5, 6, 7, 8, 9):
        for k in range(3):  # 3 замера в час (разные виды карты, чтобы не сработал троттлинг)
            for h in range(6, 23):
                s.add_traffic(1 + 6 * prof[h], lon=74.55 + 0.02 * k, lat=42.87, zoom=11.0, now=at(d, h, 5))
    L = live.learn(s.hourly(), prof)
    assert L["usable"] and L["correlation"] > 0.99
    assert all(0.75 <= m <= 1.25 for m in L["mult"])
    assert max(abs(m - 1) for m in L["mult"]) < 0.05  # ритм совпал, поправка почти не нужна


def test_learn_corrects_a_shifted_evening(tmp_path):
    """Если в 2GIS вечерний пик выше, чем в модели, час должен получить поправку > 1, но в пределах диапазона."""
    s = store(tmp_path)
    prof = C.TIME["traffic"]
    for d in (5, 6, 7, 8, 9, 12):
        for k in range(4):
            for h in range(6, 23):
                g = prof[h] * (1.2 if h == 18 else 1.0)
                s.add_traffic(1 + 5 * g, lon=74.55 + 0.02 * k, lat=42.87, zoom=11.0, now=at(d, h, 5))
    L = live.learn(s.hourly(), prof)
    assert L["usable"] and 1.0 < L["mult"][18] <= 1.25
    assert abs(L["mult"][13] - 1) < abs(L["mult"][18] - 1)


def test_learn_refuses_when_rhythm_disagrees(tmp_path):
    s = store(tmp_path)
    prof = C.TIME["traffic"]
    for d in (5, 6, 7, 8, 9):
        for k in range(3):
            for h in range(6, 23):
                s.add_traffic(1 + 6 * (max(prof) - prof[h]), lon=74.55 + 0.02 * k, lat=42.87, zoom=11.0, now=at(d, h, 5))  # наоборот
    L = live.learn(s.hourly(), prof)
    assert not L["usable"] and L["mult"] == [1.0] * 24


def test_close_up_views_are_not_used_for_learning(tmp_path):
    s = store(tmp_path)
    s.add_traffic(9.0, lon=74.6, lat=42.87, zoom=16.0, now=at(5, 18))  # крупный план одного перекрёстка
    assert s.hourly()[18]["n"] == 0 and s.status()["traffic_observations"] == 1


def test_tmul_changes_only_the_chosen_hour():
    sim = Simulator()
    base = sim.simulate({"hour": 18}).city["delay"]
    up = sim.simulate({"hour": 18, "tmul": [1.0] * 18 + [1.2] + [1.0] * 5}).city["delay"]
    other = sim.simulate({"hour": 8, "tmul": [1.0] * 18 + [1.2] + [1.0] * 5}).city["delay"]
    assert up > base
    assert other == sim.simulate({"hour": 8}).city["delay"]
    assert sim.simulate({"hour": 18, "tmul": [5.0] * 24}).city["delay"] <= sim.simulate({"hour": 18, "tmul": [1.25] * 24}).city["delay"] + 1e-9
    assert sim.simulate({"hour": 18, "tmul": [1.0, 2.0]}).city["delay"] == base  # кривая длина игнорируется


def test_seed_round_trip_without_duplicates(tmp_path):
    a = store(tmp_path)
    a.add_traffic(5.0, **CITY, now=at(5, 8))
    a.save_environment(dict(air=dict(time="t1", pm2_5=10), weather=dict(time="w1")))
    seed = a.export_seed(tmp_path / "seed.json")
    b = live.LiveStore(tmp_path / "b.sqlite3")
    assert b.import_seed(seed) == dict(traffic=1, environment=1)
    assert b.import_seed(seed) == dict(traffic=0, environment=0)  # повторный старт сервера не дублирует
    assert b.status()["traffic_observations"] == 1 and b.status()["environment_snapshots"] == 1


def test_export_csv_joins_air_and_traffic(tmp_path):
    s = store(tmp_path)
    s.save_environment(dict(air=dict(time="2026-10-05T08:00", pm2_5=20.0), weather=dict(time="2026-10-05T08:00", temperature_2m=9.0)))
    s.add_traffic(7.0, **CITY, now=at(5, 8, 20))
    out = s.export_hourly_csv(tmp_path / "x.csv")
    lines = out.read_text(encoding="utf-8").splitlines()
    assert lines[0].startswith("time,pm2_5") and lines[1].startswith("2026-10-05 08:00,20.0")
    assert lines[1].split(",")[-2] == "7.0"
