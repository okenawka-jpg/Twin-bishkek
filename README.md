# Twin Bishkek — «Горы видно?»

Цифровой двойник Бишкека. Показывает, что будет с пробками, воздухом (PM2.5, AQI) и районами,
если принять городское решение: изменить автопарк, долю электромобилей, зелень, построить ЖК или ТЦ,
перекрыть улицу или мост, провести матч. Цепочка модели: решение → трафик → PM2.5 → AQI → комфорт.

Город настоящий (OpenStreetMap), воздух подогнан под датчики, живые пробки берутся с карты 2GIS.
Все коэффициенты сценариев — допущения, см. [docs/ИСТОЧНИКИ_И_ОГРАНИЧЕНИЯ.md](docs/ИСТОЧНИКИ_И_ОГРАНИЧЕНИЯ.md).

## Ссылки

- Сайт (с картой 2GIS): [ссылка появится после деплоя на Render]
- Презентация: https://claude.ai/artifact/2KwKqiosoe73CHcUqBYnqK

## Деплой (Render, бесплатно)

`render.yaml` в корне: Render → New → Blueprint → этот репозиторий, вставить ключ `TWINGIS_MAPGL_KEY`.
В кабинете 2GIS разрешить ключу адрес сайта на onrender.com.

## Быстрый старт (Windows, PowerShell)

```powershell
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install -e ".[api,app,dev]"
pytest                                        # проверки модели и живых данных
uvicorn twin_bishkek.api:app --port 8000      # сайт: http://localhost:8000, Swagger: /docs
```

Карта 2GIS: перед запуском `$env:TWINGIS_MAPGL_KEY="ваш_ключ"`. Без интернета: `$env:TB_COLLECT="0"`.
Самопроверка модели в браузере: http://localhost:8000/?selftest

## Что где лежит

| Папка / файл | Что это |
|---|---|
| `src/twin_bishkek/` | ядро: `simulator.py` (модель), `city.py` + `city_real.json` (город), `api.py` (FastAPI), `live.py` (замеры 2GIS, воздух), `ml.py` (прогноз PM2.5), `data_download.py` |
| `site/` | сайт (HTML/JS): экраны, карта, план изменений, локальная JS-копия модели |
| `app/` | интерфейс на Streamlit (`streamlit run app/main.py`) |
| `tests/` | pytest: инварианты модели и живые данные |
| `build_city.py`, `export_site_data.py` | сборка города из OSM → `city_real.json` → `site/js/data.js` |
| `data/`, `models/`, `notebooks/` | данные, обученные модели, исследования |
| `docs/` | источники и ограничения, план защиты |

Подробно про бэкенд, данные, ML, 2GIS и план изменений: [README_BACKEND.md](README_BACKEND.md).
