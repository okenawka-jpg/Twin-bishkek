/* Twin Bishkek · мост к Python-бэкенду.
   Подменяет TB.model.simulate и TB.model.decompose запросами к API (/simulate, /decompose).
   Если сервер недоступен, молча остаётся родная JS-модель, сайт не ломается.
   Грузится ПОСЛЕ model.js и ДО screens.js. */
(function () {
  const TB = (window.TB = window.TB || {});
  const M = TB.model;
  const jsSimulate = M.simulate, jsDecompose = M.decompose;
  const BASE = location.protocol === 'file:' ? 'http://localhost:8000' : '';
  const cache = new Map();
  const state = { online: null, calls: 0 };

  // Синхронный запрос: модель в макете вызывается как обычная функция, поэтому ждём ответа на месте.
  // Бэкенд на этом же компьютере отвечает за единицы миллисекунд.
  function post(path, body) {
    const x = new XMLHttpRequest();
    x.open('POST', BASE + path, false);
    x.setRequestHeader('Content-Type', 'application/json');
    x.send(JSON.stringify(body));
    if (x.status !== 200) throw new Error(path + ' → ' + x.status);
    return JSON.parse(x.responseText);
  }

  const toScenario = (p) => {
    const n = M.normalize(p);
    const body = { season: n.season, hour: n.hour, fleet: n.fleet, ev: n.ev, green: n.green, objects: n.objects, roads: n.roads, trees: n.trees, events: n.events };
    if (TB.backend && TB.backend.learned) body.learned = true; // поправка по часам из замеров 2GIS (live.js включает флаг)
    return body;
  };

  function fromApi(js) {
    return {
      params: js.params,
      pm: Float64Array.from(js.hexes.pm), aqi: Float64Array.from(js.hexes.aqi), cat: Uint8Array.from(js.hexes.cat),
      seg: {
        vc: Float64Array.from(js.segments.vc), f: Float64Array.from(js.segments.f),
        closed: Uint8Array.from(js.segments.closed), V: Float64Array.from(js.segments.V),
      },
      city: js.city, districts: js.districts, vis: js.vis, ms: js.ms, roads: js.roads || [], trees: js.trees || { n: 0, canopy: 0, pm: 0, co2: 0, trips: 0, cool: 0, plantings: [], hexes: [] },
    };
  }

  function fail(e) {
    if (state.online !== false) console.warn('[Twin Bishkek] бэкенд недоступен, работает встроенная JS-модель:', e.message);
    state.online = false;
    document.documentElement.dataset.backend = 'js';
  }
  function ok() {
    if (state.online !== true) console.info('[Twin Bishkek] расчёты идут на Python-бэкенде');
    state.online = true;
    document.documentElement.dataset.backend = 'python';
  }

  M.simulate = function (raw) {
    const body = toScenario(raw), key = JSON.stringify(body);
    if (cache.has(key)) return cache.get(key);
    if (state.online === false) return jsSimulate(raw);
    try {
      const t0 = performance.now();
      const res = fromApi(post('/simulate?hexes=true&segments=true', body));
      res.ms = performance.now() - t0; // время вместе с запросом: то, что реально ждёт человек
      ok(); state.calls++;
      if (cache.size > 300) cache.clear();
      cache.set(key, res);
      return res;
    } catch (e) { fail(e); return jsSimulate(raw); }
  };

  M.decompose = function (raw) {
    if (state.online === false) return jsDecompose(raw);
    try { const out = post('/decompose', toScenario(raw)); ok(); return out; }
    catch (e) { fail(e); return jsDecompose(raw); }
  };

  TB.backend = { state, learned: false, label: () => (state.online ? 'Python-бэкенд' : 'demo-0.3 (JS)'), clearCache: () => cache.clear() };
})();
