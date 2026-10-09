/* Twin Bishkek · план изменений во времени.
   Человек записывает, что и когда строится или перекрывается (месяц начала и конца). Ползунок по месяцам собирает из плана
   сценарий на выбранную дату: пока идёт стройка объект в стадии «строится», после конца он «построен»; перекрытия действуют
   только внутри своего окна. Расчёт — та же модель (TB.model), что и везде; сам план хранится на сервере (/plan),
   а без сервера — в браузере (localStorage). */
(function () {
  const TB = (window.TB = window.TB || {});
  const D = TB.data, M = TB.model;
  const $ = (s, r) => (r || document).querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const safe = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* приватный режим: план не запомнится */ } },
  };
  const KINDS = {
    build: { label: 'Строительство', color: '#2f7fb5' },
    closure: { label: 'Перекрытие улицы', color: '#e8604c' },
    bridge: { label: 'Мост закрыт', color: '#f2953a' },
    widen: { label: 'Новая магистраль', color: '#4cb87a' },
    road: { label: 'Новая дорога', color: '#8a4ba6' },
    trees: { label: 'Посадка деревьев', color: '#2e8b57' },
  };
  const isRoad = (it) => it.kind === 'road';
  const isTrees = (it) => it.kind === 'trees';
  // посадка в сценарии модели: возраст считается от месяца посадки
  const treeOf = (it, age) => ({ sp: it.sp, n: it.n, age: age || 0, d: it.where || undefined, s: it.street || undefined, pts: it.pts || undefined });
  const roadOf = (it) => ({ kind: it.rkind, lanes: it.lanes, pts: it.pts }); // как в сценарии модели (без стадии)
  const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
  const MON3 = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  const toIdx = (s) => { const [y, m] = s.split('-').map(Number); return y * 12 + (m - 1); };
  const fromIdx = (i) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
  const nowD = new Date();
  const T0 = nowD.getFullYear() * 12 + nowD.getMonth(); // текущий месяц
  const monthName = (i) => `${MONTHS[i % 12]} ${Math.floor(i / 12)}`;

  // Эталон модели = ЖК на ~4000 жителей, т.е. ~1140 семей по 3,5 человека (допущение, официальный размер семьи ещё не сверен).
  const PERSONS_PER_FAMILY = 3.5;
  // Нормы парковок: СН КР 30-01:2020 «Планировка и застройка городов…», приложение З (обязательное).
  // ЖК: примечание 1 к прил. З: жители × 0,8 м²/чел (табл. 1) / 18 м² на машино-место ≈ 1 место на 22,5 жителя.
  // ТЦ: п. 4.2, 1 место на 70–80 м² торговой площади (берём 75). Аттракционы: п. 5.6, 1 место на 8–10 единовременных
  // посетителей (берём 9), а единовременно в парке ~30% дневных посетителей (ДОПУЩЕНИЕ). Парк: в нормах числа нет (отсылка к разд. 9),
  // 15 мест на га остаётся ДОПУЩЕНИЕМ.
  const FUN_SIMULTANEOUS = 0.3;
  const BLD = {
    jk: { cap: 'Семей', unit: 'семей', def: 600, per: 1140, need: (c) => (c * PERSONS_PER_FAMILY * 0.8) / 18, needNote: 'СН КР 30-01:2020: ≈1 место на 22,5 жителя' },
    tc: { cap: 'Торговая площадь, м²', unit: 'м²', def: 15000, per: 20000, need: (c) => c / 75, needNote: 'СН КР 30-01:2020: 1 место на 70–80 м²' },
    park: { cap: 'Площадь, га', unit: 'га', def: 5, per: 10, need: (c) => c * 15, needNote: '15 мест на га, допущение: в нормах КР числа нет' },
    fun: { cap: 'Посетителей в день', unit: 'чел./день', def: 3000, per: 5000, need: (c) => (c * FUN_SIMULTANEOUS) / 9, needNote: 'СН КР 30-01:2020: 1 место на 8–10 одновременных посетителей; одновременно ~30% дневных, допущение' },
  };
  const nf = (v) => Math.round(v).toLocaleString('ru-RU');
  // масштаб n (во сколько раз больше эталона) и поправка нагрузки tk: нехватка парковок выдавливает машины на улицы (до +50%)
  function effect(it) {
    const b = BLD[it.type], cap = +it.cap || 0, n = Math.max(0.05, Math.min(9, Math.round((cap / b.per) * 100) / 100));
    const need = b.need(cap), spots = it.spots === null || it.spots === undefined || it.spots === '' ? null : +it.spots;
    const shortage = spots !== null && need > 0 ? Math.max(0, 1 - spots / need) : 0;
    return { n, need, spots, shortage, tk: Math.round((1 + 0.5 * shortage) * 1000) / 1000, people: it.type === 'jk' ? cap * PERSONS_PER_FAMILY : null };
  }
  const details = (it) => {
    if (isTrees(it)) {
      const g = Math.ceil(M.grownAge(it.sp)), done = toIdx(it.start) + g * 12;
      return [it.route ? esc(it.route) : TB.trees.label(treeOf(it)).split(' · ')[1], `вырастут (80% кроны) примерно к ${Math.floor(done / 12)} году`].join(' · ');
    }
    if (isRoad(it)) return [`${it.lanes} полос${it.lanes >= 5 ? '' : 'ы'}`, `${fmt(TB.roads.lengthKm(it.pts), 1)} км`, it.route ? esc(it.route) : 'трасса с карты'].join(' · ');
    if (it.kind !== 'build') return '';
    const b = BLD[it.type], e = effect(it), out = [`${nf(it.cap)} ${b.unit}`];
    if (e.people) out.push(`≈ ${nf(e.people)} жителей`);
    if (e.spots !== null) out.push(`парковок ${nf(e.spots)} из ~${nf(e.need)} нужных` + (e.shortage > 0.01 ? ` (дефицит ${Math.round(e.shortage * 100)}%, улицы ×${fmt(e.tk, 2)})` : ' (хватает)'));
    else out.push(`парковки не указаны (нужно ~${nf(e.need)})`);
    if (it.floors) out.push(`${it.floors} эт.`);
    if (it.note) out.push(esc(it.note));
    return out.join(' · ');
  };

  const S = { items: [], t: T0, metric: 'delay', follow: false, timer: null, cache: new Map(), range: [T0, T0 + 36] };

  // ---------- данные ----------
  const valid = (it) => it && KINDS[it.kind] && /^\d{4}-\d{2}$/.test(it.start) && /^\d{4}-\d{2}$/.test(it.end) && toIdx(it.end) > toIdx(it.start) &&
    (isTrees(it) ? !!M.normalize({ trees: [treeOf(it)] }).trees.length
      : isRoad(it) ? !!M.normalize({ roads: [roadOf(it)] }).roads.length
      : it.kind === 'build' ? D.byId[it.where] && BLD[it.type] && +it.cap > 0 : it.kind === 'bridge' ? D.BRIDGES[it.where] : D.CLOSURES[it.where]);
  S.items = safe.get('tb-plan', []).filter(valid);

  // План живёт на сервере (GET/PUT /plan), поэтому он одинаковый на всех компьютерах. Копия в localStorage —
  // на случай, когда сервера нет (сайт открыт как файл или бэкенд выключен): тогда всё работает как раньше, только локально.
  const API = (location.protocol === 'file:' ? 'http://localhost:8000' : '') + '/plan';
  let server = false;
  const push = () => fetch(API, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: S.items }) })
    .then((r) => { if (!r.ok) throw new Error('PUT /plan → ' + r.status); server = true; })
    .catch((e) => { server = false; console.warn('[Twin Bishkek] план не сохранился на сервере, он есть только в этом браузере:', e.message); });
  const save = () => { safe.set('tb-plan', S.items); push(); };
  function pull() {
    return fetch(API).then((r) => (r.ok ? r.json() : Promise.reject(new Error('GET /plan → ' + r.status)))).then((js) => {
      server = true;
      const items = (js.items || []).filter(valid);
      if (!js.updated && S.items.length) return push(); // на сервере ещё пусто: отдаём ему то, что накопилось в браузере
      if (JSON.stringify(items) === JSON.stringify(S.items)) return;
      S.items = items; safe.set('tb-plan', S.items);
      if (!S.timer) refresh();
    }).catch(() => { server = false; });
  }
  const nameRaw = (it) => isTrees(it) ? `${M.P.trees.species[it.sp].name} ×${Math.round(it.n).toLocaleString('ru-RU')}`
    : isRoad(it) ? it.title || `Новая дорога: ${TB.roads.KIND[it.rkind].name.toLowerCase()}`
    : it.kind === 'build'
    ? `${it.title || D.OBJECT_TYPES[it.type].long} · ${D.byId[it.where].name}`
    : it.kind === 'closure' ? `Перекрытие: ${D.CLOSURES[it.where].name}`
      : it.kind === 'bridge' ? `Мост ${D.BRIDGES[it.where].name} закрыт`
        : `Новая магистраль: ${D.CLOSURES[it.where].name}`;
  const nameOf = (it) => esc(nameRaw(it));

  // Сценарий на месяц t: объекты по стадиям + события в своих окнах. Модель держит по одному перекрытию, мосту и расширению сразу.
  function compose(t) {
    const objects = [], roads = [], trees = [], ev = { closure: null, bridge: null, widen: null }, conflicts = new Set();
    const put = (slot, val, label) => { if (ev[slot] && ev[slot] !== val) conflicts.add(label); ev[slot] = val; };
    [...S.items].sort((a, b) => toIdx(a.start) - toIdx(b.start)).forEach((it) => {
      const a = toIdx(it.start), b = toIdx(it.end);
      if (isTrees(it)) { if (t >= a) trees.push(treeOf(it, Math.floor((t - a) / 12))); } // растут с месяца посадки
      else if (isRoad(it)) { if (t >= a) roads.push({ ...roadOf(it), ph: t < b ? 'build' : 'done' }); }
      else if (it.kind === 'build') { if (t >= a) { const e = effect(it); objects.push({ d: it.where, t: it.type, n: e.n, tk: e.tk, ph: t < b ? 'build' : 'done' }); } }
      else if (it.kind === 'closure') { if (t >= a && t < b) put('closure', it.where, 'перекрытий улиц'); }
      else if (it.kind === 'bridge') { if (t >= a && t < b) put('bridge', it.where, 'мостов'); }
      else if (it.kind === 'widen') { if (t >= a && t < b) put('closure', it.where, 'перекрытий улиц'); else if (t >= b) put('widen', it.where, 'новых магистралей'); }
    });
    if (roads.length > M.P.road.max) conflicts.add('новых дорог (учитываются первые ' + M.P.road.max + ')');
    if (trees.length > M.P.trees.max) conflicts.add('посадок деревьев (учитываются первые ' + M.P.trees.max + ')');
    return { objects, roads, trees, ev, conflicts: [...conflicts] };
  }
  function paramsAt(t) {
    const p = TB.state.params, c = compose(t);
    return { p: M.normalize({ ...p, objects: c.objects, roads: c.roads, trees: c.trees, events: { ...p.events, closure: c.ev.closure, bridge: c.ev.bridge, widen: c.ev.widen } }), c };
  }
  const run = (p) => {
    const key = JSON.stringify(p);
    if (!S.cache.has(key)) { if (S.cache.size > 400) S.cache.clear(); S.cache.set(key, (M.simulateLocal || M.simulate)(p)); }
    return S.cache.get(key);
  };
  const baseRun = () => {
    const p = TB.state.params;
    return run(M.normalize({ ...p, objects: [], roads: [], trees: [], events: { ...p.events, closure: null, bridge: null, widen: null } }));
  };
  const range = () => {
    const maxEnd = S.items.reduce((m, it) => Math.max(m, toIdx(it.end), isTrees(it) ? toIdx(it.start) + 114 : 0), T0); // деревья: показываем 10 лет роста
    return [T0, Math.min(T0 + 120, Math.max(T0 + 36, maxEnd + 6))];
  };

  // ---------- форма ----------
  function fillWhere() {
    const k = $('#plan-kind').value;
    $('#plan-road').hidden = k !== 'road';
    $('#plan-trees').hidden = k !== 'trees';
    $('#plan-where-wrap').hidden = k === 'road';
    if (k === 'road') { $('#plan-type-wrap').hidden = $('#plan-bld').hidden = $('#plan-calc').hidden = true; roadMonths(); return; }
    if (k === 'trees') { // где: район или вдоль улицы; посадка занимает ~1 месяц, дальше деревья растут
      $('#plan-where').innerHTML = D.DISTRICTS.map((d) => `<option value="d:${d.id}">${esc(d.name)}</option>`).join('') +
        TB.trees.STREETS().map(([id, n]) => `<option value="s:${id}">вдоль: ${esc(n)}</option>`).join('');
      $('#plan-type-wrap').hidden = $('#plan-bld').hidden = $('#plan-calc').hidden = true;
      const s = $('#plan-start').value;
      if (/^\d{4}-\d{2}$/.test(s)) $('#plan-end').value = fromIdx(toIdx(s) + 1);
      return;
    }
    const opts = k === 'build' ? D.DISTRICTS.map((d) => [d.id, d.name]) : k === 'bridge' ? Object.entries(D.BRIDGES).map(([id, v]) => [id, 'Мост ' + v.name]) : Object.entries(D.CLOSURES).map(([id, v]) => [id, v.name]);
    $('#plan-where').innerHTML = opts.map(([id, n]) => `<option value="${id}">${esc(n)}</option>`).join('');
    $('#plan-type-wrap').hidden = $('#plan-bld').hidden = k !== 'build';
    if (k === 'build') typeChanged(); else $('#plan-calc').hidden = true;
  }
  function typeChanged() {
    const b = BLD[$('#plan-type').value];
    $('#plan-cap-label').textContent = b.cap;
    $('#plan-cap').value = b.def;
    $('#plan-calc').hidden = false;
    preview();
  }
  function preview() { // сразу показываем, что из введённых цифр получится в модели
    const type = $('#plan-type').value, it = { kind: 'build', type, cap: +$('#plan-cap').value, spots: $('#plan-spots').value === '' ? null : +$('#plan-spots').value };
    const b = BLD[type], e = effect(it), box = $('#plan-calc');
    if (!(it.cap > 0)) { box.textContent = 'Укажите вместимость больше нуля.'; return; }
    box.textContent = `В модели это ${fmt(e.n, 2)} типового объекта` + (e.people ? ` · ≈ ${nf(e.people)} жителей` : '') +
      ` · нужно ~${nf(e.need)} парковочных мест (${b.needNote})` + (e.spots === null ? '. Укажите места, и учтём дефицит.' : e.shortage > 0.01 ? ` · дефицит ${Math.round(e.shortage * 100)}% → нагрузка на соседние улицы ×${fmt(e.tk, 2)}` : ' · парковок хватает');
  }
  // у дороги срок стройки по умолчанию зависит от типа: тоннель ~3 года, эстакада ~2, обычная ~1 (допущение)
  function roadMonths() {
    const s = $('#plan-start').value;
    if (/^\d{4}-\d{2}$/.test(s)) $('#plan-end').value = S.autoEnd = fromIdx(toIdx(s) + M.P.road.months[$('#plan-rkind').value]);
  }
  function showErr(msg) { const e = $('#plan-err'); e.textContent = msg || ''; e.hidden = !msg; }

  // ---------- вывод ----------
  const fmt = (v, d) => Number(v).toFixed(d).replace('.', ',').replace('-', '−');
  const sgn = (v, d) => (Math.abs(v) < Math.pow(10, -d) / 2 ? '±0' : (v > 0 ? '+' : '−') + fmt(Math.abs(v), d));
  const METRIC = {
    delay: { label: 'Задержка в пути, мин', unit: 'мин', d: 1, get: (r) => r.city.delay, worseUp: true },
    aqi: { label: 'AQI', unit: '', d: 0, get: (r) => r.city.aqi, worseUp: true },
    comfort: { label: 'Комфорт, из 100', unit: '', d: 0, get: (r) => r.city.comfort, worseUp: false },
  };

  function renderList() {
    const ul = $('#plan-list');
    if (!S.items.length) { ul.innerHTML = '<li><span>План пуст. Добавьте работы формой выше или нажмите «Пример плана»</span></li>'; return; }
    ul.innerHTML = [...S.items].sort((a, b) => toIdx(a.start) - toIdx(b.start)).map((it) => {
      const on = S.t >= toIdx(it.start) && S.t < toIdx(it.end);
      return `<li class="${on ? 'is-active' : ''}"><i style="background:${KINDS[it.kind].color}"></i><span>${nameOf(it)}${details(it) ? `<br><small class="plan__sub">${details(it)}</small>` : ''}</span><small>${esc(it.start)} → ${esc(it.end)}${on ? ' · идёт' : ''}</small><button type="button" data-del="${it.id}" aria-label="Удалить" title="Удалить из плана">×</button></li>`;
    }).join('');
  }

  function renderTime() {
    const box = $('#plan-time');
    box.hidden = !S.items.length;
    if (!S.items.length) return;
    S.range = range();
    const [lo, hi] = S.range;
    const sl = $('#plan-t');
    sl.min = 0; sl.max = hi - lo;
    S.t = Math.max(lo, Math.min(hi, S.t));
    sl.value = S.t - lo;
    const mo = S.t - T0;
    $('#plan-when').textContent = `${monthName(S.t)} · ${mo === 0 ? 'сейчас' : 'через ' + mo + ' мес.'}`;

    const base = baseRun(), cur = paramsAt(S.t), r = run(cur.p);
    $('#plan-kpis').innerHTML = Object.entries(METRIC).map(([k, m]) => {
      const dv = m.get(r) - m.get(base), bad = m.worseUp ? dv > 0.05 : dv < -0.05, good = m.worseUp ? dv < -0.05 : dv > 0.05;
      return `<div class="plan__kpi"><small>${esc(m.label)}</small><b class="num">${fmt(m.get(r), m.d)}</b> <span class="num" style="color:${bad ? 'var(--worse, #b3402a)' : good ? 'var(--better, #2b7a4b)' : 'var(--text-muted)'}">${sgn(dv, m.d)} к сегодняшнему</span></div>`;
    }).join('');
    $('#plan-note').textContent = (cur.c.conflicts.length ? `В этом месяце пересекаются работы (${cur.c.conflicts.join(', ')}): модель учитывает по одному, побеждает начатое позже. ` : '') +
      'Во время стройки: поток объекта ×0,6, рядом падает пропускная способность, пыль +5%, жителей и зелени ещё нет. Работы на магистрали: полоса закрыта, после конца +50% пропускной способности. Нормы парковок для ЖК, ТЦ и аттракционов взяты из СН КР 30-01:2020, остальные коэффициенты демонстрационные.';
    drawChart(base);
    renderList();
  }

  function drawChart(base) {
    const [lo, hi] = S.range, m = METRIC[S.metric], W = 920, padL = 44, padR = 14, padT = 10, plotH = 150;
    const rows = S.items.length, rowH = 22, H = padT + plotH + 26 + rows * rowH + 8;
    const x = (t) => padL + ((t - lo) / (hi - lo)) * (W - padL - padR);
    const vals = [];
    for (let t = lo; t <= hi; t++) vals.push(m.get(run(paramsAt(t).p)));
    const b = m.get(base);
    let vmin = Math.min(b, ...vals), vmax = Math.max(b, ...vals);
    if (vmax - vmin < 1) { vmax += 0.5; vmin -= 0.5; }
    const pad = (vmax - vmin) * 0.15; vmin = Math.max(0, vmin - pad); vmax += pad;
    const y = (v) => padT + plotH * (1 - (v - vmin) / (vmax - vmin));
    let g = `<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;cursor:pointer" id="plan-svg">`;
    for (let i = 0; i <= 4; i++) {
      const v = vmin + ((vmax - vmin) * i) / 4;
      g += `<line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${padL - 6}" y="${y(v) + 4}" text-anchor="end" font-size="10" fill="var(--text-muted)">${fmt(v, m.d)}</text>`;
    }
    for (let t = lo; t <= hi; t++) if ((t - lo) % 3 === 0) g += `<text x="${x(t)}" y="${padT + plotH + 16}" text-anchor="middle" font-size="10" fill="var(--text-muted)">${MON3[t % 12]} ${String(Math.floor(t / 12)).slice(2)}</text>`;
    g += `<line x1="${padL}" x2="${W - padR}" y1="${y(b)}" y2="${y(b)}" stroke="var(--text-muted)" stroke-dasharray="4 3"/>`;
    g += `<text x="${W - padR}" y="${y(b) - 4}" text-anchor="end" font-size="10" fill="var(--text-muted)">сегодня без плана</text>`;
    let d = '';
    vals.forEach((v, i) => { const t = lo + i; d += (i ? `H${x(t)}V${y(v)}` : `M${x(t)} ${y(v)}`); });
    g += `<path d="${d}" fill="none" stroke="var(--accent)" stroke-width="2.2"/>`;
    vals.forEach((v, i) => { g += `<circle cx="${x(lo + i)}" cy="${y(v)}" r="2.6" fill="var(--accent)"><title>${monthName(lo + i)}: ${fmt(v, m.d)} ${m.unit}</title></circle>`; });
    const yb = padT + plotH + 26;
    [...S.items].sort((a, c) => toIdx(a.start) - toIdx(c.start)).forEach((it, i) => {
      const a = Math.max(lo, toIdx(it.start)), e = Math.min(hi, toIdx(it.end)), col = KINDS[it.kind].color, yy = yb + i * rowH;
      g += `<rect x="${x(a)}" y="${yy}" width="${Math.max(3, x(e) - x(a))}" height="15" rx="3" fill="${col}" opacity=".9"><title>${nameOf(it)}: ${it.start} → ${it.end}</title></rect>`;
      if (it.kind !== 'closure' && it.kind !== 'bridge' && toIdx(it.end) < hi) g += `<rect x="${x(e)}" y="${yy + 6}" width="${x(hi) - x(e)}" height="3" rx="1.5" fill="${col}" opacity=".35"/>`; // после ввода: объект/магистраль остаются
      g += `<text x="${x(a) + 5}" y="${yy + 11}" font-size="10" fill="#fff" style="pointer-events:none">${esc(nameRaw(it).slice(0, Math.max(0, Math.floor((x(e) - x(a)) / 6))))}</text>`;
    });
    g += `<line x1="${x(S.t)}" x2="${x(S.t)}" y1="${padT}" y2="${H - 6}" stroke="var(--text)" stroke-width="1.5"/></svg>`;
    $('#plan-chart').innerHTML = g + '<p class="learn__legend"><span><i class="learn__bar" style="background:var(--accent)"></i>' + esc(m.label) + ' по месяцам</span><span>тонкая полоса после работ: объект или магистраль уже действует</span></p>';
    $('#plan-svg').addEventListener('click', (ev) => {
      const r = ev.currentTarget.getBoundingClientRect(), px = ((ev.clientX - r.left) / r.width) * W;
      setT(Math.round(lo + ((px - padL) / (W - padL - padR)) * (hi - lo)));
    });
  }

  function applyToMap() {
    const s = TB.state, { p } = paramsAt(S.t);
    s.params = M.normalize({ ...s.params, objects: p.objects, roads: p.roads, trees: p.trees, events: { ...s.params.events, closure: p.events.closure, bridge: p.events.bridge, widen: p.events.widen } });
    TB.screens.sim.render(true);
  }
  function setT(t) {
    S.t = Math.max(S.range[0], Math.min(S.range[1], t));
    renderTime();
    if (S.follow) applyToMap();
  }
  function stopPlay() { clearInterval(S.timer); S.timer = null; const b = $('#plan-play'); b.setAttribute('aria-pressed', 'false'); b.textContent = '▶ Показать по месяцам'; }

  function sample() {
    const n = (k) => fromIdx(T0 + k);
    const bridge = Object.keys(D.BRIDGES)[0], street = Object.keys(D.CLOSURES);
    S.items = [
      { id: 's1', kind: 'build', where: 'jal', type: 'jk', title: 'ЖК «Джал-Парк»', cap: 1400, spots: 150, floors: 16, note: 'два корпуса, школа не входит', start: n(1), end: n(15) },
      { id: 's5', kind: 'build', where: 'center', type: 'tc', title: 'ТЦ у площади', cap: 18000, spots: 900, floors: 4, note: 'подземный паркинг', start: n(5), end: n(17) },
      { id: 's2', kind: 'closure', where: street[1] || street[0], start: n(3), end: n(9) },
      { id: 's3', kind: 'bridge', where: bridge, start: n(6), end: n(12) },
      { id: 's4', kind: 'widen', where: street[0], start: n(10), end: n(22) },
      { id: 's7', kind: 'trees', where: '', street: 'chuy', sp: 'platan', n: 1200, route: '1200 платанов вдоль Чуя', start: n(4), end: n(5) },
      { id: 's6', kind: 'road', where: '', rkind: 'tunnel', lanes: 4, title: 'Тоннель Запад — Восток', route: 'от Запада до Учкуна через центр', pts: [[405, 476], [543, 468], [624, 486], [842, 495]], start: n(2), end: n(2 + M.P.road.months.tunnel) },
    ].filter(valid);
    save(); S.t = T0; refresh();
  }
  function refresh() { renderList(); renderTime(); }

  // ---------- старт ----------
  function init() {
    $('#plan-kind').addEventListener('change', fillWhere);
    $('#plan-sp').innerHTML = Object.entries(M.P.trees.species).map(([k, v]) => `<option value="${k}">${esc(v.name)}</option>`).join('');
    $('#plan-sp').value = 'platan';
    $('#plan-rkind').addEventListener('change', roadMonths);
    $('#plan-route-map').addEventListener('click', () => {
      const rs = TB.state.params.roads || [];
      if (!rs.length) return showErr('Сначала нарисуйте дорогу в боковой панели («Новая дорога» → «Нарисовать на карте»).');
      const r = rs[rs.length - 1];
      S.pickPts = r.pts; $('#plan-rkind').value = r.kind;
      if ([...$('#plan-lanes').options].some((o) => +o.value === r.lanes)) $('#plan-lanes').value = r.lanes;
      $('#plan-route').value = ''; $('#plan-route').placeholder = `трасса с карты: ${fmt(TB.roads.lengthKm(r.pts), 1)} км`;
      roadMonths(); showErr('');
    });
    $('#plan-type').addEventListener('change', typeChanged);
    ['plan-cap', 'plan-spots'].forEach((id) => $('#' + id).addEventListener('input', preview));
    $('#plan-type').innerHTML = ['jk', 'tc', 'park', 'fun'].filter((k) => D.OBJECT_TYPES[k]).map((k) => `<option value="${k}">${esc(D.OBJECT_TYPES[k].long)}</option>`).join('');
    $('#plan-type').value = 'jk';
    fillWhere();
    $('#plan-start').value = fromIdx(T0 + 1);
    $('#plan-end').value = fromIdx(T0 + 13);
    $('#plan-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const kind = $('#plan-kind').value, start = $('#plan-start').value, end = $('#plan-end').value;
      if (!start || !end) return showErr('Укажите месяц начала и конца.');
      if (toIdx(end) <= toIdx(start)) return showErr('Месяц окончания должен быть позже месяца начала.');
      const it = { id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), kind, where: kind === 'road' ? '' : $('#plan-where').value, start, end };
      if (kind === 'trees') {
        const text = $('#plan-twords').value.trim();
        it.sp = $('#plan-sp').value; it.n = Math.max(1, Math.round(+$('#plan-tn').value || 100)); it.route = ''; it.where = '';
        if (text) {
          const r = TB.trees.parse(text);
          if (r.error) return showErr(r.error);
          if (r.sp) it.sp = r.sp;
          if (r.n) it.n = Math.min(100000, r.n);
          if (r.at.d) it.where = r.at.d; else if (r.at.s) it.street = r.at.s; else it.pts = r.at.pts;
          it.route = text;
        } else {
          const [k, v] = $('#plan-where').value.split(':');
          if (k === 'd') it.where = v; else it.street = v;
        }
        if (!valid(it)) return showErr('Не получилось: проверьте породу и место посадки.');
        $('#plan-twords').value = '';
      } else if (kind === 'road') {
        const text = $('#plan-route').value.trim();
        it.rkind = $('#plan-rkind').value; it.lanes = +$('#plan-lanes').value; it.title = '';
        if (text) {
          const r = TB.roads.parse(text);
          if (r.error) return showErr(r.error);
          if (r.kind) it.rkind = r.kind;
          if (r.lanes) it.lanes = r.lanes;
          it.pts = r.pts; it.route = r.names.join(' → ');
        } else if (S.pickPts) { it.pts = S.pickPts; it.route = ''; }
        else return showErr('Опишите трассу словами («от Джала до Учкуна через центр») или нарисуйте дорогу в боковой панели и нажмите «Взять с карты».');
        if (end === S.autoEnd) it.end = fromIdx(toIdx(start) + M.P.road.months[it.rkind]); // срок не меняли руками: берём по типу из текста
        if (!valid(it)) return showErr('Трасса слишком короткая (меньше 500 м) или вне карты.');
        S.pickPts = null; $('#plan-route').value = ''; $('#plan-route').placeholder = 'от Джала до Учкуна через центр';
      } else if (kind === 'build') {
        it.type = $('#plan-type').value; it.cap = +$('#plan-cap').value;
        if (!(it.cap > 0)) return showErr('Укажите вместимость (семьи, площадь или посетители) больше нуля.');
        it.spots = $('#plan-spots').value === '' ? null : Math.max(0, +$('#plan-spots').value);
        it.floors = $('#plan-floors').value === '' ? null : +$('#plan-floors').value;
        it.title = $('#plan-title').value.trim(); it.note = $('#plan-note-in').value.trim();
      }
      showErr('');
      S.items.push(it); save(); refresh();
    });
    $('#plan-list').addEventListener('click', (e) => {
      const b = e.target.closest('[data-del]');
      if (!b) return;
      S.items = S.items.filter((it) => it.id !== b.dataset.del); save(); refresh();
    });
    $('#plan-sample').addEventListener('click', sample);
    $('#plan-clear').addEventListener('click', () => { S.items = []; save(); stopPlay(); refresh(); });
    $('#plan-t').addEventListener('input', (e) => setT(S.range[0] + +e.target.value));
    $('#plan-metric').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      S.metric = b.dataset.value;
      document.querySelectorAll('#plan-metric button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      renderTime();
    });
    $('#plan-follow').addEventListener('change', (e) => { S.follow = e.target.checked; if (S.follow) applyToMap(); });
    $('#plan-play').addEventListener('click', () => {
      if (S.timer) return stopPlay();
      if (!S.items.length) return;
      $('#plan-follow').checked = S.follow = true;
      const b = $('#plan-play'); b.setAttribute('aria-pressed', 'true'); b.textContent = '❚❚ Пауза';
      if (S.t >= S.range[1]) S.t = S.range[0] - 1;
      S.timer = setInterval(() => { if (S.t >= S.range[1]) return stopPlay(); setT(S.t + 1); }, 650);
    });
    // пересчёт при смене сезона, часа, автопарка и т.д. (сценарий меняется, план остаётся)
    let tm = null;
    document.addEventListener('tb:render', () => { clearTimeout(tm); tm = setTimeout(() => { if (S.items.length && !S.follow) renderTime(); }, 150); });
    refresh();
    pull();
    // вернулись на вкладку: план могли поменять с другого компьютера
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') pull(); });
  }
  TB.plan = { state: S, compose, init };
  // TB.state создаётся в app.js, который грузится позже: стартуем, когда страница готова
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(init, 0)); else window.addEventListener('load', init);
})();
