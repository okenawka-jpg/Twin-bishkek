# Twin Bishkek — заметки для Claude

Цифровой двойник Бишкека: решение → трафик (BPR) → PM2.5 → AQI → комфорт района.
Автор пишет по-русски, работает в VS Code на Windows; объяснять просто, по шагам.

## Ссылки
- Сайт (Render, free, засыпает ~1 мин): https://twin-bishkek.onrender.com
- Для менторов: https://twin-bishkek.onrender.com/mentors.html
- Презентация: https://twin-bishkek.onrender.com/presentation.html и `.pdf`
- GitHub: https://github.com/okenawka-jpg/Twin-bishkek — push в `main` сам пересобирает Render

## Как устроено
- Модель дважды и одинаково: `src/twin_bishkek/simulator.py` (Python) и `site/js/model.js` (JS). Меняя одну — меняй другую; расхождение должно быть ~1e-13.
- API: `src/twin_bishkek/api.py` (FastAPI), отдаёт и сайт из `site/`.
- Живые замеры (2GIS, воздух): SQLite `data/live/twin_live.sqlite3`; архив для сервера — `data/seed/live_seed.json` (`python -m twin_bishkek.live seed`).
- Ключ 2GIS только в переменной `TWINGIS_MAPGL_KEY`, в код не класть.
- Подробно: `README_BACKEND.md`, допущения и источники: `docs/ИСТОЧНИКИ_И_ОГРАНИЧЕНИЯ.md`.

## Команды
- Тесты: `.\venv\Scripts\python.exe -m pytest -q`
- Локальный сервер: `.\venv\Scripts\uvicorn.exe twin_bishkek.api:app --port 8000`
- Самопроверка сайта: `http://localhost:8000/?selftest`

## Планы автора
Вести блог «строю продукт публично» (смог, пробки, получение данных у 2GIS и мэрии) и затем предложить продукт мэрии Бишкека или податься на гранты (ПРООН, Всемирный банк, АБР).
