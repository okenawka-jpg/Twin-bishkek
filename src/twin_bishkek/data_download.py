"""Загрузка данных для Twin Bishkek.

    python -m twin_bishkek.data_download weather --start 2023-01-01
    python -m twin_bishkek.data_download air --start 2023-01-01
    python -m twin_bishkek.data_download openaq --start 2023-01-01      # нужен OPENAQ_API_KEY
    python -m twin_bishkek.data_download osm                            # нужен osmnx
    python -m twin_bishkek.data_download osm_extra                      # реки, микрорайоны, стадионы, мосты
    python -m twin_bishkek.data_download merge                          # → data/processed/hourly.csv
    python -m twin_bishkek.data_download all --start 2023-01-01

Источники:
  * Open-Meteo Historical Weather (ERA5)  — погода, без ключа.
  * Open-Meteo Air Quality (CAMS, модель) — PM2.5/PM10/NO2, без ключа. Это МОДЕЛЬ, не датчики:
    годится для старта, но для калибровки нужны наземные станции (OpenAQ / AirGradient / посольство США).
  * OpenAQ v3 — наземные датчики, бесплатный ключ: https://explore.openaq.org
  * OSM — улицы, зелень, школы, больницы.

ВАЖНО: параметры API проверены по документации, но скрипт не гонялся в среде без сети.
При первом запуске смотрите на сообщения об ошибках и поправьте имена переменных.
"""
from __future__ import annotations

import argparse
import datetime as dt
import os
import time
from pathlib import Path

import pandas as pd
import requests

LAT, LON = 42.8746, 74.5698  # центр Бишкека
ROOT = Path(os.environ.get("TB_ROOT", Path(__file__).resolve().parents[2]))
RAW, PROC = ROOT / "data" / "raw", ROOT / "data" / "processed"

WEATHER_VARS = ["temperature_2m", "relative_humidity_2m", "pressure_msl", "precipitation",
                "wind_speed_10m", "wind_direction_10m", "cloud_cover"]
WEATHER_EXTRA = ["boundary_layer_height"]  # высота слоя перемешивания: ключевая для зимних инверсий
AIR_VARS = ["pm2_5", "pm10", "nitrogen_dioxide", "us_aqi"]


def _get(url: str, params: dict, headers: dict | None = None, retries: int = 4) -> dict:
    for k in range(retries):
        r = requests.get(url, params=params, headers=headers, timeout=60)
        if r.status_code in (408, 429) or r.status_code >= 500:
            time.sleep(2 ** k * 2)
            continue
        if r.status_code >= 400:
            raise RuntimeError(f"{r.status_code} {url}: {r.text[:300]}")
        return r.json()
    raise RuntimeError(f"не удалось получить {url}")


def _hourly_frame(js: dict) -> pd.DataFrame:
    df = pd.DataFrame(js["hourly"])
    df["time"] = pd.to_datetime(df["time"])
    return df.set_index("time")


def download_weather(start: str, end: str) -> Path:
    url = "https://archive-api.open-meteo.com/v1/archive"
    base = dict(latitude=LAT, longitude=LON, start_date=start, end_date=end, timezone="Asia/Bishkek")
    try:
        js = _get(url, {**base, "hourly": ",".join(WEATHER_VARS + WEATHER_EXTRA)})
    except RuntimeError as e:  # если переменная недоступна в архиве — берём без неё
        print("[weather] без boundary_layer_height:", str(e)[:120])
        js = _get(url, {**base, "hourly": ",".join(WEATHER_VARS)})
    out = RAW / "weather_openmeteo.csv"
    RAW.mkdir(parents=True, exist_ok=True)
    _hourly_frame(js).to_csv(out)
    print(f"[weather] {out}")
    return out


def download_air(start: str, end: str) -> Path:
    """CAMS-реанализ у Open-Meteo доступен примерно с середины 2022 года; запрашиваем кусками по году."""
    url = "https://air-quality-api.open-meteo.com/v1/air-quality"
    frames, s = [], dt.date.fromisoformat(start)
    e = dt.date.fromisoformat(end)
    while s <= e:
        chunk_end = min(e, s + dt.timedelta(days=364))
        js = _get(url, dict(latitude=LAT, longitude=LON, hourly=",".join(AIR_VARS), timezone="Asia/Bishkek",
                            start_date=s.isoformat(), end_date=chunk_end.isoformat()))
        frames.append(_hourly_frame(js))
        s = chunk_end + dt.timedelta(days=1)
    out = RAW / "air_openmeteo_cams.csv"
    RAW.mkdir(parents=True, exist_ok=True)
    pd.concat(frames).to_csv(out)
    print(f"[air] {out}")
    return out


def download_openaq(start: str, end: str, radius_m: int = 25000) -> Path:
    """Наземные станции PM2.5 вокруг Бишкека (OpenAQ v3). Агрегируем в среднее по городу по часам."""
    key = os.environ.get("OPENAQ_API_KEY")
    if not key:
        raise SystemExit("Задайте OPENAQ_API_KEY (бесплатно: https://explore.openaq.org)")
    h = {"X-API-Key": key}
    base = "https://api.openaq.org/v3"
    locs = _get(f"{base}/locations", dict(coordinates=f"{LAT},{LON}", radius=radius_m, limit=1000), h)["results"]
    sensors = []
    for loc in locs:
        for s in loc.get("sensors", []):
            if s.get("parameter", {}).get("name") == "pm25":
                sensors.append((s["id"], loc.get("name"), loc["coordinates"]["latitude"], loc["coordinates"]["longitude"]))
    print(f"[openaq] станций с PM2.5: {len(sensors)}")
    rows, skipped = [], 0
    t_start, t_end = dt.date.fromisoformat(start[:10]), dt.date.fromisoformat(end[:10])
    for n, (sid, name, lat, lon) in enumerate(sensors, 1):
        got, cur = 0, t_start
        while cur <= t_end:  # маленькие куски по 30 дней: большой запрос сервер не успевает обработать
            nxt = min(t_end, cur + dt.timedelta(days=29))
            try:
                page = 1
                while True:
                    js = _get(f"{base}/sensors/{sid}/hours",
                              dict(datetime_from=f"{cur}T00:00:00Z", datetime_to=f"{nxt}T23:59:59Z", limit=1000, page=page), h, retries=3)
                    res = js.get("results", [])
                    for r in res:
                        rows.append(dict(time=r["period"]["datetimeFrom"]["local"], sensor=sid, station=name, lat=lat, lon=lon, pm25=r["value"]))
                    got += len(res)
                    if len(res) < 1000:
                        break
                    page += 1
            except RuntimeError as e:  # не роняем всё из-за одного куска
                skipped += 1
                print(f"[openaq] пропущен кусок {cur}…{nxt} датчика {sid}: {str(e)[:80]}")
            cur = nxt + dt.timedelta(days=1)
            time.sleep(0.2)  # лимиты OpenAQ
        print(f"[openaq] датчик {n}/{len(sensors)} ({name}): {got} часов")
    if skipped:
        print(f"[openaq] всего пропущено кусков: {skipped}")
    out = RAW / "openaq_pm25_hourly.csv"
    RAW.mkdir(parents=True, exist_ok=True)
    pd.DataFrame(rows).to_csv(out, index=False)
    print(f"[openaq] {out} ({len(rows)} строк)")
    return out


def download_osm() -> None:
    try:
        import osmnx as ox
    except ImportError:
        raise SystemExit("pip install osmnx geopandas")
    place = "Bishkek, Kyrgyzstan"
    out = RAW / "osm"
    out.mkdir(parents=True, exist_ok=True)
    ox.geocode_to_gdf(place).to_file(out / "boundary.geojson", driver="GeoJSON")
    g = ox.graph_from_place(place, network_type="drive")
    _, edges = ox.graph_to_gdfs(g)
    keep = [c for c in ("name", "highway", "lanes", "maxspeed", "oneway", "length", "geometry") if c in edges.columns]
    edges[keep].astype({c: str for c in keep if c != "geometry"}).to_file(out / "roads.geojson", driver="GeoJSON")
    ox.features_from_place(place, {"leisure": ["park", "garden"], "landuse": ["grass", "forest", "recreation_ground"]})[["geometry"]] \
        .to_file(out / "green.geojson", driver="GeoJSON")
    amen = ox.features_from_place(place, {"amenity": ["school", "hospital", "clinic", "kindergarten"]})
    amen[[c for c in ("name", "amenity", "geometry") if c in amen.columns]].to_file(out / "social.geojson", driver="GeoJSON")
    print(f"[osm] слои в {out}")


def download_osm_extra() -> None:
    """Дополнительные слои OSM для настоящей карты: реки и каналы, названные микрорайоны, стадионы, мосты."""
    try:
        import osmnx as ox
    except ImportError:
        raise SystemExit("pip install osmnx geopandas")
    place = "Bishkek, Kyrgyzstan"
    out = RAW / "osm"
    out.mkdir(parents=True, exist_ok=True)
    layers = [
        ("water", {"waterway": ["river", "canal", "stream"]}, ["name", "name:ru", "waterway"]),
        ("places", {"place": ["suburb", "neighbourhood", "quarter", "village"]}, ["name", "name:ru", "place"]),
        ("stadiums", {"leisure": ["stadium"]}, ["name", "name:ru"]),
        ("bridges", {"bridge": True}, ["name", "highway", "waterway", "bridge"]),
    ]
    for name, tags, cols in layers:
        try:
            gdf = ox.features_from_place(place, tags)
        except Exception as e:  # один слой не должен ронять остальные
            print(f"[osm_extra] {name}: пропущено ({str(e)[:100]})")
            continue
        keep = [c for c in cols if c in gdf.columns]
        g = gdf[keep + ["geometry"]].copy().reset_index(drop=True)
        for c in keep:  # всё в обычный текст, чтобы файл читался без сюрпризов
            g[c] = g[c].apply(lambda v: "" if v is None or (isinstance(v, float) and v != v) else str(v))
        g.to_file(out / f"{name}.geojson", driver="GeoJSON")
        print(f"[osm_extra] {name}: {len(g)} объектов")


def merge() -> Path:
    """Склеивает погоду + воздух (+ наземные датчики, если скачаны) в один почасовой датасет."""
    w = pd.read_csv(RAW / "weather_openmeteo.csv", index_col="time", parse_dates=True)
    a = pd.read_csv(RAW / "air_openmeteo_cams.csv", index_col="time", parse_dates=True).add_prefix("cams_")
    df = w.join(a, how="inner")
    gp = RAW / "openaq_pm25_hourly.csv"
    if gp.exists():
        g = pd.read_csv(gp, parse_dates=["time"])
        g["time"] = g["time"].dt.tz_localize(None).dt.floor("h")
        df = df.join(g.groupby("time")["pm25"].agg(pm25_ground="median", n_stations="nunique"), how="left")
    PROC.mkdir(parents=True, exist_ok=True)
    out = PROC / "hourly.csv"
    df.to_csv(out)
    print(f"[merge] {out}: {len(df)} строк, {df.index.min()} … {df.index.max()}")
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("what", choices=["weather", "air", "openaq", "osm", "osm_extra", "merge", "all"])
    ap.add_argument("--start", default="2023-01-01")
    ap.add_argument("--end", default=(dt.date.today() - dt.timedelta(days=2)).isoformat())
    a = ap.parse_args()
    if a.what in ("weather", "all"):
        download_weather(a.start, a.end)
    if a.what in ("air", "all"):
        download_air(a.start, a.end)
    if a.what == "openaq" or (a.what == "all" and os.environ.get("OPENAQ_API_KEY")):
        download_openaq(a.start, a.end)
    if a.what in ("osm", "all"):
        try:
            download_osm()
        except SystemExit as e:
            print("[osm] пропущено:", e)
    if a.what == "osm_extra":
        download_osm_extra()
    if a.what in ("merge", "all"):
        merge()


if __name__ == "__main__":
    main()
