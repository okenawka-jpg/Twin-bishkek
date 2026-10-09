/* Twin Bishkek · график «Разложение эффекта» (водопад) на SVG, без библиотек.
   Показывает суперпозицию из п.2 ТЗ: какой шаг сценария сколько добавил к итогу. */
(function () {
  const TB = (window.TB = window.TB || {});
  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs, parent) => {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    parent && parent.appendChild(n);
    return n;
  };
  const METRIC = {
    aqi: { goodUp: false, dec: 1, totalDec: 0, minSpan: 6, unit: 'AQI' },
    delay: { goodUp: false, dec: 1, totalDec: 1, minSpan: 3, unit: 'мин' },
    comfort: { goodUp: true, dec: 1, totalDec: 0, minSpan: 4, unit: 'из 100' },
  };
  const fmt = (v, d) => v.toFixed(d).replace('.', ',').replace('-', '−');
  const signed = (v, d) => (v > 0 ? '+' : v < 0 ? '−' : '±') + fmt(Math.abs(v), d);

  function waterfall(container, steps, metric) {
    const m = METRIC[metric];
    const W = Math.max(360, Math.floor(container.clientWidth)), H = 230;
    const pad = { l: 40, r: 8, t: 26, b: 44 };
    const items = [{ label: steps[0].label, total: true, to: steps[0].value[metric], kind: 'base' }];
    let cum = steps[0].value[metric];
    steps.slice(1).forEach((s) => {
      const d = s.delta[metric];
      items.push({ label: s.label, from: cum, to: cum + d, d });
      cum += d;
    });
    items.push({ label: 'Если…', total: true, to: cum, kind: 'final' });

    const vals = items.flatMap((i) => (i.total ? [i.to] : [i.from, i.to]));
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const span = Math.max(hi - lo, m.minSpan);
    const yMin = lo - span * 0.75, yMax = hi + span * 0.3;
    const y = (v) => pad.t + ((yMax - v) / (yMax - yMin)) * (H - pad.t - pad.b);
    const n = items.length, slot = (W - pad.l - pad.r) / n, bw = Math.min(54, slot * 0.58);
    const cx = (i) => pad.l + slot * i + slot / 2;

    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'wf', role: 'img', 'aria-label': 'Разложение эффекта по шагам сценария' });
    // Сетка
    const step = niceStep((yMax - yMin) / 4);
    for (let v = Math.ceil(yMin / step) * step; v <= yMax; v += step) {
      el('line', { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), class: 'wf-grid' }, svg);
      const t = el('text', { x: pad.l - 8, y: y(v) + 4, class: 'wf-axis', 'text-anchor': 'end' }, svg);
      t.textContent = fmt(v, step < 1 ? 1 : 0);
    }
    items.forEach((it, i) => {
      const x = cx(i) - bw / 2;
      let top, bottom, cls;
      if (it.total) {
        top = y(it.to); bottom = H - pad.b; cls = it.kind === 'final' ? 'wf-final' : 'wf-base';
      } else {
        top = y(Math.max(it.from, it.to)); bottom = y(Math.min(it.from, it.to));
        const good = m.goodUp ? it.d > 0 : it.d < 0;
        cls = Math.abs(it.d) < 0.05 ? 'wf-zero' : good ? 'wf-better' : 'wf-worse';
      }
      const h = Math.max(it.total || Math.abs(it.d) >= 0.05 ? 2 : 1.5, bottom - top);
      el('rect', { x, y: Math.min(top, bottom - h), width: bw, height: h, rx: 3, class: 'wf-bar ' + cls }, svg);
      if (it.total) {
        // «Обрезанная» ось у столбцов-итогов
        el('path', { d: `M${x - 2} ${H - pad.b - 7}l${bw / 4 + 1} -4l${bw / 4} 4l${bw / 4} -4l${bw / 4 + 1} 4`, class: 'wf-break' }, svg);
      }
      if (i < n - 1) {
        const level = y(it.to);
        el('line', { x1: x + bw, x2: cx(i + 1) - bw / 2, y1: level, y2: level, class: 'wf-link' }, svg);
      }
      const val = el('text', { x: cx(i), y: Math.min(top, bottom - h) - 8, class: 'wf-val' + (it.total ? ' wf-val--total' : ''), 'text-anchor': 'middle' }, svg);
      val.textContent = it.total ? fmt(it.to, m.totalDec) : Math.abs(it.d) < 0.05 ? '0' : signed(it.d, m.dec);
      const lab = el('text', { x: cx(i), y: H - pad.b + 20, class: 'wf-label', 'text-anchor': 'middle' }, svg);
      lab.textContent = it.label;
    });
    container.replaceChildren(svg);
  }
  function niceStep(raw) {
    const p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
    return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
  }

  // «Сутки по часам»: две линии, пробки (задержка, мин, левая шкала) и смог (AQI, правая шкала). Нажатие на час выбирает его.
  function dayline(container, series, hour, onPick) {
    const W = Math.max(420, Math.floor(container.clientWidth)), H = 230;
    const pad = { l: 44, r: 44, t: 30, b: 30 };
    const scale = (vals, minSpan, floorZero) => {
      let lo = Math.min(...vals), hi = Math.max(...vals);
      const span = Math.max(hi - lo, minSpan);
      lo = floorZero ? 0 : lo - span * 0.25; hi = hi + span * 0.2;
      return { lo, hi };
    };
    const delays = series.map((s) => s.delay), aqis = series.map((s) => s.aqi);
    const sd = scale(delays, 5, true), sa = scale(aqis, 12, false);
    const x = (h) => pad.l + ((W - pad.l - pad.r) * (h + 0.5)) / 24;
    const yy = (v, s) => pad.t + ((s.hi - v) / (s.hi - s.lo)) * (H - pad.t - pad.b);
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'day', role: 'img', 'aria-label': 'Пробки и смог по часам суток' }, null);
    // сетка и оси
    const stepD = niceStep((sd.hi - sd.lo) / 4);
    for (let v = 0; v <= sd.hi; v += stepD) {
      el('line', { x1: pad.l, x2: W - pad.r, y1: yy(v, sd), y2: yy(v, sd), class: 'wf-grid' }, svg);
      el('text', { x: pad.l - 8, y: yy(v, sd) + 4, class: 'wf-axis day-axis--traffic', 'text-anchor': 'end' }, svg).textContent = fmt(v, 0);
    }
    const stepA = niceStep((sa.hi - sa.lo) / 4);
    for (let v = Math.ceil(sa.lo / stepA) * stepA; v <= sa.hi; v += stepA) {
      el('text', { x: W - pad.r + 8, y: yy(v, sa) + 4, class: 'wf-axis day-axis--smog', 'text-anchor': 'start' }, svg).textContent = fmt(v, 0);
    }
    for (let h = 0; h < 24; h += 3) {
      el('text', { x: x(h), y: H - 8, class: 'wf-label', 'text-anchor': 'middle' }, svg).textContent = String(h).padStart(2, '0');
    }
    // подписи шкал
    el('text', { x: pad.l - 8, y: 14, class: 'day-unit day-axis--traffic', 'text-anchor': 'end' }, svg).textContent = 'мин';
    el('text', { x: W - pad.r + 8, y: 14, class: 'day-unit day-axis--smog', 'text-anchor': 'start' }, svg).textContent = 'AQI';
    const line = (key, s, cls) => el('polyline', { points: series.map((v, h) => `${x(h).toFixed(1)},${yy(v[key], s).toFixed(1)}`).join(' '), class: 'day-line ' + cls }, svg);
    line('delay', sd, 'day-line--traffic');
    line('aqi', sa, 'day-line--smog');
    // выбранный час
    if (hour !== null && series[hour]) {
      el('line', { x1: x(hour), x2: x(hour), y1: pad.t - 6, y2: H - pad.b, class: 'day-sel' }, svg);
      el('circle', { cx: x(hour), cy: yy(series[hour].delay, sd), r: 5, class: 'day-dot day-dot--traffic' }, svg);
      el('circle', { cx: x(hour), cy: yy(series[hour].aqi, sa), r: 5, class: 'day-dot day-dot--smog' }, svg);
    }
    // зоны нажатия по часам
    series.forEach((v, h) => {
      const hit = el('rect', { x: x(h) - (W - pad.l - pad.r) / 48, y: pad.t - 6, width: (W - pad.l - pad.r) / 24, height: H - pad.t - pad.b + 6, class: 'day-hit', tabindex: 0, role: 'button',
        'aria-label': `${String(h).padStart(2, '0')}:00, задержка ${fmt(v.delay, 1)} мин, AQI ${fmt(v.aqi, 0)}` }, svg);
      el('title', {}, hit).textContent = `${String(h).padStart(2, '0')}:00 · задержка ${fmt(v.delay, 1)} мин · AQI ${fmt(v.aqi, 0)}`;
      hit.addEventListener('click', () => onPick(h));
      hit.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(h); } });
    });
    container.replaceChildren(svg);
  }

  TB.charts = { waterfall, dayline, fmt, signed };
})();
