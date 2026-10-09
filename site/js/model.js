/* Twin Bishkek · упрощённая модель каскада (демо-калибровка).
   simulate(params) — чистая функция: Решение → Трафик (BPR) → PM2.5 → AQI → Комфорт района.
   Логика написана так, чтобы её можно было перенести в Python (TwinBishkekSimulator) один к одному. */
(function () {
  const TB = (window.TB = window.TB || {});
  const D = TB.data;

  const P = {
    bprAlpha: 0.5, bprBeta: 4, fCap: 3.5, // BPR: t = t0·(1 + α·(V/C)^β); α поднят под заторы центра (демо)
    peakK: 0.3,            // сжатие часа пик: поток выше среднесуточного берём на 30% (подгонка к индексу 2GIS ≈4/10 в 18:00, демо)
    hourK: 1.27,           // общий множитель почасового профиля: среднее по 24 часам остаётся ≈8.4 мин, как у «Сегодня»
    vcScale: 1.052,        // общий множитель базовой загрузки улиц: подгонка средней задержки лета к 8.4 мин (демо-цель)
    build: { trafficK: 0.6, minTraffic: 0.05, capLoss: 0.2, dust: 0.05 }, // стройка (допущения): техника, сужение проезда, пыль
    widen: 0.5,            // «новая магистраль вдоль улицы»: +50% ёмкости на центральном участке
    refLanes: 4,           // полос у «эталонной» улицы: ёмкость отрезка = lanes / refLanes
    bridgeR: 16,           // px: радиус вокруг моста, внутри которого улица закрывается (оба направления)
    T0: 22,                // мин — средняя поездка без заторов
    V0: 40,                // км/ч — скорость свободного потока
    baseEv: 5,             // % EV в парке сегодня (демо)
    sigmaI: 55, cutI: 150, // радиус влияния улицы на соту
    tpSummerP95: 19.9,       // мкг/м³ транспортного PM2.5 у самых нагруженных сот летом
    bgSummer: [4, 4],      // фон = a + b × доля частного сектора
    bgWinter: [20, 100],   // зимой фон растёт за счёт угольного отопления
    winterTraffic: 2.27,   // зимняя инверсия удерживает выхлоп у земли
    greenK: 0.4,           // ±30% зелени → ∓12% PM2.5
    greenNorm: 16,         // условный норматив, м² зелени на жителя
    weights: { air: 0.35, road: 0.25, green: 0.2, social: 0.2 },
    // Новые дороги через город (ДОПУЩЕНИЯ, демонстрационные; одинаковые в simulator.py):
    //   cap — ёмкость полосы к обычной улице (нет светофоров → больше), time — время в пути к обычной улице,
    //   attract — какую долю потока параллельных улиц рядом забирает дорога, emit — выхлоп вдоль трассы
    //   (у тоннеля 0: выхлоп выходит у порталов, доля portal), cross — ёмкость пересекаемых улиц (новые светофоры).
    road: {
      max: 3, segLen: 70, reach: 50, cut: 150, baseUse: 0.25, induced: 0.1, fill: 0.9,
      kinds: {
        tunnel: { cap: 1.25, time: 0.8, attract: 0.45, emit: 0, portal: 0.6, cross: 1 },
        elevated: { cap: 1.25, time: 0.8, attract: 0.4, emit: 0.8, portal: 0, cross: 1 },
        surface: { cap: 1, time: 1, attract: 0.3, emit: 1, portal: 0, cross: 0.9 },
      },
      // стройка: сужение улиц вдоль трассы (у тоннеля почти только у порталов), грузовики, пыль
      build: {
        tunnel: { capLoss: 0.03, portalLoss: 0.3, trucks: 0.06, dust: 0.08 },
        elevated: { capLoss: 0.15, portalLoss: 0, trucks: 0.03, dust: 0.05 },
        surface: { capLoss: 0.2, portalLoss: 0, trucks: 0.03, dust: 0.05 },
      },
      months: { tunnel: 36, elevated: 24, surface: 12 }, // типичный срок стройки для плана (допущение)
    },
    // Посадка деревьев (одинаково в simulator.py: TREES). Источники чисел — в docs/ИСТОЧНИКИ_И_ОГРАНИЧЕНИЯ.md:
    //   pmRate — PM2.5, задержанный 1 м² кроны за год (Nowak 2013: 0,13–0,36 г), co2Rate — CO₂ на 1 м² кроны за год
    //   (Nowak 2013: 0,28 кг C ≈ 1,03 кг CO₂), coolPer — °C охлаждения воздуха на +1 п.п. площади крон района (WRI: ~0,3 °C на 10 п.п.).
    //   Кроны пород, скорость роста, pmLocal, полив и пробки от водовозов — ДОПУЩЕНИЯ.
    trees: {
      max: 6, crown0: 1.5, pmRate: 0.25, co2Rate: 1.03, coolPer: 0.03, pmLocal: 0.05, winterBare: 0.15, leafOn: 0.6,
      youngAge: 3, waterL: 100, truckL: 10000, waterLoss: 0.5, waterFrom: 6, waterTo: 10, matureWater: 0.2, near: 10,
      species: {
        platan: { name: 'Платан (чинара)', crown: 18, tau: 12, ever: false, pm: 1.0 },
        karagach: { name: 'Карагач (вяз)', crown: 10, tau: 6, ever: false, pm: 1.1 },
        lipa: { name: 'Липа', crown: 10, tau: 12, ever: false, pm: 1.0 },
        dub: { name: 'Дуб', crown: 16, tau: 18, ever: false, pm: 1.0 },
        topol: { name: 'Тополь (без пуха)', crown: 12, tau: 5, ever: false, pm: 0.9 },
        klen: { name: 'Клён', crown: 10, tau: 8, ever: false, pm: 0.9 },
        gledichia: { name: 'Гледичия', crown: 10, tau: 8, ever: false, pm: 0.7 },
        sosna: { name: 'Сосна', crown: 7, tau: 12, ever: true, pm: 1.3 },
        el: { name: 'Ель тянь-шаньская', crown: 5, tau: 15, ever: true, pm: 1.4 },
      },
    },
  };
  // Крона дерева через age лет после посадки: от саженца crown0 до взрослой crown, экспоненциальное приближение
  const crownAt = (sp, age) => { const T = P.trees, S = T.species[sp]; return T.crown0 + (S.crown - T.crown0) * (1 - Math.exp(-age / S.tau)); };
  // через сколько лет крона дойдёт до 80% взрослой («выросло»)
  const grownAge = (sp) => { const T = P.trees, S = T.species[sp]; return -S.tau * Math.log(1 - (0.8 * S.crown - T.crown0) / (S.crown - T.crown0)); };

  let G = null, SEG = [], HEX_W = [], HEX_DENSITY = [], DIST_W = {}, HEX_BY_D = {}, kT = 1;

  function distPointSeg(px, py, s) {
    const dx = s.bx - s.ax, dy = s.by - s.ay;
    const t = Math.max(0, Math.min(1, ((px - s.ax) * dx + (py - s.ay) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(px - (s.ax + t * dx), py - (s.ay + t * dy));
  }
  function nearestSeg(streetId, x, y) {
    let best = -1, bd = Infinity;
    for (const s of SEG) {
      if (s.street !== streetId) continue;
      const d = Math.hypot(s.mx - x, s.my - y);
      if (d < bd) { bd = d; best = s.i; }
    }
    return best;
  }
  // Все отрезки улицы в радиусе r от точки (оба направления моста); если таких нет, то ближайший
  function segsNear(streetId, x, y, r) {
    const out = [];
    for (const s of SEG) if (s.street === streetId && Math.hypot(s.mx - x, s.my - y) <= r) out.push(s.i);
    return out.length ? out : [nearestSeg(streetId, x, y)];
  }
  const peak = (g) => { g *= P.hourK; return g <= 1 ? g : 1 + P.peakK * (g - 1); }; // профиль часа: нормировка P.hourK, затем пик смягчён (P.peakK)
  const gauss = (d, sigma) => Math.exp(-(d * d) / (2 * sigma * sigma));

  function init() {
    if (G) return;
    G = D.buildGrid();
    SEG = [];
    D.STREETS.forEach((st) => {
      for (let i = 0; i < st.pts.length - 1; i++) {
        const [x1, y1] = st.pts[i], [x2, y2] = st.pts[i + 1];
        const len = Math.hypot(x2 - x1, y2 - y1), n = Math.max(1, Math.ceil(len / 70));
        for (let k = 0; k < n; k++) {
          const ax = x1 + ((x2 - x1) * k) / n, ay = y1 + ((y2 - y1) * k) / n;
          const bx = x1 + ((x2 - x1) * (k + 1)) / n, by = y1 + ((y2 - y1) * (k + 1)) / n;
          const mx = (ax + bx) / 2, my = (ay + by) / 2;
          const dc = Math.hypot(mx - D.CENTER.x, my - D.CENTER.y);
          const lanes = st.lanes || P.refLanes;
          SEG.push({ i: SEG.length, street: st.id, ax, ay, bx, by, mx, my, len: len / n, lanes, cap: lanes / P.refLanes, vc0: st.vc * (0.85 + 0.35 * gauss(dc, 200)) * P.vcScale });
        }
      }
    });
    HEX_W = G.hexes.map((h) => {
      const list = [];
      for (const s of SEG) {
        const d = distPointSeg(h.x, h.y, s);
        if (d < P.cutI) list.push([s.i, s.len * gauss(d, P.sigmaI)]);
      }
      return list;
    });
    HEX_DENSITY = G.hexes.map((h) => 0.55 + 0.9 * gauss(Math.hypot(h.x - D.CENTER.x, h.y - D.CENTER.y), 240));
    D.DISTRICTS.forEach((d) => {
      DIST_W[d.id] = SEG.map((s) => {
        const dd = Math.hypot(s.mx - d.x, s.my - d.y);
        return dd < 260 ? s.len * gauss(dd, 120) : 0;
      });
      HEX_BY_D[d.id] = [];
    });
    G.hexes.forEach((h) => HEX_BY_D[h.d].push(h.i));
    // Калибровка: летом у 5% самых нагруженных сот транспортный вклад ≈ tpSummerP95
    const base = traffic(defaults('summer'));
    const I = G.hexes.map((h, hi) => intensity(hi, base.V)).sort((a, b) => a - b);
    const p95 = I[Math.floor(I.length * 0.95)];
    kT = P.tpSummerP95 / (p95 * (1 - P.baseEv / 100));
  }

  function defaults(season) {
    return { season: season || 'summer', hour: null, fleet: 0, ev: P.baseEv, green: 0, objects: [], roads: [], trees: [], events: { closure: null, match: false, bridge: null, venue: 'omurzakov', widen: null } };
  }

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  // Новая дорога: тип, полосы, стадия и точки трассы (целые пиксели схемы, 1 px = 25 м). Мусор отбрасывается.
  function normRoad(r) {
    if (!r || !P.road.kinds[r.kind]) return null;
    const pts = [];
    (Array.isArray(r.pts) ? r.pts : []).forEach((q) => {
      if (!Array.isArray(q) || pts.length >= 40) return;
      const x0 = +q[0], y0 = +q[1];
      if (!Number.isFinite(x0) || !Number.isFinite(y0)) return;
      const x = Math.round(clamp(x0, 0, D.W)), y = Math.round(clamp(y0, 0, D.H)), last = pts[pts.length - 1];
      if (last && last[0] === x && last[1] === y) return;
      pts.push([x, y]);
    });
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (pts.length < 2 || len < 20) return null; // короче 500 м — не дорога
    const ln = Number.isFinite(+r.lanes) && r.lanes !== null && r.lanes !== '' ? +r.lanes : 4;
    return { kind: r.kind, lanes: clamp(Math.round(ln), 2, 8), ph: r.ph === 'build' ? 'build' : 'done', pts };
  }
  // Посадка деревьев: порода, количество, сколько лет прошло, и где: район (d), вдоль улицы (s) или по линии (pts)
  function normPts(raw, minLen) {
    const pts = [];
    (Array.isArray(raw) ? raw : []).forEach((q) => {
      if (!Array.isArray(q) || pts.length >= 40) return;
      const x0 = +q[0], y0 = +q[1];
      if (!Number.isFinite(x0) || !Number.isFinite(y0)) return;
      const x = Math.round(clamp(x0, 0, D.W)), y = Math.round(clamp(y0, 0, D.H)), last = pts[pts.length - 1];
      if (last && last[0] === x && last[1] === y) return;
      pts.push([x, y]);
    });
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    return pts.length >= 2 && len >= minLen ? pts : null;
  }
  const num = (v, d) => (v === null || v === undefined || v === '' || !Number.isFinite(+v) ? d : +v);
  function normTree(t) {
    if (!t || !P.trees.species[t.sp]) return null;
    const out = { sp: t.sp, n: clamp(Math.round(num(t.n, 100)), 1, 100000), age: clamp(Math.round(num(t.age, 0)), 0, 60) };
    if (D.byId[t.d]) out.d = t.d;
    else if (t.s && D.STREETS.some((s) => s.id === t.s)) out.s = t.s;
    else { const pts = normPts(t.pts, 4); if (!pts) return null; out.pts = pts; }
    return out;
  }

  // Где стоят деревья посадки: точки [x, y, доля], доли в сумме 1. Район — равномерно по его сотам;
  // улица — по её отрезкам пропорционально длине; линия — кусками по ~10 px (250 м)
  function treeSpots(t) {
    if (t.d) { const ids = HEX_BY_D[t.d]; return ids.map((i) => [G.hexes[i].x, G.hexes[i].y, 1 / ids.length]); }
    if (t.s) {
      const ss = SEG.filter((s) => s.street === t.s), L = ss.reduce((a, s) => a + s.len, 0);
      return ss.map((s) => [s.mx, s.my, s.len / L]);
    }
    const out = [];
    let L = 0;
    for (let i = 1; i < t.pts.length; i++) L += Math.hypot(t.pts[i][0] - t.pts[i - 1][0], t.pts[i][1] - t.pts[i - 1][1]);
    for (let i = 1; i < t.pts.length; i++) {
      const [x1, y1] = t.pts[i - 1], [x2, y2] = t.pts[i], len = Math.hypot(x2 - x1, y2 - y1), n = Math.max(1, Math.ceil(len / 10));
      for (let k = 0; k < n; k++) out.push([x1 + ((x2 - x1) * (k + 0.5)) / n, y1 + ((y2 - y1) * (k + 0.5)) / n, len / n / L]);
    }
    return out;
  }
  function nearestHex(x, y) {
    let best = 0, bd = Infinity;
    for (const h of G.hexes) { const d = Math.hypot(h.x - x, h.y - y); if (d < bd) { bd = d; best = h.i; } }
    return best;
  }
  // отрезки улиц, вдоль которых стоят деревья посадки (их поливают водовозы прямо с проезжей части)
  function treeStreetSegs(t) {
    if (t.d) return [];
    if (t.s) return SEG.filter((s) => s.street === t.s).map((s) => s.i);
    const segs = [];
    for (let i = 1; i < t.pts.length; i++) segs.push({ ax: t.pts[i - 1][0], ay: t.pts[i - 1][1], bx: t.pts[i][0], by: t.pts[i][1] });
    return SEG.filter((s) => distToSegs(s.mx, s.my, segs) < P.trees.near).map((s) => s.i);
  }
  // рейсов водовоза в неделю летом: молодые деревья (< youngAge лет) поливают с машины, взрослые — в основном арыки (matureWater)
  const waterTrips = (t) => (t.n * P.trees.waterL * (t.age < P.trees.youngAge ? 1 : P.trees.matureWater)) / P.trees.truckL;
  // Водовозы у деревьев вдоль улиц: только лето. Одновременно работает trucks машин (рейсы за день / часы полива, рейс ~1 час),
  // каждая занимает полосу на одном отрезке улицы (−waterLoss ёмкости); отрезки — равномерно по посадке. В выбранный час:
  // только с waterFrom до waterTo; в среднем за сутки — доля этих часов. Возвращает [индексы отрезков, потеря ёмкости].
  function waterBlock(t, season, hour) {
    const T = P.trees;
    if (season !== 'summer' || t.d) return null;
    const hours = T.waterTo - T.waterFrom + 1;
    const share = hour === null || hour === undefined ? hours / 24 : hour >= T.waterFrom && hour <= T.waterTo ? 1 : 0;
    const segs = treeStreetSegs(t);
    if (!share || !segs.length) return null;
    const trucks = Math.min(segs.length, Math.max(1, Math.ceil(waterTrips(t) / 7 / hours)));
    const at = [];
    for (let k = 0; k < trucks; k++) at.push(segs[Math.floor(((k + 0.5) * segs.length) / trucks)]);
    return [at, T.waterLoss * share];
  }

  // Отрезки трассы, как у улиц: куски не длиннее segLen
  function roadSegs(r) {
    const out = [];
    for (let i = 0; i < r.pts.length - 1; i++) {
      const [x1, y1] = r.pts[i], [x2, y2] = r.pts[i + 1];
      const len = Math.hypot(x2 - x1, y2 - y1), n = Math.max(1, Math.ceil(len / P.road.segLen));
      for (let k = 0; k < n; k++) {
        const ax = x1 + ((x2 - x1) * k) / n, ay = y1 + ((y2 - y1) * k) / n;
        const bx = x1 + ((x2 - x1) * (k + 1)) / n, by = y1 + ((y2 - y1) * (k + 1)) / n;
        out.push({ ax, ay, bx, by, mx: (ax + bx) / 2, my: (ay + by) / 2, len: len / n, ux: (x2 - x1) / len, uy: (y2 - y1) / len });
      }
    }
    return out;
  }
  const distToSegs = (x, y, segs) => { let d = Infinity; for (const s of segs) d = Math.min(d, distPointSeg(x, y, s)); return d; };
  const distToEnds = (x, y, r) => { const a = r.pts[0], b = r.pts[r.pts.length - 1]; return Math.min(Math.hypot(x - a[0], y - a[1]), Math.hypot(x - b[0], y - b[1])); };
  // пересекаются ли два отрезка (строго, без касания концами)
  function crosses(s, t) {
    const o = (ax, ay, bx, by, cx, cy) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const d1 = o(t.ax, t.ay, t.bx, t.by, s.ax, s.ay), d2 = o(t.ax, t.ay, t.bx, t.by, s.bx, s.by);
    const d3 = o(s.ax, s.ay, s.bx, s.by, t.ax, t.ay), d4 = o(s.ax, s.ay, s.bx, s.by, t.bx, t.by);
    return d1 * d2 < 0 && d3 * d4 < 0;
  }
  function normalize(p) {
    p = p || {};
    const d = defaults(p.season === 'winter' ? 'winter' : 'summer');
    const ev = p.events || {};
    const merged = new Map();
    (p.objects || []).forEach((o) => {
      if (!D.byId[o.d] || !D.OBJECT_TYPES[o.t]) return;
      const key = o.d + ':' + o.t + ':' + (o.ph === 'build' ? 'build' : 'done'); // стадия: строится / построен
      const n = clamp(Math.round((+o.n || 1) * 100) / 100, 0.05, 9); // масштаб: 1 = типовой ЖК/ТЦ/парк (дробный: «0,3 ЖК»)
      const tk = clamp(Number.isFinite(+o.tk) && o.tk !== null && o.tk !== '' && o.tk !== undefined ? +o.tk : 1, 0.2, 3); // поправка нагрузки на улицы (нехватка парковок)
      const cur = merged.get(key) || [0, 0];
      merged.set(key, [cur[0] + n, cur[1] + n * tk]);
    });
    const hh = p.hour === null || p.hour === undefined || p.hour === '' ? null : Math.round(+p.hour);
    return {
      season: d.season,
      hour: hh !== null && Number.isFinite(hh) ? clamp(hh, 0, 23) : null, // час суток 0…23 или null («в среднем за сутки»)
      fleet: clamp(Number.isFinite(+p.fleet) ? +p.fleet : 0, -30, 50),
      ev: clamp(Number.isFinite(+p.ev) ? +p.ev : P.baseEv, 0, 100),
      green: clamp(Number.isFinite(+p.green) ? +p.green : 0, -30, 30),
      objects: [...merged].map(([k, v]) => { const [dd, t, ph] = k.split(':'); return { d: dd, t, ph, n: clamp(Math.round(v[0] * 100) / 100, 0.05, 9), tk: Math.round((v[1] / v[0]) * 1000) / 1000 }; }),
      roads: (Array.isArray(p.roads) ? p.roads : []).map(normRoad).filter(Boolean).slice(0, P.road.max),
      trees: (Array.isArray(p.trees) ? p.trees : []).map(normTree).filter(Boolean).slice(0, P.trees.max),
      events: {
        closure: D.CLOSURES[ev.closure] ? ev.closure : null,
        match: !!ev.match,
        bridge: D.BRIDGES[ev.bridge] ? ev.bridge : null,
        venue: D.STADIUMS[ev.venue] ? ev.venue : 'omurzakov',
        widen: D.CLOSURES[ev.widen] ? ev.widen : null,
      },
    };
  }

  // Трафик по сегментам улиц: V — поток (в единицах эталонной ёмкости), C — ёмкость, closed: 1 частично, 2 закрыт
  function traffic(p, g = 1, hour = null) { // g: время суток (1 = среднесуточный день), hour — для полива деревьев
    const n = SEG.length;
    const V = new Float64Array(n), C = new Float64Array(n), closed = new Uint8Array(n);
    for (const s of SEG) { V[s.i] = s.vc0 * s.cap; C[s.i] = s.cap; } // базовый поток = загрузка × ёмкость
    for (const t of p.trees || []) { // водовозы поливают деревья вдоль улиц и занимают полосу
      const wb = waterBlock(t, p.season, hour);
      if (wb) for (const i of wb[0]) C[i] *= 1 - wb[1];
    }
    if (p.events.widen) { // новая магистраль вдоль улицы: больше ёмкость на центральном участке
      for (const s of SEG) {
        if (s.street === p.events.widen && Math.hypot(s.mx - D.CENTER.x, s.my - D.CENTER.y) <= 240) C[s.i] = s.cap * (1 + P.widen);
      }
    }
    for (const o of p.objects) {
      const t = D.OBJECT_TYPES[o.t], at = D.byId[o.d];
      if (o.ph === 'build') {
        // стройка: приезжает техника, проезд рядом сужается (жителей и обычного трафика объекта ещё нет)
        for (const s of SEG) {
          const d = Math.hypot(s.mx - at.x, s.my - at.y);
          V[s.i] += Math.max(t.traffic, P.build.minTraffic) * P.build.trafficK * o.n * gauss(d, 70);
          C[s.i] *= Math.max(0.5, 1 - P.build.capLoss * gauss(d, 14));
        }
      } else if (t.traffic) {
        for (const s of SEG) V[s.i] += t.traffic * o.n * (o.tk || 1) * gauss(Math.hypot(s.mx - at.x, s.my - at.y), 70);
      }
    }
    if (p.events.match) {
      const v = D.STADIUMS[p.events.venue]; // больше зрителей → больше машин: добавка пропорциональна вместимости
      for (const s of SEG) V[s.i] += (0.35 * v.capacity / 23000) * gauss(Math.hypot(s.mx - v.x, s.my - v.y), 90);
    }
    // Новые дороги. Строится: сужение улиц вдоль трассы (у тоннеля — у порталов) и грузовики, своей дороги ещё нет.
    // Построена: забирает часть потока у близких параллельных улиц (+induced: новая дорога притягивает новые поездки),
    // плюс базовое использование baseUse·ёмкость; обычная дорога добавляет светофоры на пересекаемых улицах.
    const roads = p.roads.map((r) => {
      const K = P.road.kinds[r.kind], segs = roadSegs(r), m = segs.length;
      const RV = new Float64Array(m), RC = new Float64Array(m).fill((r.lanes / P.refLanes) * K.cap);
      if (r.ph === 'build') {
        const B = P.road.build[r.kind];
        for (const s of SEG) {
          const d = distToSegs(s.mx, s.my, segs), de = distToEnds(s.mx, s.my, r);
          C[s.i] *= Math.max(0.5, 1 - B.capLoss * gauss(d, 15));
          if (B.portalLoss) C[s.i] *= Math.max(0.5, 1 - B.portalLoss * gauss(de, 20));
          V[s.i] += r.kind === 'tunnel' ? B.trucks * gauss(de, 50) : B.trucks * gauss(d, 40);
        }
      } else {
        const want = new Float64Array(n), gain = new Float64Array(n), to = new Int32Array(n), D2 = new Float64Array(m);
        for (const s of SEG) {
          let best = -1, bd = Infinity;
          for (let j = 0; j < m; j++) {
            const d = distPointSeg(s.mx, s.my, segs[j]);
            if (d < bd) { bd = d; best = j; }
            if (K.cross < 1 && crosses(s, segs[j])) C[s.i] *= K.cross;
          }
          to[s.i] = best;
          if (bd >= P.road.cut) continue;
          const t = segs[best], align = Math.abs(((s.bx - s.ax) * t.ux + (s.by - s.ay) * t.uy) / s.len);
          want[s.i] = K.attract * gauss(bd, P.road.reach) * align * V[s.i];
          // отрезки одной параллельной улицы идут друг за другом, по ним едут те же машины: поток переходит на отрезок
          // трассы пропорционально длине, которую улица проходит вдоль него (len·align / длина отрезка трассы)
          gain[s.i] = (want[s.i] * (1 + P.road.induced) * s.len * align) / t.len;
          D2[best] += gain[s.i];
        }
        // переходят, пока дорога не заполнится до fill: дальше ехать по ней уже не быстрее (упрощённое равновесие)
        const k = Float64Array.from(D2, (dv, j) => { const room = Math.max(0, (P.road.fill - P.road.baseUse) * RC[j]); return dv > room ? room / dv : 1; });
        for (let i = 0; i < n; i++) { if (!want[i]) continue; V[i] -= want[i] * k[to[i]]; RV[to[i]] += gain[i] * k[to[i]]; }
        for (let j = 0; j < m; j++) RV[j] += P.road.baseUse * RC[j];
      }
      return { r, K, segs, V: RV, C: RC, open: r.ph === 'done' };
    });

    const fleetK = (1 + p.fleet / 100) * g; // EV — тоже машины: прирост парка нагружает улицы при любой доле EV
    for (let i = 0; i < n; i++) V[i] *= fleetK;
    roads.forEach((x) => { for (let j = 0; j < x.V.length; j++) x.V[j] *= fleetK; });

    if (p.events.closure) {
      const cl = D.CLOSURES[p.events.closure];
      for (const s of SEG) {
        if (s.street !== p.events.closure || Math.hypot(s.mx - D.CENTER.x, s.my - D.CENTER.y) > 240) continue;
        C[s.i] = 0.5 * s.cap; closed[s.i] = 1;
        const moved = 0.3 * V[s.i];
        V[s.i] -= moved;
        cl.parallels.forEach((pid) => { V[nearestSeg(pid, s.mx, s.my)] += moved / cl.parallels.length; });
      }
    }
    if (p.events.bridge) {
      const b = D.BRIDGES[p.events.bridge];
      const idx = segsNear(b.street, b.x, b.y, P.bridgeR);
      let moved = 0;
      idx.forEach((i) => { moved += V[i]; V[i] = 0; closed[i] = 2; });
      b.alt.forEach(([sid, share]) => {
        const js = segsNear(sid, b.x, b.y, P.bridgeR);
        js.forEach((j) => { V[j] += (moved * share) / js.length; });
      });
    }
    const vc = new Float64Array(n), f = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      vc[i] = closed[i] === 2 ? 0 : V[i] / C[i];
      f[i] = closed[i] === 2 ? 1 : Math.min(P.fCap, 1 + P.bprAlpha * Math.pow(vc[i], P.bprBeta));
    }
    roads.forEach((x) => { // у новой дороги своё время в пути: без светофоров быстрее (K.time)
      x.vc = Float64Array.from(x.V, (v, j) => (x.open ? v / x.C[j] : 0));
      x.f = Float64Array.from(x.vc, (v) => (x.open ? x.K.time * Math.min(P.fCap, 1 + P.bprAlpha * Math.pow(v, P.bprBeta)) : 1));
    });
    return { V, C, vc, f, closed, roads };
  }

  // Интенсивность движения у соты: улицы рядом + плотная сеть мелких улиц в центре (множитель);
  // новые дороги: выхлоп вдоль трассы ×emit, у тоннеля доля portal выходит у двух порталов
  function intensity(hi, V, roads) {
    let I = 0;
    for (const [si, w] of HEX_W[hi]) I += V[si] * w;
    if (roads) {
      const h = G.hexes[hi];
      for (const x of roads) {
        if (!x.open) continue;
        let tot = 0;
        x.segs.forEach((s, j) => {
          tot += x.V[j] * s.len;
          if (!x.K.emit) return;
          const d = distPointSeg(h.x, h.y, s);
          if (d < P.cutI) I += x.V[j] * s.len * gauss(d, P.sigmaI) * x.K.emit;
        });
        if (x.K.portal) {
          [x.r.pts[0], x.r.pts[x.r.pts.length - 1]].forEach(([ex, ey]) => {
            const d = Math.hypot(h.x - ex, h.y - ey);
            if (d < P.cutI) I += ((tot * x.K.portal) / 2) * gauss(d, P.sigmaI);
          });
        }
      }
    }
    return I * HEX_DENSITY[hi];
  }

  function aqiFromPm(pm) {
    const B = D.PM_BREAKS, A = D.AQI_BREAKS;
    if (!(pm > 0)) return 0;
    for (let k = 1; k < B.length; k++) {
      if (pm <= B[k]) return A[k - 1] + ((A[k] - A[k - 1]) * (pm - B[k - 1])) / (B[k] - B[k - 1]);
    }
    return 500;
  }
  function catFromAqi(a) {
    return a <= 50 ? 0 : a <= 100 ? 1 : a <= 150 ? 2 : a <= 200 ? 3 : a <= 300 ? 4 : 5;
  }
  function visibility(aqi) {
    const value = clamp(1 - (aqi - 40) / 190, 0.03, 1);
    const key = value >= 0.75 ? 'clear' : value >= 0.35 ? 'haze' : 'none';
    const verdict = { clear: 'Горы видно', haze: 'В дымке', none: 'Гор не видно' }[key];
    return { value, key, verdict };
  }

  function comfortParts(aqi, delay, green, load, w) {
    w = w || P.weights;
    const sum = w.air + w.road + w.green + w.social || 1;
    const aqiN = Math.min(aqi / 300, 1), delN = Math.min(delay / 30, 1);
    const grN = Math.min(green / P.greenNorm, 1), soN = Math.min(Math.max(load - 1, 0), 1);
    const parts = {
      air: (100 * w.air * (1 - aqiN)) / sum,
      road: (100 * w.road * (1 - delN)) / sum,
      green: (100 * w.green * grN) / sum,
      social: (100 * w.social * (1 - soN)) / sum,
    };
    return { parts, total: parts.air + parts.road + parts.green + parts.social };
  }

  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  function simulate(raw) {
    init();
    const t0 = now();
    const p = normalize(raw);
    const winter = p.season === 'winter';
    const hour = p.hour;
    const trAir = traffic(p); // выбросы считаем по среднесуточному потоку: суточный ритм воздуха берём из датчиков (иначе учли бы дважды)
    const tr = hour === null ? trAir : traffic(p, peak(D.TIME.traffic[hour]), hour); // дорога: нагрузка выбранного часа
    const airK = hour === null ? 1 : D.TIME.air[p.season][hour]; // реальный суточный ритм PM2.5 по датчикам

    // Воздух по сотам
    const ice = 1 - p.ev / 100;
    const mg = 1 - (P.greenK * p.green) / 100;
    const nH = G.hexes.length;
    const pm = new Float64Array(nH), aqi = new Float64Array(nH), cat = new Uint8Array(nH);

    // Деревья: крона через age лет → площадь крон по сотам (canopy) и «работающая» на пыль площадь (зимой лиственные голые)
    const T = P.trees, hexArea = ((3 * Math.sqrt(3)) / 2) * G.R * G.R * 625; // м², 1 px = 25 м
    const canopy = new Float64Array(nH), canopyPM = new Float64Array(nH);
    const plantings = p.trees.map((t) => {
      const S = T.species[t.sp], crown = crownAt(t.sp, t.age), each = (Math.PI * crown * crown) / 4, total = each * t.n;
      const pmK = S.pm * (winter ? (S.ever ? 1 : T.winterBare) : 1);
      for (const [x, y, w] of treeSpots(t)) { const hi = nearestHex(x, y); canopy[hi] += total * w; canopyPM[hi] += total * w * pmK; }
      const yearPM = S.ever ? 1 : T.leafOn + (1 - T.leafOn) * T.winterBare; // лиственные задерживают пыль ~7 месяцев в году
      return {
        ...t, crown, each, total, grown: grownAge(t.sp),
        pmKg: (total * T.pmRate * S.pm * yearPM) / 1000, co2t: (total * T.co2Rate) / 1000,
        trips: waterTrips(t), // рейсов водовоза в неделю летом
        water: (waterBlock(t, 'summer', T.waterFrom) || [[]])[0], // где стоят водовозы в часы полива (отрезки улиц)
      };
    });
    for (let hi = 0; hi < nH; hi++) {
      const h = G.hexes[hi], dist = D.byId[h.d];
      const bg = winter ? P.bgWinter[0] + P.bgWinter[1] * dist.priv : P.bgSummer[0] + P.bgSummer[1] * dist.priv;
      // Выхлоп дают только ДВС: доля EV снижает PM, но не трафик
      const tp = kT * intensity(hi, trAir.V, trAir.roads) * ice * (winter ? P.winterTraffic : 1);
      let mp = 1;
      for (const x of trAir.roads) { // пыль стройки дороги: вдоль трассы, у тоннеля — у порталов
        if (x.open) continue;
        const B = P.road.build[x.r.kind];
        mp *= 1 + B.dust * (x.r.kind === 'tunnel' ? gauss(distToEnds(h.x, h.y, x.r), 50) : gauss(distToSegs(h.x, h.y, x.segs), 40));
      }
      for (const o of p.objects) {
        const at = D.byId[o.d];
        if (o.ph === 'build') { mp *= 1 + P.build.dust * o.n * gauss(Math.hypot(h.x - at.x, h.y - at.y), 60); continue; } // пыль стройки
        const pl = D.OBJECT_TYPES[o.t].pmLocal; // парки и аттракционы чуть чистят воздух рядом
        if (!pl) continue;
        mp *= 1 - pl * o.n * gauss(Math.hypot(h.x - at.x, h.y - at.y), 80);
      }
      if (canopyPM[hi]) mp *= 1 - T.pmLocal * Math.min(1, canopyPM[hi] / hexArea); // кроны рядом задерживают часть пыли
      pm[hi] = (bg + tp) * mg * Math.max(0.5, mp) * airK;
      aqi[hi] = aqiFromPm(pm[hi]);
      cat[hi] = catFromAqi(aqi[hi]);
    }

    // Средневзвешенная загрузка: по пробегу (город) и по близости (район)
    let num = 0, den = 0;
    for (const s of SEG) {
      if (tr.closed[s.i] === 2) continue;
      const w = s.len * tr.V[s.i];
      num += w * tr.f[s.i]; den += w;
    }
    for (const x of tr.roads) {
      if (!x.open) continue;
      x.segs.forEach((s, j) => { const w = s.len * x.V[j]; num += w * x.f[j]; den += w; });
    }
    const Fcity = den ? num / den : 1;

    const districts = {};
    let popSum = 0, pmSum = 0;
    D.DISTRICTS.forEach((d) => {
      const residents = p.objects.filter((o) => o.d === d.id && o.ph === 'done').reduce((acc, o) => acc + D.OBJECT_TYPES[o.t].residents * o.n, 0);
      const pop = d.pop + residents / 1000;
      const ids = HEX_BY_D[d.id];
      let s = 0;
      for (const hi of ids) s += pm[hi];
      const dpm = ids.length ? s / ids.length : 0;
      let wn = 0, wd = 0;
      DIST_W[d.id].forEach((w, si) => { if (w && tr.closed[si] !== 2) { wn += w * tr.f[si]; wd += w; } });
      for (const x of tr.roads) {
        if (!x.open) continue;
        x.segs.forEach((s, j) => {
          const dd = Math.hypot(s.mx - d.x, s.my - d.y);
          if (dd < 260) { const w = s.len * gauss(dd, 120); wn += w * x.f[j]; wd += w; }
        });
      }
      const F = wd ? wn / wd : 1;
      let canopyD = 0;
      for (const hi of ids) canopyD += canopy[hi];
      const areaD = ids.length * hexArea;
      const extraGreen = p.objects.filter((o) => o.d === d.id && o.ph === 'done').reduce((acc, o) => acc + o.n * (D.OBJECT_TYPES[o.t].greenPerPerson || 0), 0)
        + canopyD / (pop * 1000); // кроны новых деревьев: м² зелени на жителя
      const cool = winter || !areaD ? 0 : T.coolPer * 100 * Math.min(1, canopyD / areaD); // °C прохладнее летом в среднем по району
      const green = (d.green * (1 + p.green / 100) * d.pop) / pop + extraGreen;
      const school = d.school * (pop / d.pop), clinic = d.clinic * (pop / d.pop);
      const daqi = aqiFromPm(dpm), delay = P.T0 * (F - 1);
      const c = comfortParts(daqi, delay, green, Math.max(school, clinic));
      districts[d.id] = {
        id: d.id, name: d.name, pop, pm: dpm, aqi: daqi, cat: catFromAqi(daqi), delay, speed: P.V0 / F,
        green, school, clinic, comfort: c.total, parts: c.parts, canopy: canopyD, cool,
      };
      popSum += pop; pmSum += pop * dpm;
    });

    const cityPm = pmSum / popSum, cityAqi = aqiFromPm(cityPm);
    const parts = { air: 0, road: 0, green: 0, social: 0 };
    let comfort = 0;
    Object.values(districts).forEach((r) => {
      const w = r.pop / popSum;
      comfort += w * r.comfort;
      Object.keys(parts).forEach((k) => { parts[k] += w * r.parts[k]; });
    });

    return {
      params: p,
      pm, aqi, cat,
      seg: { vc: tr.vc, f: tr.f, closed: tr.closed, V: tr.V },
      roads: tr.roads.map((x) => ({ ...x.r, segs: x.segs.map((s) => [s.ax, s.ay, s.bx, s.by]), vc: Array.from(x.vc), f: Array.from(x.f), V: Array.from(x.V) })),
      trees: {
        n: plantings.reduce((a, t) => a + t.n, 0), canopy: plantings.reduce((a, t) => a + t.total, 0),
        pm: plantings.reduce((a, t) => a + t.pmKg, 0), co2: plantings.reduce((a, t) => a + t.co2t, 0), trips: plantings.reduce((a, t) => a + t.trips, 0),
        cool: Object.values(districts).reduce((a, r) => Math.max(a, r.cool), 0),
        plantings, hexes: Array.from(canopy, (c, i) => [i, c]).filter((x) => x[1] > 0),
      },
      city: { pm: cityPm, aqi: cityAqi, cat: catFromAqi(cityAqi), delay: P.T0 * (Fcity - 1), speed: P.V0 / Fcity, comfort, parts },
      districts,
      vis: visibility(cityAqi),
      ms: now() - t0,
    };
  }

  // Пересчёт комфорта с другими весами без новой симуляции (Методология)
  function comfortWith(res, weights) {
    let popSum = 0, total = 0;
    const per = {};
    Object.values(res.districts).forEach((r) => {
      const c = comfortParts(r.aqi, r.delay, r.green, Math.max(r.school, r.clinic), weights);
      per[r.id] = c.total; total += r.pop * c.total; popSum += r.pop;
    });
    return { city: total / popSum, districts: per };
  }

  // Последовательное разложение эффекта: какой шаг сколько добавил (водопад)
  const STEPS = [
    { key: 'fleet', label: 'Автопарк' },
    { key: 'ev', label: 'Доля EV' },
    { key: 'green', label: 'Зелень' },
    { key: 'objects', label: 'Застройка' },
    { key: 'roads', label: 'Новые дороги' },
    { key: 'trees', label: 'Деревья' },
    { key: 'events', label: 'События' },
    { key: 'hour', label: 'Время суток' },
  ];
  function decompose(raw) {
    const p = normalize(raw);
    let cur = defaults(p.season);
    const pick = (r) => ({ aqi: r.city.aqi, delay: r.city.delay, comfort: r.city.comfort, pm: r.city.pm, speed: r.city.speed });
    let prev = pick(simulate(cur));
    const out = [{ key: 'base', label: 'Сегодня', value: prev }];
    STEPS.forEach((st) => {
      cur = { ...cur, [st.key]: p[st.key] };
      const v = pick(simulate(cur));
      out.push({ key: st.key, label: st.label, value: v, delta: { aqi: v.aqi - prev.aqi, delay: v.delay - prev.delay, comfort: v.comfort - prev.comfort } });
      prev = v;
    });
    return out;
  }

  function sameParams(a, b) {
    return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
  }
  function presetParams(id) {
    const pr = D.PRESETS.find((x) => x.id === id);
    if (!pr) return defaults('summer');
    const base = defaults(pr.params.season || 'summer');
    return normalize({ ...base, ...pr.params, events: { ...base.events, ...(pr.params.events || {}) } });
  }

  TB.model = {
    P, init, defaults, normalize, simulate, simulateLocal: simulate, decompose, comfortWith, sameParams, presetParams, roadSegs, crownAt, grownAge,
    treeSpots: (t) => (init(), treeSpots(t)),
    aqiFromPm, catFromAqi, visibility,
    grid: () => (init(), G),
    segments: () => (init(), SEG),
    hexesOf: (id) => (init(), HEX_BY_D[id] || []),
  };
})();
