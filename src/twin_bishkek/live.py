"""Живые данные: что сайт «видит» прямо сейчас и сохраняет, чтобы модель могла на этом учиться.

Идея заимствована у напарника (проект Twin_Bishkek_project), но встроена в нашу модель:

* каждые 15 минут фоновый поток берёт воздух (CAMS) и погоду из Open-Meteo и кладёт снимок в SQLite;
* пока открыта вкладка с картой 2GIS, страница шлёт сюда «индекс пробок» видимой области (0–10);
  не чаще раза в 15 минут на один вид карты;
* по накопленным замерам считаем, насколько суточный ритм модели совпадает с 2GIS
  (корреляция) и, когда данных достаточно, осторожную поправку по часам (`learned()`).

Что НЕ делаем: не снимаем плитки карты, не вытаскиваем цвета улиц и не опрашиваем 2GIS с сервера.
Берём только тот балл, который сама карта отдаёт странице через официальный MapGL.

Файл базы: data/live/twin_live.sqlite3 (переопределяется переменной TB_LIVE_DB). Удалите его, чтобы очистить историю.
"""
from __future__ import annotations

import csv
import json
import logging
import math
import os
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import requests

LOG = logging.getLogger("twin_bishkek.live")
TZ = ZoneInfo("Asia/Bishkek")
LAT, LON = 42.8746, 74.5698  # центр Бишкека (как в data_download)
BBOX = (74.40, 42.70, 74.80, 42.98)  # запад, юг, восток, север: замеры вне города отбрасываем
THROTTLE_MIN = 15  # один замер на вид карты за 15 минут
INTERVAL_S = 900  # период сборщика воздуха
CITY_ZOOM = (9.5, 13.5)  # индекс 2GIS сравниваем с моделью только для видов «весь город»
MIN_HOURS, MIN_DAYS, MIN_PER_HOUR = 6, 4, 3  # порог, с которого поправку вообще включаем
MULT_RANGE = (0.75, 1.25)  # поправка не может менять нагрузку часа больше чем на 25%

ROOT = Path(os.environ.get("TB_ROOT", Path(__file__).resolve().parents[2]))


def default_db_path() -> Path:
    return Path(os.environ.get("TB_LIVE_DB", ROOT / "data" / "live" / "twin_live.sqlite3"))


def now_bishkek() -> datetime:
    return datetime.now(TZ)


def season_of(dt: datetime) -> str:
    return "winter" if dt.month in (11, 12, 1, 2, 3) else "summer"


# ---------------------------------------------------------------- хранилище
class LiveStore:
    def __init__(self, path: str | Path | None = None) -> None:
        self.path = Path(path) if path else default_db_path()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._init()

    @contextmanager
    def _db(self):
        con = sqlite3.connect(self.path, timeout=10)
        con.row_factory = sqlite3.Row
        try:
            yield con
            con.commit()
        except Exception:
            con.rollback()
            raise
        finally:
            con.close()

    def _init(self) -> None:
        with self._lock, self._db() as c:
            c.execute("PRAGMA journal_mode=WAL")
            c.execute("""CREATE TABLE IF NOT EXISTS traffic_observations (
                id INTEGER PRIMARY KEY,
                observed_at TEXT NOT NULL, day_type TEXT NOT NULL, hour INTEGER NOT NULL, season TEXT NOT NULL,
                score REAL NOT NULL, center_lon REAL NOT NULL, center_lat REAL NOT NULL, zoom REAL NOT NULL,
                view_key TEXT NOT NULL, model_delay REAL, model_speed REAL,
                source TEXT NOT NULL DEFAULT '2GIS MapGL traffic score')""")
            c.execute("CREATE INDEX IF NOT EXISTS traffic_view_idx ON traffic_observations(view_key, observed_at)")
            c.execute("CREATE INDEX IF NOT EXISTS traffic_hour_idx ON traffic_observations(day_type, hour)")
            c.execute("""CREATE TABLE IF NOT EXISTS environment_snapshots (
                id INTEGER PRIMARY KEY,
                captured_at TEXT NOT NULL, air_time TEXT, weather_time TEXT,
                pm2_5 REAL, pm10 REAL, no2 REAL, us_aqi REAL, temperature REAL, humidity REAL,
                wind_speed REAL, wind_dir REAL, payload_json TEXT NOT NULL,
                UNIQUE(air_time, weather_time))""")

    # ---- воздух и погода
    def save_environment(self, env: dict) -> bool:
        air, wx = env.get("air") or {}, env.get("weather") or {}
        with self._lock, self._db() as c:
            cur = c.execute(
                """INSERT OR IGNORE INTO environment_snapshots
                (captured_at, air_time, weather_time, pm2_5, pm10, no2, us_aqi, temperature, humidity, wind_speed, wind_dir, payload_json)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
                (now_bishkek().isoformat(timespec="seconds"), str(air.get("time") or ""), str(wx.get("time") or ""),
                 air.get("pm2_5"), air.get("pm10"), air.get("nitrogen_dioxide"), air.get("us_aqi"),
                 wx.get("temperature_2m"), wx.get("relative_humidity_2m"), wx.get("wind_speed_10m"),
                 wx.get("wind_direction_10m"), json.dumps(env, ensure_ascii=False, separators=(",", ":"))))
            return cur.rowcount > 0

    def latest_environment(self) -> dict | None:
        with self._lock, self._db() as c:
            r = c.execute("SELECT payload_json, captured_at FROM environment_snapshots ORDER BY id DESC LIMIT 1").fetchone()
        if not r:
            return None
        out = json.loads(r["payload_json"])
        out["captured_at"] = r["captured_at"]
        return out

    # ---- пробки 2GIS
    def add_traffic(self, score: float, lon: float, lat: float, zoom: float,
                    model_delay: float | None = None, model_speed: float | None = None,
                    now: datetime | None = None) -> dict:
        if not (math.isfinite(score) and 0 <= score <= 10):
            raise ValueError("score должен быть числом от 0 до 10")
        if not (BBOX[0] <= lon <= BBOX[2] and BBOX[1] <= lat <= BBOX[3]):
            raise ValueError("замер вне Бишкека")
        if not (1 <= zoom <= 22):
            raise ValueError("zoom вне диапазона")
        now = now or now_bishkek()
        day_type = "weekend" if now.weekday() >= 5 else "weekday"
        view_key = f"{lon:.2f}:{lat:.2f}:{round(zoom)}"
        cutoff = (now - timedelta(minutes=THROTTLE_MIN)).isoformat(timespec="seconds")
        with self._lock, self._db() as c:
            if c.execute("SELECT 1 FROM traffic_observations WHERE view_key=? AND observed_at>=? LIMIT 1", (view_key, cutoff)).fetchone():
                return dict(stored=False, throttled=True)
            c.execute(
                """INSERT INTO traffic_observations(observed_at, day_type, hour, season, score, center_lon, center_lat, zoom, view_key, model_delay, model_speed)
                VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
                (now.isoformat(timespec="seconds"), day_type, now.hour, season_of(now), float(score),
                 round(lon, 4), round(lat, 4), round(zoom, 1), view_key, model_delay, model_speed))
        return dict(stored=True, throttled=False)

    def status(self) -> dict:
        with self._lock, self._db() as c:
            t = c.execute("SELECT COUNT(*) n, MAX(observed_at) last, COUNT(DISTINCT substr(observed_at,1,10)) days FROM traffic_observations").fetchone()
            e = c.execute("SELECT COUNT(*) n, MAX(captured_at) last FROM environment_snapshots").fetchone()
        return dict(traffic_observations=t["n"], traffic_days=t["days"], traffic_last=t["last"],
                    environment_snapshots=e["n"], environment_last=e["last"], storage=str(self.path.name),
                    traffic_source="2GIS MapGL · индекс пробок видимой области", environment_source="Open-Meteo · CAMS Global + прогноз погоды")

    # ---- агрегаты для обучения
    def hourly(self, day_type: str = "weekday") -> list[dict]:
        """По каждому часу: сколько замеров «весь город», в скольких разных днях, средний балл 2GIS, средняя задержка модели."""
        with self._lock, self._db() as c:
            rows = c.execute(
                """SELECT hour, COUNT(*) n, COUNT(DISTINCT substr(observed_at,1,10)) days, AVG(score) score, AVG(model_delay) model_delay
                FROM traffic_observations WHERE day_type=? AND zoom BETWEEN ? AND ? GROUP BY hour ORDER BY hour""",
                (day_type, *CITY_ZOOM)).fetchall()
        got = {r["hour"]: dict(r) for r in rows}
        return [dict(hour=h, n=got[h]["n"], days=got[h]["days"], score=got[h]["score"], model_delay=got[h]["model_delay"])
                if h in got else dict(hour=h, n=0, days=0, score=None, model_delay=None) for h in range(24)]

    def export_hourly_csv(self, out: str | Path) -> Path:
        """Почасовая таблица (воздух + погода + балл 2GIS) в формате, который можно подмешать к hourly.csv для ml.py."""
        with self._lock, self._db() as c:
            env = c.execute("""SELECT substr(air_time,1,13)||':00' t, AVG(pm2_5) pm2_5, AVG(pm10) pm10, AVG(no2) no2, AVG(us_aqi) us_aqi,
                AVG(temperature) temperature_2m, AVG(humidity) relative_humidity_2m, AVG(wind_speed) wind_speed_10m
                FROM environment_snapshots WHERE air_time!='' GROUP BY 1""").fetchall()
            trf = c.execute("""SELECT substr(observed_at,1,13)||':00' t, AVG(score) traffic_score_2gis, COUNT(*) n_traffic
                FROM traffic_observations WHERE zoom BETWEEN ? AND ? GROUP BY 1""", CITY_ZOOM).fetchall()
        rows: dict[str, dict] = {}
        for r in env:
            rows.setdefault(r["t"].replace("T", " "), {}).update({k: r[k] for k in r.keys() if k != "t"})
        for r in trf:
            rows.setdefault(r["t"].replace("T", " "), {}).update({k: r[k] for k in r.keys() if k != "t"})
        cols = ["time", "pm2_5", "pm10", "no2", "us_aqi", "temperature_2m", "relative_humidity_2m", "wind_speed_10m", "traffic_score_2gis", "n_traffic"]
        out = Path(out)
        out.parent.mkdir(parents=True, exist_ok=True)
        with out.open("w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=cols)
            w.writeheader()
            for t in sorted(rows):
                w.writerow({"time": t, **{k: rows[t].get(k) for k in cols[1:]}})
        return out


# ---------------------------------------------------------------- «обучение»
def learn(hourly: list[dict], traffic_profile: list[float]) -> dict:
    """Сверяем суточный ритм модели (TIME.traffic) с баллами 2GIS и, если данных хватает, считаем поправку по часам.

    score(h) ≈ a + b · g(h), где g(h) — нагрузка часа в модели. Линейная связь подбирается по часам, где замеров достаточно.
    Поправка часа = (score−a)/b / g, но с усадкой к 1: чем меньше замеров и дней, тем меньше доверия. Диапазон 0.75…1.25.
    Если корреляция слабая (< 0.5) или b ≤ 0, поправку не включаем: модель и карта расходятся, и подгонять нечем.
    """
    ok = [r for r in hourly if r["n"] >= MIN_PER_HOUR and r["score"] is not None]
    days = max([r["days"] for r in ok], default=0)
    out = dict(usable=False, reason="", hours_covered=len(ok), days=days, correlation=None, a=None, b=None,
               mult=[1.0] * 24, per_hour=[], samples=sum(r["n"] for r in hourly))
    if len(ok) < MIN_HOURS or days < MIN_DAYS:
        out["reason"] = f"Мало данных: нужно хотя бы {MIN_HOURS} часов суток с {MIN_PER_HOUR}+ замерами и {MIN_DAYS} разных дней (сейчас {len(ok)} ч, {days} дн.)."
        return out
    g = [traffic_profile[r["hour"]] for r in ok]
    s = [r["score"] for r in ok]
    mg, ms = sum(g) / len(g), sum(s) / len(s)
    var_g = sum((x - mg) ** 2 for x in g)
    var_s = sum((y - ms) ** 2 for y in s)
    if var_g == 0 or var_s == 0:
        out["reason"] = "Баллы 2GIS (или нагрузка модели) не меняются по часам: сравнивать нечего."
        return out
    cov = sum((x - mg) * (y - ms) for x, y in zip(g, s))
    b = cov / var_g
    a = ms - b * mg
    r = cov / math.sqrt(var_g * var_s)
    out.update(correlation=round(r, 3), a=round(a, 3), b=round(b, 3))
    if r < 0.5 or b <= 0:
        out["reason"] = f"Суточный ритм модели слабо совпадает с 2GIS (корреляция {r:.2f}): поправку не применяем, это сигнал перепроверить модель."
        return out
    lo, hi = MULT_RANGE
    for row in ok:
        h = row["hour"]
        implied = (row["score"] - a) / b  # какая нагрузка соответствует баллу
        raw = implied / traffic_profile[h] if traffic_profile[h] > 1e-6 else 1.0
        w = min(1.0, row["n"] / 12) * min(1.0, row["days"] / 5)
        m = min(hi, max(lo, 1 + w * (raw - 1)))
        out["mult"][h] = round(m, 3)
        out["per_hour"].append(dict(hour=h, n=row["n"], days=row["days"], score=round(row["score"], 2), model=round(traffic_profile[h], 3),
                                    implied=round(implied, 3), weight=round(w, 2), mult=round(m, 3)))
    out["usable"] = True
    out["reason"] = f"Поправка по {len(ok)} часам суток, корреляция ритма модели и 2GIS {r:.2f}."
    return out


# ---------------------------------------------------------------- воздух и погода из Open-Meteo
def _get(url: str, params: dict) -> dict:
    r = requests.get(url, params=params, timeout=15, headers={"User-Agent": "TwinBishkek/1.0"})
    r.raise_for_status()
    return r.json()


def fetch_environment() -> dict:
    """Текущий воздух (CAMS Global, ячейка ~45 км: это фон, не уличный датчик) и погода + прогноз на сутки вперёд."""
    pt = {"latitude": LAT, "longitude": LON, "timezone": "Asia/Bishkek"}
    air = _get("https://air-quality-api.open-meteo.com/v1/air-quality", {
        **pt, "domains": "cams_global", "forecast_hours": 24,
        "current": "pm2_5,pm10,nitrogen_dioxide,ozone,us_aqi,european_aqi", "hourly": "pm2_5,pm10,us_aqi"})
    wx = _get("https://api.open-meteo.com/v1/forecast", {
        **pt, "forecast_hours": 24,
        "current": "temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m",
        "hourly": "temperature_2m,wind_speed_10m,wind_direction_10m"})

    def rows(h: dict, fields: tuple) -> list[dict]:
        t = h.get("time", [])
        return [dict(time=t[i], **{f: (h.get(f) or [None] * len(t))[i] for f in fields}) for i in range(len(t))]

    return dict(available=True, source="Open-Meteo · CAMS Global", resolution_km=45,
                note="Ячейка CAMS около 45 км: это модельный фон города, а не датчик у дороги.",
                air=air.get("current", {}), weather=wx.get("current", {}),
                air_forecast=rows(air.get("hourly", {}), ("pm2_5", "pm10", "us_aqi")),
                weather_forecast=rows(wx.get("hourly", {}), ("temperature_2m", "wind_speed_10m", "wind_direction_10m")))


class Collector:
    """Фоновый поток: раз в 15 минут забирает воздух/погоду. Ошибка сети не останавливает поток."""

    def __init__(self, store: LiveStore, interval: float = INTERVAL_S, fetch=fetch_environment) -> None:
        self.store, self.interval, self.fetch = store, interval, fetch
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.last_error: str | None = None
        self.runs = 0

    def tick(self) -> bool:
        try:
            env = self.fetch()
            self.last_error = None
            self.runs += 1
            return self.store.save_environment(env)
        except Exception as e:  # noqa: BLE001 — любая сетевая беда не должна ронять сервер
            self.last_error = f"{type(e).__name__}: {e}"[:200]
            LOG.warning("сборщик: %s", self.last_error)
            return False

    def _loop(self) -> None:
        while not self._stop.is_set():
            self.tick()
            self._stop.wait(self.interval)

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="twin-bishkek-collector", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()


_store: LiveStore | None = None


def get_store() -> LiveStore:
    global _store
    if _store is None:
        _store = LiveStore()
    return _store


def main() -> None:
    import argparse

    ap = argparse.ArgumentParser(description="Живые данные Twin Bishkek")
    ap.add_argument("cmd", choices=["status", "export", "learn", "collect-once"])
    ap.add_argument("--out", default=str(ROOT / "data" / "processed" / "live_hourly.csv"))
    a = ap.parse_args()
    st = get_store()
    if a.cmd == "status":
        print(json.dumps(st.status(), ensure_ascii=False, indent=2))
    elif a.cmd == "export":
        print("записано:", st.export_hourly_csv(a.out))
    elif a.cmd == "collect-once":
        print("новый снимок" if Collector(st).tick() else "нового снимка нет (или ошибка сети)")
    else:
        from . import city as C

        print(json.dumps(learn(st.hourly(), C.TIME["traffic"]), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
