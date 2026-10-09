/* Twin Bishkek · новая дорога через город: тоннель, эстакада или обычная.
   Трассу можно нарисовать кликами по карте «Если…» или описать словами («тоннель от Джала до Учкуна через центр»).
   Сама модель дорог — в model.js / simulator.py (P.road); здесь только интерфейс и разбор текста. */
(function () {
  const TB = (window.TB = window.TB || {});
  const D = TB.data, M = TB.model;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
  const NS = 'http://www.w3.org/2000/svg';

  const KIND = {
    tunnel: { name: 'Тоннель', hint: 'Под землёй: без светофоров, выхлоп выходит у порталов. Строится дольше всех (~3 года), но почти не перекрывает улицы.' },
    elevated: { name: 'Эстакада', hint: 'Над улицами: без светофоров, выхлоп рассеивается выше. Во время стройки опоры сужают улицы (~2 года).' },
    surface: { name: 'Обычная дорога', hint: 'На земле со светофорами: дешевле и быстрее в стройке (~1 год), но на пересечениях появляются новые светофоры.' },
  };
  const lengthKm = (pts) => { let l = 0; for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return (l * 25) / 1000; }; // 1 px = 25 м
  const fmt = (v, d) => Number(v).toFixed(d).replace('.', ',');
  const lanesWord = (n) => `${n} ${n >= 5 ? 'полос' : 'полосы'}`;
  const label = (r) => `${KIND[r.kind].name} · ${lanesWord(r.lanes)} · ${fmt(lengthKm(r.pts), 1)} км${r.ph === 'build' ? ' · стройка' : ''}`;

  // ---------- разбор маршрута словами ----------
  // Места: районы, стадионы и парки, главные улицы. Совпадение по основе слова: «Джала», «Джале» → Джал.
  const STOP = new Set(['им', 'пр', 'ул', 'парк', 'стадион', 'баатыра']);
  const stem = (w) => (/^\d+$/.test(w) ? w : w.length >= 6 ? w.slice(0, w.length - 2) : w.length >= 4 ? w.slice(0, w.length - 1) : w.slice(0, Math.max(2, w.length - 1)));
  const words = (s) => s.toLowerCase().replace(/ё/g, 'е').split(/[^a-zа-я0-9]+/i).filter(Boolean);
  function gazetteer() {
    const out = [];
    const add = (name, x, y, kind, id) => {
      const ws = words(name).filter((w) => !STOP.has(w));
      if (ws.length) out.push({ name, x, y, kind, id, stems: ws.map(stem) });
    };
    D.DISTRICTS.forEach((d) => add(d.name, d.x, d.y, 'district', d.id));
    D.VENUES.forEach((v) => add(v.name, v.x, v.y, 'venue', v.id));
    D.STREET_LABELS.forEach((s) => add(s.name, s.x, s.y, 'street', s.id));
    // разговорные синонимы
    const byId = (id) => D.byId[id];
    [['центр', 'center'], ['площадь', 'center'], ['ала-тоо', 'center'], ['восток', 'vostok'], ['север', 'north'], ['юг', 'south'], ['запад', 'west'], ['дордой', 'north']].forEach(([w, id]) => {
      const d = byId(id);
      if (d) out.push({ name: d.name, x: d.x, y: d.y, kind: 'district', id, stems: words(w).map(stem) });
    });
    return out.sort((a, b) => b.stems.length - a.stems.length); // сначала длинные названия («Арча-Бешик» раньше «Арча»)
  }
  let GAZ = null;

  // точки улицы, упорядоченные вдоль коридора от a до b (или по всей улице, если концов нет)
  function alongStreet(id, a, b) {
    let pts = [];
    D.STREETS.forEach((s) => { if (s.id === id) pts.push([(s.pts[0][0] + s.pts[1][0]) / 2, (s.pts[0][1] + s.pts[1][1]) / 2]); });
    if (!pts.length) return null;
    if (!a || !b) { // вся улица: две самые дальние точки
      let best = 0;
      pts.forEach((p) => pts.forEach((q) => { const d = Math.hypot(p[0] - q[0], p[1] - q[1]); if (d > best) { best = d; a = p; b = q; } }));
    }
    const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1;
    pts = pts.map((p) => ({ p, t: ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2, off: Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / Math.sqrt(L2) }))
      .filter((o) => o.t > 0.02 && o.t < 0.98 && o.off < 80).sort((x, y) => x.t - y.t);
    const out = [a];
    pts.forEach((o) => { const l = out[out.length - 1]; if (Math.hypot(o.p[0] - l[0], o.p[1] - l[1]) >= 35) out.push(o.p); });
    out.push(b);
    return out;
  }

  function parse(text) {
    GAZ = GAZ || gazetteer();
    const t = text.toLowerCase().replace(/ё/g, 'е'), toks = words(t), res = {};
    if (/тонн|подзем/.test(t)) res.kind = 'tunnel';
    else if (/эстакад|надзем|над улиц/.test(t)) res.kind = 'elevated';
    else if (/обычн|наземн|на земле/.test(t)) res.kind = 'surface';
    const ln = t.match(/(\d)\s*-?\s*(х\s*)?полос/);
    if (ln) res.lanes = +ln[1];
    // ищем места в порядке текста и роль каждого по ближайшему слову перед ним: от/из → начало, до/к/в → конец, через → середина
    const found = [], used = new Set();
    let role = 'from', along = false;
    for (let i = 0; i < toks.length; i++) {
      const w = toks[i];
      if (w === 'от' || w === 'из' || w === 'с') { role = 'from'; continue; }
      if (w === 'до' || w === 'к' || w === 'в' || w === 'на') { role = 'to'; continue; }
      if (w === 'через') { role = 'via'; continue; }
      if (w === 'вдоль' || w === 'по') { along = true; continue; }
      const hit = GAZ.find((g) => g.stems.every((s, k) => toks[i + k] && toks[i + k].startsWith(s)));
      if (!hit) { along = false; continue; }
      i += hit.stems.length - 1;
      if (along && hit.kind === 'street') { res.street = hit; along = false; continue; }
      along = false;
      const key = hit.kind + ':' + hit.id;
      if (used.has(key)) continue;
      used.add(key);
      found.push({ ...hit, role });
      if (role === 'from') role = 'to'; // «от А Б» — второе место считаем концом
    }
    const from = found.filter((f) => f.role === 'from'), via = found.filter((f) => f.role === 'via'), to = found.filter((f) => f.role === 'to');
    const seq = [...from, ...via, ...to];
    res.places = seq;
    res.names = seq.map((f) => f.name);
    if (res.street) {
      const a = seq[0] ? [seq[0].x, seq[0].y] : null, b = seq.length > 1 ? [seq[seq.length - 1].x, seq[seq.length - 1].y] : null;
      res.pts = alongStreet(res.street.id, a, b);
      res.names = [`вдоль: ${res.street.name}`, ...res.names];
    } else if (seq.length >= 2) res.pts = seq.map((f) => [f.x, f.y]);
    if (!res.pts || res.pts.length < 2) res.error = 'Не понял маршрут. Назовите хотя бы два места: районы (Джал, Учкун, Асанбай, Восток-5…), «центр», стадион или улицу, например «от Джала до Учкуна через центр» или «эстакада вдоль Ахунбаева».';
    return res;
  }

  // ---------- интерфейс ----------
  const ui = { kind: 'tunnel', lanes: 4, phase: 'done' };
  const st = () => TB.state, sim = () => TB.screens.sim;
  const hint = (msg) => { $('#road-hint').textContent = msg || ''; };

  function addRoad(r, how) {
    const p = st().params;
    if ((p.roads || []).length >= M.P.road.max) { hint(`Не больше ${M.P.road.max} новых дорог в одном сценарии: уберите одну.`); return false; }
    const n = M.normalize({ ...p, roads: [...(p.roads || []), r] });
    if (n.roads.length === (p.roads || []).length) { hint('Трасса слишком короткая (меньше 500 м) или вне карты.'); return false; }
    st().params = n;
    sim().render(true);
    const nr = n.roads[n.roads.length - 1];
    hint(`${how}: ${label(nr)}.`);
    TB.ui.toast('Новая дорога: ' + label(nr));
    return true;
  }

  function paintChips() {
    const roads = st().params.roads || [];
    $('#road-chips').innerHTML = roads.map((r, i) => `<span class="chip"><svg class="ic"><use href="#i-route"/></svg>${TB.ui.esc(label(r))}<button type="button" data-road-del="${i}" aria-label="Убрать дорогу"><svg class="ic"><use href="#i-x"/></svg></button></span>`).join('');
  }
  const paintSeg = (id, v) => $$('#' + id + ' button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === v)));

  // Рисование линии кликами по карте «Если…» (общее для дорог и деревьев); клики не выбирают район.
  // o: { bar — панель с кнопками [data-draw=done|undo|cancel], btn — кнопка запуска (прячется), hint(msg), done(pts) }
  let drawing = null;
  function startDraw(o) {
    if (drawing) stopDraw();
    const gisBtn = $('#ctl-basemap [data-value="schema"]');
    if (gisBtn && gisBtn.getAttribute('aria-pressed') !== 'true') gisBtn.click(); // рисуем на схеме
    const map = sim().mapSim, svg = map.svg;
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', 'm-draw');
    svg.appendChild(g);
    const d = (drawing = { ...o, pts: [], g, svg, map });
    d.onClick = (e) => {
      e.stopPropagation(); e.preventDefault();
      if (e.detail > 1) return; // второй клик двойного — не новая точка
      d.pts.push(map.toMap(e.clientX, e.clientY).map((v) => Math.round(v)));
      paintDraw();
    };
    d.onDbl = (e) => { e.stopPropagation(); e.preventDefault(); finishDraw(); };
    d.onKey = (e) => { if (e.key === 'Escape') cancelDraw(); else if (e.key === 'Enter') finishDraw(); else if (e.key === 'Backspace' && d.pts.length) { e.preventDefault(); d.pts.pop(); paintDraw(); } };
    d.onBar = (e) => { const b = e.target.closest('[data-draw]'); if (!b) return; ({ done: finishDraw, cancel: cancelDraw, undo: () => { d.pts.pop(); paintDraw(); } })[b.dataset.draw](); };
    svg.addEventListener('click', d.onClick, true);
    svg.addEventListener('dblclick', d.onDbl, true);
    document.addEventListener('keydown', d.onKey);
    d.bar.addEventListener('click', d.onBar);
    svg.classList.add('is-drawing');
    d.bar.hidden = false;
    d.btn.hidden = true;
    d.hint('');
    svg.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function paintDraw() {
    const d = drawing;
    if (!d) return;
    d.g.textContent = '';
    if (d.pts.length > 1) {
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', 'M' + d.pts.map((p) => p.join(' ')).join('L'));
      d.g.appendChild(path);
    }
    d.pts.forEach(([x, y]) => { const c = document.createElementNS(NS, 'circle'); c.setAttribute('cx', x); c.setAttribute('cy', y); c.setAttribute('r', 5); d.g.appendChild(c); });
    d.hint(d.pts.length ? `Точек: ${d.pts.length} · ${fmt(lengthKm(d.pts), 1)} км` : '');
  }
  function stopDraw() {
    const d = drawing;
    if (!d) return;
    d.svg.removeEventListener('click', d.onClick, true);
    d.svg.removeEventListener('dblclick', d.onDbl, true);
    document.removeEventListener('keydown', d.onKey);
    d.bar.removeEventListener('click', d.onBar);
    d.svg.classList.remove('is-drawing');
    d.g.remove();
    d.bar.hidden = true;
    d.btn.hidden = false;
    drawing = null;
  }
  function finishDraw() {
    const d = drawing;
    if (!d) return;
    if (d.pts.length < 2) { d.hint('Поставьте хотя бы две точки.'); return; }
    const pts = d.pts.slice();
    stopDraw();
    d.done(pts);
  }
  function cancelDraw() { const d = drawing; stopDraw(); if (d) d.hint('Рисование отменено.'); }

  function init() {
    if (!$('#road-kind') || !TB.screens || !TB.screens.sim.mapSim) return;
    $('#road-kind-hint').textContent = KIND[ui.kind].hint;
    $('#road-kind').addEventListener('click', (e) => {
      const b = e.target.closest('[data-value]'); if (!b) return;
      ui.kind = b.dataset.value; paintSeg('road-kind', ui.kind); $('#road-kind-hint').textContent = KIND[ui.kind].hint;
    });
    $('#road-phase').addEventListener('click', (e) => {
      const b = e.target.closest('[data-value]'); if (!b) return;
      ui.phase = b.dataset.value; paintSeg('road-phase', ui.phase);
    });
    $('#road-lanes').addEventListener('change', (e) => { ui.lanes = +e.target.value; });
    $('#road-draw').addEventListener('click', () => startDraw({
      bar: $('#road-drawbar'), btn: $('#road-draw'), hint,
      done: (pts) => addRoad({ kind: ui.kind, lanes: ui.lanes, ph: ui.phase, pts }, 'Нарисована'),
    }));
    $('#road-text-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const text = $('#road-text').value.trim();
      if (!text) { hint('Напишите маршрут, например: «тоннель от Джала до Учкуна через центр».'); return; }
      const r = parse(text);
      if (r.error) { hint(r.error); return; }
      if (r.kind) { ui.kind = r.kind; paintSeg('road-kind', ui.kind); $('#road-kind-hint').textContent = KIND[ui.kind].hint; }
      if (r.lanes) { ui.lanes = Math.min(8, Math.max(2, r.lanes)); const sel = $('#road-lanes'); if ([...sel.options].some((o) => +o.value === ui.lanes)) sel.value = ui.lanes; }
      if (addRoad({ kind: ui.kind, lanes: ui.lanes, ph: /стро(ится|йка)/.test(text.toLowerCase()) ? 'build' : ui.phase, pts: r.pts }, 'Понял: ' + r.names.join(' → '))) $('#road-text').value = '';
    });
    $('#road-chips').addEventListener('click', (e) => {
      const b = e.target.closest('[data-road-del]'); if (!b) return;
      const p = st().params;
      p.roads = (p.roads || []).filter((_, i) => i !== +b.dataset.roadDel);
      sim().render(true);
    });
    document.addEventListener('tb:render', paintChips);
    paintChips();
  }
  TB.roads = { parse, label, lengthKm, KIND, startDraw, words, stem };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
