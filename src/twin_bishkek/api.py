"""REST API поверх симулятора.

Запуск:  uvicorn twin_bishkek.api:app --reload --port 8000
Документация (Swagger): http://localhost:8000/docs
"""
from __future__ import annotations

import json
import os
import threading
import time
from contextlib import asynccontextmanager
from functools import lru_cache
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import __version__
from . import city as C
from . import live
from .simulator import get_simulator, preset_params



class CityObject(BaseModel):
    d: str = Field(description="id района, см. /meta")
    t: Literal["jk", "tc", "park", "fun"]
    n: float = Field(1, ge=0.05, le=9, description="масштаб: 1 = типовой объект (ЖК на ~4000 жителей), можно дробный")
    tk: float = Field(1, ge=0.2, le=3, description="поправка нагрузки на улицы (например, нехватка парковок)")
    ph: Literal["done", "build"] = "done"  # стадия: построен / строится


class Road(BaseModel):
    kind: Literal["tunnel", "elevated", "surface"] = Field(description="тоннель / эстакада / обычная дорога")
    lanes: int = Field(4, ge=2, le=8, description="полос в обе стороны")
    ph: Literal["done", "build"] = "done"
    pts: list[list[float]] = Field(min_length=2, max_length=40, description="точки трассы в пикселях схемы (1 px = 25 м), [[x, y], ...]")


class Trees(BaseModel):
    sp: Literal["platan", "karagach", "lipa", "dub", "topol", "klen", "gledichia", "sosna", "el"] = Field(description="порода")
    n: int = Field(100, ge=1, le=100000, description="сколько деревьев")
    age: int = Field(0, ge=0, le=60, description="сколько лет прошло после посадки")
    d: str | None = Field(None, description="район (id из /meta) — сажаем по всему району")
    s: str | None = Field(None, description="id улицы — аллея вдоль улицы")
    pts: list[list[float]] | None = Field(None, max_length=40, description="или линия посадки в пикселях схемы")


class Events(BaseModel):
    closure: str | None = None
    match: bool = False
    bridge: str | None = None
    venue: Literal["omurzakov", "arena"] = "omurzakov"  # где проходит матч
    widen: str | None = None  # новая магистраль вдоль улицы (id из /meta → closures)


class Scenario(BaseModel):
    season: Literal["summer", "winter"] = "summer"
    hour: int | None = Field(None, ge=0, le=23, description="час суток; пусто = в среднем за сутки")
    fleet: float = Field(0, ge=-30, le=50, description="изменение автопарка, %")
    ev: float = Field(5, ge=0, le=100, description="доля электромобилей, %")
    green: float = Field(0, ge=-30, le=30, description="изменение зелени, %")
    objects: list[CityObject] = []
    roads: list[Road] = Field([], max_length=3, description="новые дороги через город")
    trees: list[Trees] = Field([], max_length=6, description="посадки деревьев")
    events: Events = Events()
    learned: bool = Field(False, description="учесть поправку по часам, выученную на замерах 2GIS (если данных достаточно)")


_COLLECTOR: live.Collector | None = None
_LEARN_CACHE: tuple[float, dict] | None = None


def _learned() -> dict:
    """Результат live.learn по накопленным замерам; пересчитывается не чаще раза в минуту."""
    global _LEARN_CACHE
    if _LEARN_CACHE and time.monotonic() - _LEARN_CACHE[0] < 60:
        return _LEARN_CACHE[1]
    res = live.learn(live.get_store().hourly("weekday"), C.TIME["traffic"])
    _LEARN_CACHE = (time.monotonic(), res)
    return res


def _scn(s: Scenario) -> dict:
    d = s.model_dump()
    learned = d.pop("learned", False)
    if learned:
        L = _learned()
        if L["usable"]:
            d["tmul"] = L["mult"]
    return d


@asynccontextmanager
async def _lifespan(_: FastAPI):
    """Запуск: строим сетку, калибруем, включаем фоновый сбор. Остановка: выключаем сбор."""
    global _COLLECTOR
    get_simulator()  # строим сетку и калибруем один раз
    seed = live.seed_path()
    if seed.exists():  # архив замеров из репозитория: на Render диск чистый после каждого перезапуска
        try:
            live.get_store().import_seed(seed)
        except Exception as e:  # noqa: BLE001 — битый архив не должен ронять сервер
            live.LOG.warning("архив замеров не подмешан: %s", e)
    if os.environ.get("TB_COLLECT", "1") != "0":  # TB_COLLECT=0 выключает фоновый сбор (тесты, офлайн)
        _COLLECTOR = live.Collector(live.get_store())
        _COLLECTOR.start()
    try:
        yield
    finally:
        if _COLLECTOR:
            _COLLECTOR.stop()


app = FastAPI(title="Twin Bishkek API", version=__version__, lifespan=_lifespan,
              description="Цифровой двойник Бишкека: решение → трафик → PM2.5 → AQI → комфорт")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.get("/health")
def health() -> dict:
    sim = get_simulator()
    return {"status": "ok", "version": __version__, "hexes": len(sim.hexes), "segments": sim.n_seg}


@app.get("/meta")
def meta() -> dict:
    """Справочники для интерфейса: районы, объекты, события, пресеты."""
    return dict(
        districts=[{k: d[k] for k in ("id", "name", "pop")} | dict(lonlat=C.to_lonlat(d["x"], d["y"])) for d in C.DISTRICTS],
        object_types={k: v["name"] for k, v in C.OBJECT_TYPES.items()},
        closures={k: v["name"] for k, v in C.CLOSURES.items()},
        bridges={k: v["name"] for k, v in C.BRIDGES.items()},
        presets=C.PRESETS,
        venues=[{k: v[k] for k in v if k not in ("x", "y")} | dict(lonlat=C.to_lonlat(v["x"], v["y"])) for v in C.VENUES],
        aqi_categories=C.AQI_CATS,
    )


@lru_cache(maxsize=1)
def _grid_json() -> dict:
    return get_simulator().hex_geojson()


@app.get("/geo/hexes")
def hexes_geojson() -> dict:
    """Соты как GeoJSON (lon/lat). Порядок = индексы в ответе /simulate?hexes=true."""
    return _grid_json()


@app.get("/geo/streets")
def streets_geojson() -> dict:
    return get_simulator().streets_geojson()


@app.post("/simulate")
def simulate(s: Scenario, hexes: bool = False, segments: bool = False) -> dict:
    return get_simulator().simulate(_scn(s)).to_dict(hexes=hexes, segments=segments)


@app.get("/presets/{preset_id}")
def run_preset(preset_id: str, hexes: bool = False) -> dict:
    if preset_id not in {p["id"] for p in C.PRESETS}:
        raise HTTPException(404, f"нет пресета {preset_id}")
    return get_simulator().simulate(preset_params(preset_id)).to_dict(hexes=hexes)


@app.post("/decompose")
def decompose(s: Scenario) -> list[dict]:
    """Вклад каждого шага (автопарк, EV, зелень, застройка, события) в итог — для водопада."""
    return get_simulator().decompose(_scn(s))


@app.post("/compare")
def compare(scenarios: list[Scenario]) -> list[dict]:
    if not 1 <= len(scenarios) <= 4:
        raise HTTPException(422, "ожидается от 1 до 4 сценариев")
    sim = get_simulator()
    return [sim.simulate(_scn(s)).to_dict() for s in scenarios]


# ---------------- живые данные: карта 2GIS, снимки каждые 15 минут, «обучение» ----------------
class TrafficObs(BaseModel):
    score: float = Field(ge=0, le=10, description="индекс пробок 2GIS видимой области, 0–10")
    lon: float
    lat: float
    zoom: float


@app.get("/live/config")
def live_config() -> dict:
    """Ключ MapGL берём из переменной окружения TWINGIS_MAPGL_KEY: в код и в репозиторий его не кладём."""
    return {"mapgl_key": os.environ.get("TWINGIS_MAPGL_KEY", "").strip(), "collector": bool(_COLLECTOR)}


@app.get("/live/environment")
def live_environment(refresh: bool = False) -> dict:
    st = live.get_store()
    env = st.latest_environment()
    if env is None or refresh:
        try:
            fresh = live.fetch_environment()
            st.save_environment(fresh)
            env = st.latest_environment()
        except Exception as e:  # noqa: BLE001
            if env is None:
                return {"available": False, "reason": "Не удалось получить воздух и погоду (нет сети?)", "error": str(e)[:150]}
    env["available"] = True
    return env


@app.post("/live/traffic")
def live_traffic(o: TrafficObs) -> dict:
    now = live.now_bishkek()
    base = get_simulator().simulate({"season": live.season_of(now), "hour": now.hour}).city  # что модель ждала в этот час
    try:
        out = live.get_store().add_traffic(o.score, o.lon, o.lat, o.zoom, base["delay"], base["speed"], now)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
    global _LEARN_CACHE
    _LEARN_CACHE = None
    return {**out, "status": live.get_store().status()}


@app.get("/live/status")
def live_status() -> dict:
    st = live.get_store().status()
    st["collector_error"] = _COLLECTOR.last_error if _COLLECTOR else None
    st["collector_runs"] = _COLLECTOR.runs if _COLLECTOR else 0
    return st


@app.get("/live/learned")
def live_learned() -> dict:
    """Насколько суточный ритм модели совпадает с 2GIS и какая поправка по часам из этого вытекает."""
    L = dict(_learned())
    L["hourly"] = live.get_store().hourly("weekday")
    L["model_profile"] = C.TIME["traffic"]
    return L


# ---------------- план изменений во времени: общий для всех, кто открыл сайт с этого сервера ----------------
class PlanItem(BaseModel):
    id: str = Field(max_length=40)
    kind: Literal["build", "closure", "bridge", "widen", "road", "trees"]
    where: str = Field(max_length=40)
    start: str = Field(pattern=r"^\d{4}-\d{2}$")
    end: str = Field(pattern=r"^\d{4}-\d{2}$")
    type: Literal["jk", "tc", "park", "fun"] | None = None
    cap: float | None = Field(None, gt=0)
    spots: float | None = Field(None, ge=0)
    floors: float | None = Field(None, ge=0)
    title: str = Field("", max_length=120)
    note: str = Field("", max_length=300)
    # новая дорога (kind="road")
    rkind: Literal["tunnel", "elevated", "surface"] | None = None
    lanes: int | None = Field(None, ge=2, le=8)
    pts: list[list[float]] | None = Field(None, max_length=40)
    route: str = Field("", max_length=200)
    # посадка деревьев (kind="trees"): порода, сколько, где (район в where, улица в street или линия в pts)
    sp: str | None = Field(None, max_length=20)
    n: int | None = Field(None, ge=1, le=100000)
    street: str | None = Field(None, max_length=60)


class Plan(BaseModel):
    items: list[PlanItem] = Field([], max_length=200)


_PLAN_LOCK = threading.Lock()


def _plan_path() -> Path:
    return Path(os.environ.get("TB_PLAN_FILE", live.ROOT / "data" / "live" / "plan.json"))


@app.get("/plan")
def get_plan() -> dict:
    """План, сохранённый на сервере (тот же на любом компьютере). Пустой, если ещё не сохраняли."""
    p = _plan_path()
    with _PLAN_LOCK:
        if not p.exists():
            return {"items": [], "updated": None}
        return json.loads(p.read_text(encoding="utf-8"))


@app.put("/plan")
def put_plan(plan: Plan) -> dict:
    p = _plan_path()
    data = {"items": [i.model_dump() for i in plan.items], "updated": live.now_bishkek().isoformat(timespec="seconds")}
    with _PLAN_LOCK:
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
        tmp.replace(p)  # запись целиком или никак: файл не останется полузаписанным
    return {"saved": len(plan.items), "updated": data["updated"]}


# Сайт «Горы видно?» (папка site/ в корне проекта) открывается на http://localhost:8000
# Подключается ПОСЛЕДНИМ, чтобы не перекрывать /docs и остальные адреса API.
_SITE = Path(__file__).resolve().parents[2] / "site"
if _SITE.is_dir():
    app.mount("/", StaticFiles(directory=_SITE, html=True), name="site")
