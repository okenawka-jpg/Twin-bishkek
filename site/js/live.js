/* Twin Bishkek · живая карта 2GIS и «обучение» на её замерах.
   Слева: пробки 2GIS прямо сейчас (официальный MapGL). Справа: тот же вид, поверх которого рисуется НАША модель
   (цвета улиц по V/C из BPR, соты AQI, объекты и события). Пока вкладка открыта, индекс пробок видимой области,
   который карта сама отдаёт странице (событие trafficscore), уходит на сервер: не чаще раза в 15 минут на один вид.
   Если ключа нет или сервер не запущен, всё остаётся как раньше: схема OSM на SVG. Подход к карте и замерам перенят
   у проекта напарника (Twin_Bishkek_project), но считает и хранит всё наш бэкенд. */
(function () {
  const TB = (window.TB = window.TB || {});
  const D = TB.data, M = TB.model;
  const $ = (s, r) => (r || document).querySelector(s);
  const BASE = location.protocol === 'file:' ? 'http://localhost:8000' : '';
  const safe = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* приватный режим */ } },
    sget(k) { try { return sessionStorage.getItem(k) || ''; } catch (e) { return ''; } },
    sset(k, v) { try { sessionStorage.setItem(k, v); } catch (e) { /* приватный режим */ } },
  };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const COL = { free: '#30b45a', dense: '#f3d117', jam: '#ff453a', severe: '#8c1c2c', closed: '#8a8f98' };

  const S = {
    mode: 'schema', key: '', serverUp: null, maps: null, ready: false,
    last: null, objs: [], timer: null, sig: '', obsBusy: false, learned: safe.get('tb-learned', false),
  };
  TB.backend && (TB.backend.learned = !!S.learned);

  // ---------- сервер ----------
  async function api(path, opts) {
    const r = await fetch(BASE + path, opts);
    if (!r.ok) throw new Error(path + ' → ' + r.status);
    return r.json();
  }
  const setStatus = (t) => { const e = $('#gis-status'); if (e) e.textContent = t; };

  // ---------- библиотека MapGL ----------
  let libPromise = null;
  function ensureLib() {
    if (window.mapgl && window.mapgl.Map) return Promise.resolve();
    if (libPromise) return libPromise;
    libPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://mapgl.2gis.com/api/js/v1';
      s.async = true;
      s.onload = () => (window.mapgl && window.mapgl.Map ? resolve() : (libPromise = null, reject(new Error('MapGL недоступен'))));
      s.onerror = () => { libPromise = null; reject(new Error('MapGL не загрузился (нет интернета?)')); };
      document.head.appendChild(s);
    });
    return libPromise;
  }

  // ---------- режим карты ----------
  function setMode(m) {
    S.mode = m;
    safe.set('tb-basemap', m);
    document.querySelectorAll('#ctl-basemap button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === m)));
    $('#maps-gis').hidden = m !== 'gis' || !S.ready;
    $('#maps-schema').hidden = m === 'gis' && S.ready;
    $('#gis-key').hidden = !(m === 'gis' && !S.key && S.serverUp);
    if (m === 'gis') {
      if (!S.serverUp) { setStatus('Сервер не запущен: карта 2GIS недоступна, показана схема'); fallback(); return; }
      if (!S.key) { setStatus('Нужен ключ 2GIS, вставьте его ниже'); $('#maps-schema').hidden = false; return; }
      if (!S.maps) start(S.key); else { setStatus('Пробки 2GIS и наш сценарий подключены'); setTimeout(() => { ['live', 'sim'].forEach((k) => { try { if (S.maps[k].invalidateSize) S.maps[k].invalidateSize(); } catch (e) { /* не критично */ } }); S.sig = ''; schedule(60); }, 80); }
    } else setStatus(S.ready ? 'Показана схема OSM (2GIS подключена, переключитесь обратно)' : 'Показана схема OSM');
  }
  function fallback() {
    S.mode = 'schema';
    document.querySelectorAll('#ctl-basemap button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === 'schema')));
    $('#maps-gis').hidden = true; $('#maps-schema').hidden = false;
  }

  // ---------- запуск двух карт ----------
  function start(key) {
    setStatus('Подключаем 2GIS…');
    ensureLib().then(() => {
      try {
        // блок должен быть виден ДО создания карт: иначе у контейнера нулевой размер и плитки не рисуются
        $('#maps-gis').hidden = false; $('#maps-schema').hidden = true; S.ready = true;
        const center = D.toLonLat(D.CENTER.x, D.CENTER.y);
        const live = new window.mapgl.Map('gis-live', { key, center, zoom: 11, trafficOn: true, trafficControl: 'topRight' });
        const sim = new window.mapgl.Map('gis-sim', { key, center, zoom: 11, trafficOn: false });
        S.maps = { live, sim, objs: [], ready: { live: false, sim: false }, syncing: false };
        const fail = () => { setStatus('2GIS не принял ключ или не загрузил плитки'); S.key = ''; S.ready = false; S.maps = null; try { live.destroy(); sim.destroy(); } catch (e) { /* уже уничтожены */ } fallback(); $('#gis-key').hidden = false; };
        [live, sim].forEach((m) => { m.on('error', fail); m.on('styleloaderror', fail); });
        sim.on('zoomend', () => schedule(90));
        const bind = (from, to) => from.on('moveend', () => {
          if (S.maps.syncing) return;
          const c = from.getCenter(), z = from.getZoom(), c2 = to.getCenter(), z2 = to.getZoom();
          if (Math.abs(c[0] - c2[0]) < 8e-5 && Math.abs(c[1] - c2[1]) < 8e-5 && Math.abs(z - z2) < 0.04) return;
          S.maps.syncing = true;
          to.setCenter(c, { duration: 380, easing: 'easeOutCubic' }); to.setZoom(z, { duration: 380, easing: 'easeOutCubic' });
          setTimeout(() => { S.maps.syncing = false; }, 650);
        });
        bind(live, sim); bind(sim, live);
        live.on('trafficscore', onScore);
        const ready = (k) => () => { S.maps.ready[k] = true; if (S.maps.ready.live && S.maps.ready.sim) { setStatus('Пробки 2GIS и наш сценарий подключены'); draw(); } };
        live.once('idle', ready('live')); sim.once('idle', ready('sim'));
      } catch (e) { setStatus('MapGL не принял настройки: ' + e.message); fallback(); }
    }).catch((e) => { setStatus(e.message + ': показана схема'); fallback(); });
  }

  // ---------- замеры 2GIS → сервер ----------
  async function onScore(ev) {
    const score = Number(ev && ev.score);
    if (!Number.isFinite(score)) return;
    const now = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Bishkek', hour: '2-digit', minute: '2-digit' }).format(new Date());
    $('#gis-score').textContent = 'Индекс 2GIS · ' + score + '/10 · ' + now;
    if (S.obsBusy || !S.maps) return;
    S.obsBusy = true;
    try {
      const c = S.maps.live.getCenter();
      const out = await api('/live/traffic', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ score, lon: Number(c[0]), lat: Number(c[1]), zoom: Number(S.maps.live.getZoom()) }) });
      showArchive(out.status);
      if (out.stored) refreshLearn();
    } catch (e) { console.warn('[Twin Bishkek] замер 2GIS не записан:', e.message); } finally { S.obsBusy = false; }
  }
  function showArchive(st) {
    if (!st) return;
    const t = `замеров пробок: ${st.traffic_observations} · снимков воздуха: ${st.environment_snapshots}`;
    $('#gis-archive').textContent = t;
    $('#learn-count').textContent = t;
  }

  // ---------- рисуем нашу модель поверх 2GIS ----------
  function schedule(ms) { clearTimeout(S.timer); S.timer = setTimeout(draw, ms); }
  const toHexA = (c, a) => {
    let rgb;
    if (c[0] === '#') rgb = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
    else rgb = (c.match(/\d+(\.\d+)?/g) || [128, 128, 128]).slice(0, 3).map((v) => Math.round(+v));
    return '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('') + Math.round(a * 255).toString(16).padStart(2, '0');
  };
  const circle = (c, r) => Array.from({ length: 49 }, (_, i) => {
    const a = (2 * Math.PI * i) / 48;
    return [c[0] + (Math.cos(a) * r) / (111320 * Math.cos((c[1] * Math.PI) / 180)), c[1] + (Math.sin(a) * r) / 111320];
  });
  let HEX_RINGS = null;
  function hexRings() {
    if (HEX_RINGS) return HEX_RINGS;
    const G = M.grid();
    HEX_RINGS = G.hexes.map((h) => { const r = []; for (let k = 0; k < 6; k++) { const p = G.corner(h, k); r.push(D.toLonLat(p[0], p[1])); } r.push(r[0]); return r; });
    return HEX_RINGS;
  }

  function draw() {
    if (!S.maps || !S.ready || S.mode !== 'gis' || !S.last || !S.maps.ready.sim || !window.mapgl) return;
    const { sim } = S.last, layer = S.last.state.layer || 'both', map = S.maps.sim, g = window.mapgl;
    document.querySelectorAll('#ctl-layer-gis button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === layer)));
    const zoom = map.getZoom(), k = clamp((zoom - 9) / 4, 0.6, 2.4);
    const SEG = M.segments();
    const cls = Array.from(sim.seg.vc, (v, i) => TB.map.congestion(v, sim.seg.closed[i])[0]).join('');
    let aq = 0; for (let i = 0; i < sim.aqi.length; i++) aq += Math.round(sim.aqi[i]);
    const sig = [layer, Math.round(zoom * 2), cls, aq, JSON.stringify(sim.params.objects), JSON.stringify(sim.params.events), JSON.stringify(sim.params.roads || [])].join('|');
    if (sig === S.sig) return;
    S.sig = sig;
    S.maps.objs.forEach((o) => { try { o.destroy(); } catch (e) { /* уже удалён */ } });
    const objs = S.maps.objs = [];
    const add = (o) => objs.push(o);
    try {
      if (layer !== 'traffic') {
        const rings = hexRings();
        for (let i = 0; i < rings.length; i++) {
          add(new g.Polygon(map, { coordinates: [rings[i]], color: toHexA(TB.map.aqiColor(sim.aqi[i]), 0.42), strokeWidth: 0, zIndex: 2, interactive: false }));
        }
      }
      if (layer !== 'air') {
        // подряд идущие отрезки одной улицы и одного цвета склеиваем: в разы меньше объектов на карте
        const runs = [];
        SEG.forEach((s, i) => {
          const c = TB.map.congestion(sim.seg.vc[i], sim.seg.closed[i]);
          const a = D.toLonLat(s.ax, s.ay), b = D.toLonLat(s.bx, s.by), last = runs[runs.length - 1];
          if (last && last.street === s.street && last.c === c && Math.hypot(last.end[0] - a[0], last.end[1] - a[1]) < 1e-5) { last.pts.push(b); last.end = b; last.lanes = Math.max(last.lanes, s.lanes); }
          else runs.push({ street: s.street, c, pts: [a, b], end: b, lanes: s.lanes });
        });
        for (const r of runs) {
          const w = (2.2 + r.lanes * 0.8) * k;
          if (zoom >= 12) add(new g.Polyline(map, { coordinates: r.pts, width: w + 1.6, color: '#ffffffd9', zIndex: 4, interactive: false }));
          add(new g.Polyline(map, { coordinates: r.pts, width: w, color: COL[r.c] + (r.c === 'closed' ? '99' : 'ee'), zIndex: 5, interactive: false }));
        }
      }
      // новые дороги: цвет по загрузке, стройка — серым пунктиром; тоннель тоньше и полупрозрачный (он под землёй)
      for (const r of sim.roads || []) {
        const pts = r.pts.map(([x, y]) => D.toLonLat(x, y));
        const name = { tunnel: 'Тоннель', elevated: 'Эстакада', surface: 'Новая дорога' }[r.kind];
        if (r.ph === 'build') add(new g.Polyline(map, { coordinates: pts, width: 5 * k, color: '#8e8e93cc', dashLength: 8, gapLength: 6, zIndex: 6, interactive: false }));
        else r.segs.forEach((s, j) => {
          const c = TB.map.congestion(r.vc[j], 0);
          add(new g.Polyline(map, { coordinates: [D.toLonLat(s[0], s[1]), D.toLonLat(s[2], s[3])], width: (r.kind === 'tunnel' ? 3 : 5) * k, color: COL[c] + (r.kind === 'tunnel' ? '88' : 'ff'), zIndex: 6, interactive: false }));
        });
        add(new g.Marker(map, { coordinates: pts[pts.length >> 1], label: { text: name + (r.ph === 'build' ? ' · стройка' : ''), fontSize: 11, color: '#1d1d1f', offset: [0, -12] } }));
      }
      // объекты конструктора
      for (const o of sim.params.objects || []) {
        const d = D.byId[o.d], t = D.OBJECT_TYPES[o.t];
        if (!d || !t) continue;
        add(new g.Marker(map, { coordinates: D.toLonLat(d.x, d.y), label: { text: t.name + (o.n > 1 ? ' ×' + o.n : '') + (o.ph === 'build' ? ' · стройка' : ''), fontSize: 11, color: '#1d1d1f', offset: [0, -12] } }));
      }
      // события
      const ev = sim.params.events || {};
      if (ev.match) {
        const v = D.STADIUMS[ev.venue] || D.STADIUM, c = D.toLonLat(v.x, v.y);
        add(new g.Polyline(map, { coordinates: circle(c, 1800), width: 2, color: '#0071e3aa', zIndex: 3, interactive: false }));
        add(new g.Marker(map, { coordinates: c, label: { text: 'Матч · ' + (v.name || ''), fontSize: 11, color: '#1d1d1f', offset: [0, -12] } }));
      }
      if (ev.bridge && D.BRIDGES[ev.bridge]) {
        const b = D.BRIDGES[ev.bridge];
        add(new g.Marker(map, { coordinates: D.toLonLat(b.x, b.y), label: { text: 'Мост закрыт: ' + b.name, fontSize: 11, color: '#1d1d1f', offset: [0, -12] } }));
      }
      if (ev.closure || ev.widen) {
        const idx = []; sim.seg.closed.forEach((c, i) => { if (c === 1) idx.push(i); });
        if (idx.length) {
          const s = SEG[idx[idx.length >> 1]];
          add(new g.Marker(map, { coordinates: D.toLonLat(s.mx, s.my), label: { text: ev.closure ? 'Полоса закрыта: ' + (D.CLOSURES[ev.closure] || {}).name : 'Расширение', fontSize: 11, color: '#1d1d1f', offset: [0, -12] } }));
        }
      }
    } catch (e) { console.warn('[Twin Bishkek] отрисовка поверх 2GIS:', e.message); setStatus('Не получилось нарисовать слой: ' + e.message); }
    const ttl = $('#map-sim-title');
    if (ttl) $('#gis-sim-title').textContent = ttl.textContent;
  }

  // ---------- карточка «Что модель узнала» ----------
  const NS = 'http://www.w3.org/2000/svg';
  function drawLearn(L) {
    const box = $('#learn-chart');
    const W = 720, H = 220, p = { l: 36, r: 12, t: 12, b: 28 }, iw = W - p.l - p.r, ih = H - p.t - p.b;
    const x = (h) => p.l + (iw * (h + 0.5)) / 24, y = (v) => p.t + ih * (1 - clamp(v, 0, 10) / 10);
    const prof = L.model_profile;
    const f = (v) => (L.a !== null && L.b ? L.a + L.b * v : 1 + (v / Math.max(...prof)) * 7);
    let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Балл 2GIS по часам и ритм модели" style="display:block;max-width:${W}px">`;
    for (const v of [0, 2.5, 5, 7.5, 10]) svg += `<line x1="${p.l}" x2="${W - p.r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" stroke-width="1"/><text x="${p.l - 6}" y="${y(v) + 4}" text-anchor="end" font-size="10" fill="var(--text-muted)">${v}</text>`;
    for (let h = 0; h < 24; h += 3) svg += `<text x="${x(h)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="var(--text-muted)">${String(h).padStart(2, '0')}</text>`;
    L.hourly.forEach((r) => { if (r.n > 0) svg += `<rect x="${x(r.hour) - 9}" y="${y(r.score)}" width="18" height="${y(0) - y(r.score)}" rx="2" fill="var(--accent)" opacity="${r.n >= 3 ? 0.85 : 0.35}"><title>${String(r.hour).padStart(2, '0')}:00 · балл 2GIS ${r.score.toFixed(1)} · замеров ${r.n} в ${r.days} дн.</title></rect>`; });
    svg += `<polyline fill="none" stroke="var(--text)" stroke-width="2" stroke-dasharray="5 3" points="${prof.map((v, h) => x(h) + ',' + y(f(v))).join(' ')}"/>`;
    svg += '</svg>';
    box.innerHTML = svg + '<p class="learn__legend"><span><i class="learn__bar"></i>балл 2GIS (среднее по часу)</span><span><i class="learn__dash"></i>ритм нашей модели' + (L.a !== null ? '' : ' (условный масштаб)') + '</span></p>';
  }
  async function refreshLearn() {
    if (!S.serverUp) return;
    try {
      const L = await api('/live/learned');
      $('#learn-card').hidden = false;
      drawLearn(L);
      const v = $('#learn-verdict');
      v.textContent = L.usable ? L.reason + (S.learned ? ' Поправка включена в расчёт.' : ' Включите «Учитывать замеры 2GIS», чтобы применить её.') : L.reason;
      v.dataset.state = L.usable ? 'ok' : 'wait';
      $('#gis-learn-wrap').hidden = false;
      $('#gis-learn-wrap').dataset.ready = L.usable ? '1' : '0';
    } catch (e) { /* сервер недоступен: карточка просто не обновится */ }
    try {
      const E = await api('/live/environment');
      const box = $('#learn-env');
      if (!E.available) { box.textContent = E.reason || ''; return; }
      const a = E.air || {}, w = E.weather || {};
      const now = new Date(), hr = +new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bishkek', hour: '2-digit', hour12: false }).format(now) % 24;
      const month = now.getMonth() + 1, season = month >= 11 || month <= 3 ? 'winter' : 'summer';
      const mod = M.simulateLocal ? M.simulateLocal({ season, hour: hr }) : null;
      const fmt = (v, d) => (v === null || v === undefined ? '—' : Number(v).toFixed(d).replace('.', ','));
      box.innerHTML = `<b>Воздух и погода сейчас</b> · CAMS Global, фон города (ячейка ≈ 45 км): PM2.5 <b class="num">${fmt(a.pm2_5, 1)}</b> µg/m³, AQI (US) <b class="num">${fmt(a.us_aqi, 0)}</b>, ${fmt(w.temperature_2m, 1)} °C, ветер ${fmt(w.wind_speed_10m, 1)} км/ч.` +
        (mod ? ` Наша модель на этот час (${season === 'winter' ? 'зима' : 'лето'}): PM2.5 <b class="num">${fmt(mod.city.pm, 1)}</b>, AQI <b class="num">${fmt(mod.city.aqi, 0)}</b>. Числа могут расходиться: CAMS даёт модельный фон для ячейки ≈ 45 км и не видит локальных источников.` : '');
    } catch (e) { /* без интернета у сервера — блок воздуха не показываем */ }
  }

  // ---------- старт ----------
  async function init() {
    document.querySelectorAll('#ctl-basemap button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.value)));
    $('#gis-key').addEventListener('submit', (e) => {
      e.preventDefault();
      const k = $('#gis-key-input').value.trim();
      if (!k) return;
      S.key = k; safe.sset('tb-mapgl-key', k); $('#gis-key').hidden = true; setMode('gis');
    });
    document.querySelectorAll('#ctl-layer-gis button').forEach((b) => b.addEventListener('click', () => {
      if (!S.last) return;
      S.last.state.layer = b.dataset.value; // тот же слой, что у кнопок схемы
      TB.screens.sim.render(false);
    }));
    $('#gis-key-btn').addEventListener('click', () => { $('#gis-key').hidden = false; $('#gis-key-input').focus(); });
    const chk = $('#gis-learn');
    chk.checked = !!S.learned;
    chk.addEventListener('change', () => {
      S.learned = chk.checked; safe.set('tb-learned', S.learned);
      if (TB.backend) { TB.backend.learned = S.learned; TB.backend.clearCache(); }
      TB.screens.sim.render(false);
      refreshLearn();
    });
    document.addEventListener('tb:render', (e) => { S.last = e.detail; if (S.mode === 'gis') schedule(140); });

    let cfg = null;
    try { cfg = await api('/live/config'); S.serverUp = true; } catch (e) { S.serverUp = false; }
    if (!S.serverUp) { setStatus('Сервер не запущен: карта 2GIS и сбор данных недоступны, показана схема'); return; }
    $('#gis-key-btn').hidden = false;
    S.key = (cfg && cfg.mapgl_key) || safe.sget('tb-mapgl-key');
    try { showArchive(await api('/live/status')); } catch (e) { /* не страшно */ }
    refreshLearn();
    setInterval(refreshLearn, 60000);
    const want = safe.get('tb-basemap', S.key ? 'gis' : 'schema');
    if (want === 'gis' && S.key) setMode('gis');
    else setStatus(S.key ? 'Показана схема OSM' : 'Карта 2GIS не подключена: нужен ключ (кнопка «Карта 2GIS»)');
  }

  TB.live = { state: S, draw, refreshLearn };
  init();
})();
