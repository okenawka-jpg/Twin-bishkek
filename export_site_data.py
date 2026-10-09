#!/usr/bin/env python3
"""Делает site/js/data.js из src/twin_bishkek/city_real.json (тот же город, что и в Python-модели).

    python export_site_data.py
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
D = json.loads((ROOT / "src" / "twin_bishkek" / "city_real.json").read_text(encoding="utf-8"))
js = lambda x: json.dumps(x, ensure_ascii=False, separators=(",", ":"))  # noqa: E731

OBJECTS_AND_PRESETS = "  const OBJECT_TYPES = {\n    jk:   { name: 'ЖК',   long: 'Жилой комплекс', icon: 'i-jk',   residents: 4000, traffic: .08 },\n    tc:   { name: 'ТЦ',   long: 'Торговый центр', icon: 'i-tc',   residents: 0,    traffic: .12 },\n    park: { name: 'Парк', long: 'Парк / сквер',   icon: 'i-park', residents: 0,    traffic: 0, greenPerPerson: 1.5, pmLocal: .06 },\n  };\n\n  const PRESETS = [\n    { id: 'uc01', code: 'UC-01', name: 'Квота на ввоз ДВС', params: { fleet: 20, ev: 5 } },\n    { id: 'uc02', code: 'UC-02', name: 'Три ЖК в Джале', params: { objects: [{ d: 'jal', t: 'jk', n: 3 }] }, select: 'jal' },\n    { id: 'uc03', code: 'UC-03', name: 'Матч и ремонт моста', params: { events: { match: true, bridge: 'alaarcha' } } },\n    { id: 'uc04', code: 'UC-04', name: 'Сокращение зелени', params: { green: -15 }, select: 'asanbay' },\n    { id: 'uc05', code: 'UC-05', name: 'Худший зимний день', params: { season: 'winter', fleet: 20, ev: 5, green: -10, objects: [{ d: 'jal', t: 'jk', n: 2 }], events: { closure: 'chuy', match: true } } },\n  ];\n\n"
SCALE_AND_HELPERS = "  // Шкала AQI US EPA (редакция 2024) — непрерывная кусочно-линейная интерполяция\n  const PM_BREAKS = [0, 9.0, 35.4, 55.4, 125.4, 225.4, 325.4];\n  const AQI_BREAKS = [0, 50, 100, 150, 200, 300, 500];\n  const AQI_CATS = [\n    { name: 'Хорошо', short: 'хорошо', range: '0–50', pm: '0–9.0' },\n    { name: 'Умеренно', short: 'умеренно', range: '51–100', pm: '9.1–35.4' },\n    { name: 'Вредно для чувствительных групп', short: 'вредно для чувствит.', range: '101–150', pm: '35.5–55.4' },\n    { name: 'Вредно', short: 'вредно', range: '151–200', pm: '55.5–125.4' },\n    { name: 'Очень вредно', short: 'очень вредно', range: '201–300', pm: '125.5–225.4' },\n    { name: 'Опасно', short: 'опасно', range: '301+', pm: '225.5+' },\n  ];\n\n  function pointInPoly(x, y, poly) {\n    let inside = false;\n    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {\n      const [xi, yi] = poly[i], [xj, yj] = poly[j];\n      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;\n    }\n    return inside;\n  }\n\n  // Соседи в раскладке odd-r (нечётные ряды сдвинуты вправо), порядок рёбер: В, ЮВ, ЮЗ, З, СЗ, СВ\n  const NB_EVEN = [[1, 0], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1]];\n  const NB_ODD = [[1, 0], [1, 1], [0, 1], [-1, 0], [0, -1], [1, -1]];\n\n"

# новый тип объекта «Аттракционы» (парк развлечений): едут машины, часть территории зелёная
OBJECTS_AND_PRESETS = OBJECTS_AND_PRESETS.replace(
    "const OBJECT_TYPES = {\n",
    "const OBJECT_TYPES = {\n    fun:  { name: 'Аттракционы', long: 'Парк развлечений', icon: 'i-fun', residents: 0, traffic: .10, greenPerPerson: .5, pmLocal: .03 },\n", 1)

# новые пресеты: стройка и новая магистраль
_i = OBJECTS_AND_PRESETS.rindex("\n  ];")
OBJECTS_AND_PRESETS = OBJECTS_AND_PRESETS[:_i] + """
    { id: 'uc06', code: 'UC-06', name: 'Стройка трёх ЖК в Джале', params: { objects: [{ d: 'jal', t: 'jk', n: 3, ph: 'build' }] }, select: 'jal' },
    { id: 'uc07', code: 'UC-07', name: 'Новая магистраль вдоль Чуя', params: { events: { widen: 'chuy' } } },
    { id: 'uc08', code: 'UC-08', name: 'Вечерний час пик (18:00)', params: { hour: 18 } },
    { id: 'uc09', code: 'UC-09', name: 'Зимняя ночь (22:00)', params: { season: 'winter', hour: 22 } },""" + OBJECTS_AND_PRESETS[_i:]

HEAD = """/* Twin Bishkek · данные города. ФАЙЛ СОЗДАЁТ export_site_data.py из city_real.json (OpenStreetMap), руками не правьте.
   Координаты: «пиксели» схемы, 1 px = 25 м, север сверху. Районы, улицы, реки и мосты настоящие;
   население, загрузка школ и частный сектор у районов демонстрационные. */
(function () {
  const TB = (window.TB = window.TB || {});

  const W = %d, H = %d;
  const CENTER = %s;
  const OUTLINE = %s;
  const GRID = %s;
  const DISTRICTS = %s;
  const byId = Object.fromEntries(DISTRICTS.map((d) => [d.id, d]));
  const STREETS = %s;
  const STREET_LABELS = %s;
  const RIVERS = %s;
  const CANALS = %s;
  const STADIUM = %s;
  const BRIDGES = %s;
  const CLOSURES = %s;
  const VENUES = %s;
  const TIME = %s;
  const GEO = %s;  // перевод пикселей схемы в долготу/широту (нужен карте 2GIS)
  const STADIUMS = Object.fromEntries(VENUES.filter((v) => v.kind === 'stadium').map((v) => [v.id, v]));

"""

BUILD_GRID = """  function buildGrid() {
    const R = GRID.R, w = Math.sqrt(3) * R, rowH = 1.5 * R;
    const hexes = [], index = new Map();
    for (let row = 0; ; row++) {
      const y = GRID.y0 + row * rowH;
      if (y > GRID.ymax) break;
      for (let col = 0; ; col++) {
        const x = GRID.x0 + col * w + (row % 2 ? w / 2 : 0);
        if (x > GRID.xmax) break;
        if (!pointInPoly(x, y, OUTLINE)) continue;
        let best = null, bestD = Infinity;
        DISTRICTS.forEach((d, k) => {
          // Небольшой детерминированный шум делает границы районов «живыми», а не прямыми
          const noise = 14 * Math.sin(x * .041 + k * 1.7) * Math.cos(y * .037 + k * .9);
          const dist = Math.hypot(x - d.x, y - d.y) + noise;
          if (dist < bestD) { bestD = dist; best = d.id; }
        });
        const i = hexes.length;
        hexes.push({ i, col, row, x, y, d: best });
        index.set(col + ',' + row, i);
      }
    }
    const neighbours = (h) => (h.row % 2 ? NB_ODD : NB_EVEN).map(([dc, dr]) => {
      const j = index.get(h.col + dc + ',' + (h.row + dr));
      return j === undefined ? -1 : j;
    });
    hexes.forEach((h) => { h.nb = neighbours(h); });
    const corner = (h, k, r = R) => {
      const a = (Math.PI / 180) * (60 * k - 30);
      return [h.x + r * Math.cos(a), h.y + r * Math.sin(a)];
    };
    return { R, w, rowH, hexes, index, corner };
  }

  // пиксели схемы → [долгота, широта]; та же формула, что city.to_lonlat в Python
  function toLonLat(x, y) {
    const xk = (x + GEO.xmin - GEO.pad) * GEO.m_per_px / 1000, yk = (GEO.ymax + GEO.pad - y) * GEO.m_per_px / 1000;
    return [GEO.lon0 + xk / GEO.kx, GEO.lat0 + yk / GEO.ky];
  }

  TB.data = {
    W, H, CENTER, OUTLINE, GRID, DISTRICTS, byId, STREETS, STREET_LABELS, RIVERS, CANALS, STADIUM,
    BRIDGES, CLOSURES, VENUES, STADIUMS, TIME, GEO, toLonLat, OBJECT_TYPES, PRESETS, PM_BREAKS, AQI_BREAKS, AQI_CATS, buildGrid, pointInPoly,
  };
})();
"""

out = (HEAD % (D["W"], D["H"], js(D["CENTER"]), js(D["OUTLINE"]), js(D["GRID"]), js(D["DISTRICTS"]), js(D["STREETS"]),
                js(D["STREET_LABELS"]), js(D["RIVERS"]), js(D["CANALS"]), js(D["STADIUM"]), js(D["BRIDGES"]), js(D["CLOSURES"]), js(D["VENUES"]), js(D["TIME"]), js(D["GEO"]))
       + OBJECTS_AND_PRESETS + SCALE_AND_HELPERS + BUILD_GRID)
(ROOT / "site" / "js" / "data.js").write_text(out, encoding="utf-8")
print("site/js/data.js:", len(out) // 1024, "КБ; схема", D["W"], "x", D["H"])
