/* Twin Bishkek · четыре экрана: Старт, Симулятор, Сравнение, Методология. */
(function () {
  const TB = (window.TB = window.TB || {});
  const M = TB.model, D = TB.data;
  const ui = () => TB.ui;
  const st = () => TB.state;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => [...(r || document).querySelectorAll(s)];

  // ---------- Общие помощники ----------
  const baseCache = {};
  const baseOf = (season) => baseCache[season] || (baseCache[season] = M.simulate(M.defaults(season)));
  const seasonLabel = (s) => (s === 'winter' ? 'зима' : 'лето');
  const chipStyle = (cat) => `--chip-bg:var(--aqi-${cat});--chip-ink:var(--aqi-ink-${cat})`;
  const chipHtml = (cat) => `<span class="aqi-chip" style="${chipStyle(cat)}">${D.AQI_CATS[cat].short}</span>`;
  function setChip(el, cat) {
    el.textContent = D.AQI_CATS[cat].short;
    el.setAttribute('style', chipStyle(cat));
    el.title = D.AQI_CATS[cat].name;
  }
  function deltaInfo(d, dec, goodUp, eps) {
    const { signed } = ui();
    if (Math.abs(d) < eps) return { cls: 'delta delta--same', text: 'без изменений', aria: 'без изменений' };
    const good = goodUp ? d > 0 : d < 0;
    return { cls: 'delta ' + (good ? 'delta--better' : 'delta--worse'), text: (d > 0 ? '▲ ' : '▼ ') + signed(d, dec), aria: (good ? 'лучше: ' : 'хуже: ') + signed(d, dec) };
  }
  function setDelta(el, d, dec, goodUp, eps) {
    const i = deltaInfo(d, dec, goodUp, eps);
    el.className = i.cls; el.textContent = i.text; el.setAttribute('aria-label', i.aria);
  }
  const deltaHtml = (d, dec, goodUp, eps) => { const i = deltaInfo(d, dec, goodUp, eps); return `<span class="${i.cls}" aria-label="${i.aria}">${i.text}</span>`; };
  function matchPreset(p) {
    return D.PRESETS.find((pr) => M.sameParams(p, M.presetParams(pr.id))) || null;
  }
  function describe(p) {
    const { signed } = ui(), tags = [];
    if (p.season === 'winter') tags.push({ icon: 'i-snow', text: 'Зима' });
    if (p.hour !== null) tags.push({ icon: 'i-clock', text: 'Время ' + String(p.hour).padStart(2, '0') + ':00' });
    if (p.fleet) tags.push({ icon: 'i-car', text: 'Автопарк ' + signed(p.fleet, 0) + '%' });
    if (p.ev !== M.P.baseEv) tags.push({ icon: 'i-bolt', text: 'EV ' + p.ev + '%' });
    if (p.green) tags.push({ icon: 'i-leaf', text: 'Зелень ' + signed(p.green, 0) + '%' });
    p.objects.forEach((o) => tags.push({ icon: D.OBJECT_TYPES[o.t].icon, text: `${D.OBJECT_TYPES[o.t].name} ×${o.n}${stage(o)} · ${D.byId[o.d].name}` }));
    (p.roads || []).forEach((r) => tags.push({ icon: 'i-route', text: TB.roads ? TB.roads.label(r) : 'Новая дорога' }));
    (p.trees || []).forEach((t) => tags.push({ icon: 'i-leaf', text: TB.trees ? TB.trees.label(t) : 'Деревья' }));
    if (p.events.widen) tags.push({ icon: 'i-route', text: 'Новая магистраль: ' + D.CLOSURES[p.events.widen].name });
    if (p.events.closure) tags.push({ icon: 'i-barrier', text: 'Перекрытие: ' + D.CLOSURES[p.events.closure].name });
    if (p.events.match) tags.push({ icon: 'i-stadium', text: 'Матч · ' + D.STADIUMS[p.events.venue].name });
    if (p.events.bridge) tags.push({ icon: 'i-bridge', text: 'Мост ' + D.BRIDGES[p.events.bridge].name });
    return tags;
  }
  const tagsHtml = (p) => {
    const t = describe(p);
    return t.length ? t.map((x) => `<span class="tag"><svg class="ic"><use href="#${x.icon}"/></svg>${ui().esc(x.text)}</span>`).join('') : '<span class="tag">без изменений</span>';
  };
  function scenarioTitle(p) {
    if (M.sameParams(p, M.defaults(p.season))) return 'Сегодня';
    const pr = matchPreset(p);
    return pr ? pr.name : 'Свой сценарий';
  }

  // Слайдер с заливкой от отметки «сегодня» до значения
  function bindRange(field, onInput, baseFn, fmtVal) {
    const input = $('input[type="range"]', field), out = $('output', field), range = $('.range', field);
    const min = +input.min, max = +input.max;
    function paint() {
      const v = +input.value, b = (baseFn() - min) / (max - min), x = (v - min) / (max - min);
      range.style.setProperty('--b', b);
      range.style.setProperty('--lo', Math.min(b, x));
      range.style.setProperty('--hi', Math.max(b, x));
      out.textContent = fmtVal(v);
      out.dataset.changed = String(v !== baseFn());
    }
    input.addEventListener('input', () => { paint(); onInput(+input.value); });
    return { paint, set(v) { input.value = v; paint(); }, input };
  }
  function bindSeg(group, onPick) {
    group.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-value]');
      if (!b) return;
      onPick(b.dataset.value);
    });
    return (value) => $$('button[data-value]', group).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === value)));
  }
  const stage = (o) => (o.ph === 'build' ? ' · стройка' : ''); // подпись стадии у объекта
  const pctSigned = (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v) + '%';

  // =====================================================================
  // СИМУЛЯТОР
  // =====================================================================
  const Sim = {
    init() {
      const self = this;
      const onHover = (side) => (i, e) => self.hover(side, i, e);
      const onSelect = (id) => self.select(id === st().selected ? null : id);
      this.mapBase = TB.map.create($('#map-base'), { label: 'Карта Бишкека сегодня', onHover: onHover('base'), onSelect });
      this.mapSim = TB.map.create($('#map-sim'), { label: 'Карта Бишкека по сценарию', onHover: onHover('sim'), onSelect, note: false });
      this.panoBase = TB.pano.create($('#pano-base'), { verdict: true });
      this.panoSim = TB.pano.create($('#pano-sim'), { verdict: true });

      // Пресеты
      $('#presets').innerHTML = D.PRESETS.map((p) => `<button type="button" class="pill" data-preset="${p.id}" aria-pressed="false" title="${p.name}"><span class="pill__code">${p.code}</span>${p.name}</button>`).join('');
      $('#presets').addEventListener('click', (e) => {
        const b = e.target.closest('[data-preset]');
        if (!b) return;
        const pr = D.PRESETS.find((x) => x.id === b.dataset.preset);
        const s = st();
        if (b.getAttribute('aria-pressed') === 'true') s.params = M.defaults(s.params.season);
        else { s.params = M.presetParams(pr.id); if (pr.select) s.selected = pr.select; }
        self.render(true);
      });

      // Сезон
      this.paintSeason = bindSeg($('#ctl-season'), (v) => { st().params.season = v; self.render(true); });
      // Время суток: выключатель + ползунок часа
      this.rHour = bindRange($('[data-range="hour"]'), (v) => { st().params.hour = v; self.schedule(); }, () => 0, (v) => String(v).padStart(2, '0') + ':00');
      $('#ctl-hour-on').addEventListener('change', (e) => { st().params.hour = e.target.checked ? +$('#ctl-hour').value : null; self.render(true); });
      // Слайдеры
      this.rFleet = bindRange($('[data-range="fleet"]'), (v) => { st().params.fleet = v; self.schedule(); }, () => 0, pctSigned);
      this.rEv = bindRange($('[data-range="ev"]'), (v) => { st().params.ev = v; self.paintFleet(); self.schedule(); }, () => M.P.baseEv, (v) => v + '%');
      this.rGreen = bindRange($('[data-range="green"]'), (v) => { st().params.green = v; self.schedule(); }, () => 0, pctSigned);
      $('#fleet-glyphs').innerHTML = '<i class="car"></i>'.repeat(20);

      // Конструктор
      const sel = $('#ctl-district');
      sel.insertAdjacentHTML('beforeend', D.DISTRICTS.map((d) => `<option value="${d.id}">${d.name}</option>`).join(''));
      sel.addEventListener('change', () => self.select(sel.value || null));
      this.paintPhase = bindSeg($('#ctl-phase'), (v) => { st().phase = v; self.paintPhase(v); });
      this.paintType = bindSeg($('#ctl-type'), (v) => { st().type = v; self.paintType(v); self.paintAdd(); });
      $('#ctl-minus').addEventListener('click', () => { st().count = Math.max(1, st().count - 1); $('#ctl-count').textContent = st().count; });
      $('#ctl-plus').addEventListener('click', () => { st().count = Math.min(5, st().count + 1); $('#ctl-count').textContent = st().count; });
      $('#ctl-add').addEventListener('click', () => {
        const s = st();
        if (!s.selected) return;
        s.params.objects = s.params.objects.concat({ d: s.selected, t: s.type, n: s.count, ph: s.phase });
        self.render(true);
        ui().toast(`${D.OBJECT_TYPES[s.type].name} ×${s.count} → ${D.byId[s.selected].name}`);
      });
      $('#obj-chips').addEventListener('click', (e) => {
        const b = e.target.closest('[data-remove]');
        if (!b) return;
        const [d, t, ph] = b.dataset.remove.split(':');
        st().params.objects = st().params.objects.filter((o) => !(o.d === d && o.t === t && o.ph === ph));
        self.render(true);
      });

      // Стресс-тесты
      $('#ctl-widen-street').innerHTML = Object.entries(D.CLOSURES).map(([k, v]) => `<option value="${k}">${v.name}</option>`).join('');
      $('#ctl-widen').addEventListener('change', (e) => { st().params.events.widen = e.target.checked ? $('#ctl-widen-street').value : null; self.render(true); });
      $('#ctl-widen-street').addEventListener('change', (e) => { st().params.events.widen = e.target.value; self.render(true); });
      $('#ctl-closure-street').innerHTML = Object.entries(D.CLOSURES).map(([k, v]) => `<option value="${k}">${v.name}</option>`).join('');
      $('#ctl-bridge-river').innerHTML = Object.entries(D.BRIDGES).map(([k, v]) => `<option value="${k}">Мост ${v.name}</option>`).join('');
      $('#ctl-closure').addEventListener('change', (e) => { st().params.events.closure = e.target.checked ? $('#ctl-closure-street').value : null; self.render(true); });
      $('#ctl-closure-street').addEventListener('change', (e) => { st().params.events.closure = e.target.value; self.render(true); });
      $('#ctl-match-venue').innerHTML = D.VENUES.filter((v) => v.kind === 'stadium').map((v) => `<option value="${v.id}">${v.name} · ${Math.round(v.capacity / 1000)} тыс. мест</option>`).join('');
      $('#ctl-match').addEventListener('change', (e) => { st().params.events.match = e.target.checked; self.render(true); });
      $('#ctl-match-venue').addEventListener('change', (e) => { st().params.events.venue = e.target.value; self.render(true); });
      $('#ctl-bridge').addEventListener('change', (e) => { st().params.events.bridge = e.target.checked ? $('#ctl-bridge-river').value : null; self.render(true); });
      $('#ctl-bridge-river').addEventListener('change', (e) => { st().params.events.bridge = e.target.value; self.render(true); });
      $('#ctl-reset').addEventListener('click', () => {
        st().params = M.defaults(st().params.season);
        self.render(true);
        ui().toast('Вернулись к базовому состоянию');
      });

      // Стройка: показать «во время работ» или «после окончания»
      $('#ctl-stage').addEventListener('click', (e) => {
        const b = e.target.closest('[data-value]');
        if (!b || st().view === b.dataset.value) return;
        st().view = b.dataset.value;
        self.render(true);
        ui().toast(b.dataset.value === 'after' ? 'Показано после окончания работ' : 'Показано во время стройки');
      });
      // Карта: слои и разница
      this.paintLayer = bindSeg($('#ctl-layer'), (v) => { st().layer = v; self.render(false); });
      $('#ctl-delta').addEventListener('click', () => { st().delta = !st().delta; self.render(false); });
      // Водопад
      this.paintDay = bindSeg($('#ctl-daypart'), (v) => { st().params.hour = v === 'avg' ? null : +v; self.render(true); });
      this.paintWf = bindSeg($('#ctl-wf'), (v) => { st().wf = v; self.paintWf(v); self.drawWaterfall(); });
      if (typeof ResizeObserver !== 'undefined') {
        let w = 0;
        new ResizeObserver((en) => { const nw = Math.round(en[0].contentRect.width); if (nw !== w) { w = nw; self.drawWaterfall(); } }).observe($('#waterfall'));
        let dw = 0;
        new ResizeObserver((en) => { const nw = Math.round(en[0].contentRect.width); if (nw !== dw) { dw = nw; self.drawDay(true); } }).observe($('#dayline'));
      }
      // Сохранить в сравнение
      $('#btn-save').addEventListener('click', () => {
        const s = st();
        const p = M.normalize(s.params);
        if (M.sameParams(p, M.defaults(p.season))) { ui().toast('Сначала измените параметры — «Сегодня» уже есть в сравнении'); return; }
        const replaced = s.slots.length >= 3;
        if (replaced) s.slots.shift();
        s.slots.push({ name: scenarioTitle(p) === 'Свой сценарий' ? describe(p).slice(0, 2).map((t) => t.text).join(', ') : scenarioTitle(p), params: p });
        ui().saveSlots();
        ui().toast(replaced ? 'Сохранено. Самый старый слот заменён' : `Сохранено в сравнение · слот ${'АБВ'[s.slots.length - 1]}`);
      });
      // Карточка района
      $('#district-card').addEventListener('click', (e) => { if (e.target.closest('[data-unselect]')) self.select(null); });
      $('#district-card').addEventListener('change', (e) => { if (e.target.matches('[data-pick]')) self.select(e.target.value || null); });
    },

    show(first) {
      this.render(false);
      if (first || !this.risen) {
        this.risen = true;
        [this.mapBase.svg, this.mapSim.svg].forEach((svg) => {
          if (ui().reduceMotion()) return;
          svg.classList.add('is-rising');
          setTimeout(() => svg.classList.remove('is-rising'), 1400);
        });
      }
    },

    schedule() {
      if (this._pending) return;
      this._pending = true;
      const wait = Math.max(0, 90 - (performance.now() - (this._last || 0)));
      setTimeout(() => { this._pending = false; this._last = performance.now(); this.render(true); }, wait);
    },

    select(id) {
      st().selected = id;
      this.render(false);
    },

    render(fromUser) {
      const s = st();
      s.params = M.normalize(s.params);
      // «После окончания»: всё, что в сценарии строится, показываем построенным (сами параметры не меняем)
      const building = s.params.objects.some((o) => o.ph === 'build') || (s.params.roads || []).some((r) => r.ph === 'build');
      if (!building) s.view = 'now';
      const p = s.view === 'after' ? M.normalize({ ...s.params, objects: s.params.objects.map((o) => ({ ...o, ph: 'done' })), roads: (s.params.roads || []).map((r) => ({ ...r, ph: 'done' })) }) : s.params;
      $('#ctl-stage').hidden = !building;
      $$('#ctl-stage button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === (s.view || 'now'))));
      const base = baseOf(p.season), sim = M.simulate(p);
      this.base = base; this.sim = sim; this.viewParams = p;
      const isBase = M.sameParams(p, M.defaults(p.season));

      this.renderControls();
      this.renderHead(base, sim, isBase);
      this.renderKpis(base, sim);
      this.mapBase.update(base, { layer: s.layer });
      this.mapSim.update(sim, { base, layer: s.layer, delta: s.delta });
      this.mapBase.select(s.selected);
      this.mapSim.select(s.selected);
      this.paintLayer(s.layer);
      $('#ctl-delta').setAttribute('aria-pressed', String(s.delta));
      $('#legend-delta').hidden = !s.delta;
      $('#map-empty').hidden = !isBase;
      this.panoBase.set(base.city.aqi, !this._shown);
      this.panoSim.set(sim.city.aqi, !this._shown);
      this._shown = true;
      this.drawWaterfall();
      this.drawDay();
      this.renderDistrict(base, sim);
      document.dispatchEvent(new CustomEvent('tb:render', { detail: { base, sim, state: s, params: p } })); // live.js рисует сценарий на карте 2GIS
      $('#sim-status').textContent = `расчёт ${ui().fmt(sim.ms, 1)} мс · модель ${TB.backend ? TB.backend.label() : 'demo-0.3'} · демо-калибровка`;
      if (fromUser) ui().progress();
      ui().syncUrl();
    },

    paintFleet() {
      const ev = st().params.ev, n = Math.round((ev / 100) * 20), baseN = Math.round((M.P.baseEv / 100) * 20);
      $$('#fleet-glyphs .car').forEach((c, i) => c.classList.toggle('is-ev', i < n));
      $('#fleet-caption').innerHTML = `<b>${n} из 20</b> машин — электро · сегодня ${baseN} из 20`;
    },

    paintAdd() {
      const s = st(), btn = $('#ctl-add');
      btn.disabled = !s.selected;
      $('span', btn).textContent = s.selected ? `Добавить в ${D.byId[s.selected].name}` : 'Добавить';
      btn.title = s.selected ? '' : 'Сначала выберите микрорайон';
    },

    renderControls() {
      const s = st(), p = s.params;
      this.paintSeason(p.season);
      this.rFleet.set(p.fleet);
      this.rEv.set(p.ev);
      $('#ctl-hour-on').checked = p.hour !== null;
      $('#hour-field').hidden = p.hour === null;
      if (p.hour !== null) {
        this.rHour.set(p.hour);
        const tk = D.TIME.traffic[p.hour], ak = D.TIME.air[p.season][p.hour];
        $('#hour-hint').textContent = `Трафик ×${tk.toFixed(2).replace('.', ',')} · воздух ×${ak.toFixed(2).replace('.', ',')} к среднесуточному`;
      }
      this.rGreen.set(p.green);
      this.paintFleet();
      $('#ctl-district').value = s.selected || '';
      this.paintType(s.type);
      this.paintPhase(s.phase);
      $('#ctl-count').textContent = s.count;
      this.paintAdd();
      const key = JSON.stringify(p.objects);
      if (key !== this._chipsKey) {
        this._chipsKey = key;
        $('#obj-chips').innerHTML = p.objects.map((o) =>
          `<span class="chip"><svg class="ic"><use href="#${D.OBJECT_TYPES[o.t].icon}"/></svg>${D.OBJECT_TYPES[o.t].name} ×${o.n}${stage(o)} · ${D.byId[o.d].name}<button type="button" data-remove="${o.d}:${o.t}:${o.ph}" aria-label="Убрать ${D.OBJECT_TYPES[o.t].name} в районе ${D.byId[o.d].name}"><svg class="ic"><use href="#i-x"/></svg></button></span>`).join('');
      }
      $('#ctl-closure').checked = !!p.events.closure;
      $('#closure-pick').hidden = !p.events.closure;
      if (p.events.closure) $('#ctl-closure-street').value = p.events.closure;
      $('#ctl-widen').checked = !!p.events.widen;
      $('#widen-pick').hidden = !p.events.widen;
      if (p.events.widen) $('#ctl-widen-street').value = p.events.widen;
      $('#ctl-match').checked = p.events.match;
      $('#match-pick').hidden = !p.events.match;
      $('#ctl-match-venue').value = p.events.venue;
      $('#ctl-bridge').checked = !!p.events.bridge;
      $('#bridge-pick').hidden = !p.events.bridge;
      if (p.events.bridge) $('#ctl-bridge-river').value = p.events.bridge;
    },

    renderHead(base, sim, isBase) {
      const p = this.viewParams || st().params, pr = isBase ? null : matchPreset(st().params), { fmt, signed } = ui();
      const after = st().view === 'after' ? ' · после окончания работ' : '';
      $('#sim-kicker').textContent = (isBase ? `Базовое состояние · ${seasonLabel(p.season)}` : pr ? `Сценарий ${pr.code} · ${seasonLabel(p.season)}` : `Свой сценарий · ${seasonLabel(p.season)}`) + after;
      $('#sim-title').textContent = isBase ? 'Сегодня' : pr ? pr.name : 'Свой сценарий';
      $$('#presets [data-preset]').forEach((b) => b.setAttribute('aria-pressed', String(!!pr && b.dataset.preset === pr.id)));
      $('#map-base-title').textContent = `Бишкек сейчас · ${seasonLabel(p.season)}`;
      $('#map-sim-title').textContent = isBase ? 'измените параметры слева' : describe(p).map((t) => t.text).join(' · ');

      // Разницы считаем по округлённым значениям, чтобы текст совпадал с числами на карточках
      const dA = Math.round(sim.city.aqi) - Math.round(base.city.aqi), dT = sim.city.delay - base.city.delay, dC = sim.city.comfort - base.city.comfort;
      let html;
      if (isBase) html = `Так Бишкек выглядит ${p.season === 'winter' ? 'зимой' : 'летом'} без изменений. Выберите готовый сценарий справа или двигайте параметры слева.`;
      else {
        const part = (cond, good, text) => (cond ? `<b class="is-${good ? 'better' : 'worse'}">${text}</b>` : null);
        const parts = [
          Math.abs(dA) < 0.5 ? 'воздух без изменений' : 'воздух ' + part(true, dA < 0, `${dA > 0 ? 'хуже' : 'лучше'} на ${fmt(Math.abs(dA), 0)} AQI`),
          Math.abs(dT) < 0.05 ? 'дорога без изменений' : 'дорога ' + part(true, dT < 0, `${dT > 0 ? 'дольше' : 'быстрее'} на ${fmt(Math.abs(dT), 1)} мин`),
          Math.abs(dC) < 0.5 ? 'комфорт прежний' : 'комфорт ' + part(true, dC > 0, signed(dC, 0)),
        ];
        html = parts.join(', ');
        html = html.charAt(0).toUpperCase() + html.slice(1) + '.';
        if (sim.vis.key !== base.vis.key) html += ' ' + { clear: 'Горы снова видно.', haze: base.vis.key === 'clear' ? 'Горы уходят в дымку.' : 'Горы проступают из смога.', none: 'Гор больше не видно.' }[sim.vis.key];
        const sel = st().selected;
        if (sel) {
          const b = base.districts[sel], s = sim.districts[sel];
          const dd = s.delay - b.delay, dc = s.comfort - b.comfort;
          if (Math.abs(dd) >= 0.05 || Math.abs(dc) >= 0.5) {
            html += ` <span class="sim-head__local">${D.byId[sel].name}: задержка ${part(true, dd < 0, signed(dd, 1) + ' мин')}, комфорт ${part(true, dc > 0, signed(dc, 0))}` +
              (s.school > 1 ? `, школы ${part(true, false, Math.round(s.school * 100) + '%')}` : '') + '.</span>';
          }
        }
      }
      $('#sim-summary').innerHTML = html;
    },

    renderKpis(base, sim) {
      const { fmt, tween } = ui();
      const s = st(), sel = s.selected, dn = sel && D.byId[sel].name;
      const dB = sel && base.districts[sel], dS = sel && sim.districts[sel];
      const card = (k) => $(`.kpi[data-kpi="${k}"]`);
      const bars = (c, b, v, max) => {
        $('[data-bar-base]', c).style.setProperty('--w', Math.min(100, (b / max) * 100) + '%');
        $('[data-bar-sim]', c).style.setProperty('--w', Math.min(100, (v / max) * 100) + '%');
      };

      let c = card('aqi');
      tween($('[data-value]', c), sim.city.aqi, 0);
      setChip($('[data-chip]', c), sim.city.cat);
      $('[data-was]', c).textContent = 'было ' + fmt(base.city.aqi, 0);
      setDelta($('[data-delta]', c), Math.round(sim.city.aqi) - Math.round(base.city.aqi), 0, false, 0.5);
      $('[data-extra]', c).innerHTML = `PM2.5 <b>${fmt(sim.city.pm, 1)}</b> мкг/м³` + (sel ? ` · ${dn}: <b>${fmt(dS.aqi, 0)}</b>` : '');
      bars(c, base.city.aqi, sim.city.aqi, 300);

      c = card('delay');
      tween($('[data-value]', c), sim.city.delay, 1);
      $('[data-was]', c).textContent = 'было ' + fmt(base.city.delay, 1);
      setDelta($('[data-delta]', c), sim.city.delay - base.city.delay, 1, false, 0.05);
      $('[data-extra]', c).innerHTML = sel ? `${dn}: <b>${fmt(dS.delay, 1)}</b> мин, было ${fmt(dB.delay, 1)}` : `к поездке в ${M.P.T0} мин без пробок`;
      bars(c, base.city.delay, sim.city.delay, 40);

      c = card('speed');
      tween($('[data-value]', c), sim.city.speed, 0);
      $('[data-was]', c).textContent = 'было ' + fmt(base.city.speed, 0);
      setDelta($('[data-delta]', c), sim.city.speed - base.city.speed, 1, true, 0.05);
      $('[data-extra]', c).innerHTML = sel ? `${dn}: <b>${fmt(dS.speed, 0)}</b> км/ч, было ${fmt(dB.speed, 0)}` : `свободный поток — ${M.P.V0} км/ч`;
      bars(c, base.city.speed, sim.city.speed, 45);

      c = card('comfort');
      tween($('[data-value]', c), sim.city.comfort, 0);
      $('[data-was]', c).textContent = 'было ' + fmt(base.city.comfort, 0);
      setDelta($('[data-delta]', c), sim.city.comfort - base.city.comfort, 1, true, 0.1);
      const P = sim.city.parts, bar = $('[data-parts]', c);
      if (!bar.children.length) bar.innerHTML = '<i title="воздух"></i><i title="дорога"></i><i title="зелень"></i><i title="соцобъекты"></i>';
      ['air', 'road', 'green', 'social'].forEach((k, i) => { bar.children[i].style.flexBasis = P[k] + '%'; });
      $('[data-parts-legend]', c).textContent = `воздух ${fmt(P.air, 0)} · дорога ${fmt(P.road, 0)} · зелень ${fmt(P.green, 0)} · соцобъекты ${fmt(P.social, 0)}`;
    },

    // «Сутки по часам»: 24 прогона локальной моделью (быстро, без сервера); пересчитываются только когда меняется сценарий, а не час
    drawDay(force) {
      const p = this.viewParams || st().params, key = JSON.stringify({ ...p, hour: null });
      if (key !== this._dayKey) {
        this._dayKey = key;
        const sim = M.simulateLocal || M.simulate;
        this._day = Array.from({ length: 24 }, (_, h) => { const c = sim({ ...p, hour: h }).city; return { delay: c.delay, aqi: c.aqi, pm: c.pm }; });
      } else if (!force && this._dayHour === p.hour) return;
      this._dayHour = p.hour;
      this.paintDay(p.hour === null ? 'avg' : String(p.hour));
      const { fmt } = ui();
      TB.charts.dayline($('#dayline'), this._day, p.hour, (h) => { st().params.hour = h; this.render(true); });
      const arg = (k) => this._day.reduce((b, s, h) => (s[k] > this._day[b][k] ? h : b), 0), hh = (h) => String(h).padStart(2, '0') + ':00';
      const jam = arg('delay'), smog = arg('aqi');
      const far = Math.min(Math.abs(jam - smog), 24 - Math.abs(jam - smog)) >= 3;
      $('#day-foot').textContent = `Пик пробок: ${hh(jam)} (задержка ${fmt(this._day[jam].delay, 1)} мин) · пик смога: ${hh(smog)} (AQI ${fmt(this._day[smog].aqi, 0)})` +
        (far ? '. Пробки и смог пикуют в разное время.' : '.') + ' Пробки по описанию, без измерений; ритм воздуха по датчикам.';
    },

    drawWaterfall() {
      if (!this.sim) return;
      const p = this.viewParams || st().params, key = JSON.stringify(p);
      if (key !== this._wfKey) { this._wfKey = key; this._wf = M.decompose(p); }
      TB.charts.waterfall($('#waterfall'), this._wf, st().wf);
    },

    renderDistrict(base, sim) {
      const box = $('#district-card'), sel = st().selected, { fmt } = ui();
      if (!sel) {
        box.innerHTML = `<div class="district__empty"><div><svg class="ic"><use href="#i-hex"/></svg>
          <p class="overline">Район</p><p>Кликните район на карте —<br>здесь появятся его показатели</p>
          <div class="select"><select data-pick aria-label="Выбрать район"><option value="">Или выберите из списка</option>${D.DISTRICTS.map((d) => `<option value="${d.id}">${d.name}</option>`).join('')}</select><svg class="ic"><use href="#i-chevron"/></svg></div></div></div>`;
        return;
      }
      const b = base.districts[sel], s = sim.districts[sel], d = D.byId[sel];
      const meter = (label, vb, vs, max, unit, over) => {
        const w = Math.min(100, (vs / max) * 100), mark = Math.min(100, (over / max) * 100);
        return `<div class="meter"><div class="meter__head"><span>${label}</span><span>${unit(vb)} → <b>${unit(vs)}</b></span></div>
          <div class="meter__track"><i class="${vs > over ? 'is-over' : ''}" style="--w:${w}%"></i><b style="--mark:${mark}%"></b></div></div>`;
      };
      const pct = (v) => Math.round(v * 100) + '%';
      const objs = st().params.objects.filter((o) => o.d === sel);
      box.innerHTML = `
        <div class="district__head"><div><p class="overline">Район</p><h2 class="district__name">${d.name}</h2>
          <p class="district__meta">≈ ${fmt(s.pop, 0)} тыс. жителей${d.sub ? ' · ' + d.sub : ''} · демо</p></div>
          <button type="button" class="btn btn--ghost btn--icon" data-unselect aria-label="Снять выбор района"><svg class="ic"><use href="#i-x"/></svg></button></div>
        <div class="district__kpis">
          <div class="mini-kpi"><div class="mini-kpi__label">AQI</div><div class="mini-kpi__value num">${fmt(s.aqi, 0)}</div>${deltaHtml(Math.round(s.aqi) - Math.round(b.aqi), 0, false, 0.5)}</div>
          <div class="mini-kpi"><div class="mini-kpi__label">Задержка, мин</div><div class="mini-kpi__value num">${fmt(s.delay, 1)}</div>${deltaHtml(s.delay - b.delay, 1, false, 0.05)}</div>
          <div class="mini-kpi"><div class="mini-kpi__label">Комфорт</div><div class="mini-kpi__value num">${fmt(s.comfort, 0)}</div>${deltaHtml(s.comfort - b.comfort, 1, true, 0.1)}</div>
        </div>
        ${meter('Загрузка школ', b.school, s.school, 1.3, pct, 1)}
        ${meter('Загрузка поликлиник', b.clinic, s.clinic, 1.3, pct, 1)}
        ${meter('Зелень на жителя', b.green, s.green, 18, (v) => fmt(v, 1) + ' м²', M.P.greenNorm)}
        ${objs.length ? `<div class="district__objects">${objs.map((o) => `<span class="tag"><svg class="ic"><use href="#${D.OBJECT_TYPES[o.t].icon}"/></svg>${D.OBJECT_TYPES[o.t].name} ×${o.n}${stage(o)}</span>`).join('')}</div>` : ''}`;
    },

    hover(side, i, e) {
      if (i < 0 || !this.sim) { ui().hideTip(); return; }
      const G = M.grid(), h = G.hexes[i], d = D.byId[h.d], { fmt, signed } = ui();
      const r = side === 'base' ? this.base : this.sim;
      let html = `<div class="tooltip__title"><span>${d.name}</span>${chipHtml(r.cat[i])}</div>
        <div class="tooltip__row"><span>PM2.5</span><b>${fmt(r.pm[i], 1)} мкг/м³</b></div>
        <div class="tooltip__row"><span>AQI соты</span><b>${fmt(r.aqi[i], 0)}</b></div>`;
      if (side === 'sim') {
        const dd = this.sim.aqi[i] - this.base.aqi[i];
        html += `<div class="tooltip__row"><span>Δ к «Сегодня»</span><b>${Math.abs(dd) < 0.5 ? '0' : signed(dd, 0)}</b></div>`;
      }
      html += `<div class="tooltip__row"><span>Комфорт района</span><b>${fmt(r.districts[h.d].comfort, 0)}</b></div>`;
      ui().tip(html, e.clientX, e.clientY);
    },
  };

  // =====================================================================
  // СТАРТ
  // =====================================================================
  const Start = {
    init() {
      this.season = 'summer';
      this.fleet = 0;
      this.pano = TB.pano.create($('#hero-pano'), { variant: 'hero' });
      this.paintSeason = bindSeg($('#hero-season'), (v) => { this.season = v; this.paintSeason(v); this.update(); });
      this.range = bindRange($('[data-range="hero-fleet"]'), (v) => { this.fleet = v; this.update(); }, () => 0, pctSigned);
      this.range.paint();
      const hero = $('#hero');
      hero.addEventListener('mousemove', (e) => {
        if (ui().reduceMotion()) return;
        const r = hero.getBoundingClientRect();
        hero.style.setProperty('--mx', (((e.clientX - r.left) / r.width - 0.5) * 2).toFixed(3));
      });
      hero.addEventListener('mouseleave', () => hero.style.setProperty('--mx', 0));
    },
    update(instant) {
      const r = M.simulate({ ...M.defaults(this.season), fleet: this.fleet });
      const vis = this.pano.set(r.city.aqi, instant);
      ui().tween($('#hero-aqi'), r.city.aqi, 0);
      setChip($('#hero-cat'), r.city.cat);
      $('#hero-verdict').textContent = vis.verdict;
      $('#hero-vis').textContent = 'видимость ' + Math.round(vis.value * 100) + '%';
    },
    show(first) { this.update(first); },
  };

  // =====================================================================
  // СРАВНЕНИЕ
  // =====================================================================
  const Compare = {
    init() {
      $('#cmp-csv').addEventListener('click', () => this.csv());
      $('#cmp-print').addEventListener('click', () => window.print());
      $('#cmp-clear').addEventListener('click', () => { st().slots = []; ui().saveSlots(); this.render(); });
      $('#compare-body').addEventListener('click', (e) => {
        const rm = e.target.closest('[data-slot-remove]');
        if (rm) { st().slots.splice(+rm.dataset.slotRemove, 1); ui().saveSlots(); this.render(); return; }
        if (e.target.closest('[data-example]')) {
          const a = M.presetParams('uc01');
          st().slots = [{ name: 'UC-01 · EV 5%', params: a }, { name: 'UC-01 · EV 35%', params: M.normalize({ ...a, ev: 35 }) }];
          ui().saveSlots();
          this.render();
        }
      });
    },
    show() { this.render(); },
    rows() {
      const s = st();
      const cols = [{ name: 'Сегодня', params: M.defaults(s.slots[0] ? M.normalize(s.slots[0].params).season : 'summer'), base: true }]
        .concat(s.slots.map((x, i) => ({ name: x.name, params: M.normalize(x.params), letter: 'АБВ'[i], idx: i })));
      cols.forEach((c) => { c.res = M.simulate(c.params); c.ref = baseOf(c.params.season); });
      const maxSchool = (r) => Math.max(...Object.values(r.districts).map((d) => d.school));
      const metrics = [
        { key: 'aqi', label: 'AQI, город', get: (r) => r.city.aqi, dec: 0, lower: true },
        { key: 'pm', label: 'PM2.5, мкг/м³', get: (r) => r.city.pm, dec: 1, lower: true },
        { key: 'delay', label: 'Задержка в пути, мин', get: (r) => r.city.delay, dec: 1, lower: true },
        { key: 'speed', label: 'Средняя скорость, км/ч', get: (r) => r.city.speed, dec: 0, lower: false },
        { key: 'comfort', label: 'Urban Comfort, из 100', get: (r) => r.city.comfort, dec: 0, lower: false },
        { key: 'vis', label: 'Видимость гор, %', get: (r) => r.vis.value * 100, dec: 0, lower: false },
        { key: 'school', label: 'Макс. загрузка школ, %', get: (r) => maxSchool(r) * 100, dec: 0, lower: true },
      ];
      return { cols, metrics };
    },
    render() {
      const s = st(), body = $('#compare-body'), { fmt, signed, esc } = ui();
      ['#cmp-csv', '#cmp-print', '#cmp-clear'].forEach((id) => { $(id).disabled = !s.slots.length; });
      if (!s.slots.length) {
        body.innerHTML = `<div class="cmp-empty" data-enter><svg class="ic ic--lg"><use href="#i-layers"/></svg>
          <h2>Пока нечего сравнивать</h2><p>Соберите сценарий в симуляторе и нажмите «В сравнение». Можно сохранить до трёх сценариев.</p>
          <div class="hero__cta"><button type="button" class="btn btn--primary" data-example>Заполнить примером UC-01: EV 5% против 35%</button><a class="btn btn--secondary" href="#/sim">Открыть симулятор</a></div></div>`;
        return;
      }
      const { cols, metrics } = this.rows();
      const grid = 'grid-template-columns: repeat(4, minmax(0, 1fr))';
      let html = `<div class="cmp"><div class="cmp__cols" style="${grid}">`;
      cols.forEach((c, i) => {
        html += `<article class="cmp-col ${c.base ? 'cmp-col--base' : ''}">
          <header class="cmp-col__head"><span class="cmp-col__slot">${c.base ? '0' : c.letter}</span><span class="cmp-col__name" title="${esc(c.name)}">${esc(c.name)}</span>
          ${c.base ? '' : `<button type="button" class="btn btn--ghost btn--icon btn--sm" data-slot-remove="${c.idx}" aria-label="Убрать сценарий ${esc(c.name)}"><svg class="ic"><use href="#i-x"/></svg></button>`}</header>
          <div class="cmp-col__map" data-cmp-map="${i}"></div>
          <div class="cmp-col__pano" data-cmp-pano="${i}"></div>
          <div class="cmp-col__chips">${c.base ? `<span class="tag">${seasonLabel(c.params.season)}, без изменений</span>` : tagsHtml(c.params)}</div></article>`;
      });
      for (let k = s.slots.length; k < 3; k++) {
        html += `<article class="cmp-col cmp-col--empty"><span class="cmp-col__slot">${'АБВ'[k]}</span><p>Слот свободен.<br>Соберите сценарий и нажмите «В сравнение».</p><a class="btn btn--secondary btn--sm" href="#/sim">Открыть симулятор</a></article>`;
      }
      html += `</div><table class="cmp-table"><thead><tr><th>Показатель</th>${cols.map((c) => `<th>${c.base ? 'Сегодня' : c.letter + ' · ' + esc(c.name)}</th>`).join('')}</tr></thead><tbody>`;
      metrics.forEach((m) => {
        const vals = cols.map((c) => m.get(c.res));
        const best = m.lower ? Math.min(...vals) : Math.max(...vals);
        const tie = vals.filter((v) => Math.abs(v - best) < Math.pow(10, -m.dec) / 2).length === vals.length;
        html += `<tr><td>${m.label}</td>` + cols.map((c, i) => {
          const rnd = (x) => Number(x.toFixed(m.dec)), v = vals[i], d = rnd(v) - rnd(m.get(c.ref));
          const isBest = !tie && Math.abs(v - best) < Math.pow(10, -m.dec) / 2;
          return `<td class="${isBest ? 'is-best' : ''}"><span class="v num">${fmt(v, m.dec)}</span>${c.base ? '<span class="d">база</span>' : `<span class="d num">${Math.abs(d) < Math.pow(10, -m.dec) / 2 ? 'как сегодня' : signed(d, m.dec) + ' к сегодня'}</span>`}</td>`;
        }).join('') + '</tr>';
      });
      html += `</tbody></table><div class="cmp-conclusion"><svg class="ic"><use href="#i-info"/></svg><p>${this.conclusion(cols)}</p></div></div>`;
      body.innerHTML = html;
      cols.forEach((c, i) => {
        const mp = TB.map.create($(`[data-cmp-map="${i}"]`, body), { mini: true, label: 'Мини-карта сценария ' + c.name });
        mp.update(c.res, {});
        const pn = TB.pano.create($(`[data-cmp-pano="${i}"]`, body), { verdict: true });
        pn.set(c.res.city.aqi, true);
      });
      ui().enter($('[data-screen="compare"]'));
    },
    conclusion(cols) {
      const { fmt } = ui();
      const sc = cols.filter((c) => !c.base);
      const q = (c) => `«${ui().esc(c.name)}»`;
      if (sc.length === 1) {
        const c = sc[0], dA = Math.round(c.res.city.aqi) - Math.round(c.ref.city.aqi), dT = c.res.city.delay - c.ref.city.delay;
        return `${q(c)} относительно «Сегодня»: AQI ${dA >= 0 ? '+' : '−'}${fmt(Math.abs(dA), 0)}, задержка ${dT >= 0 ? '+' : '−'}${fmt(Math.abs(dT), 1)} мин. Добавьте второй сценарий, чтобы сравнить варианты между собой.`;
      }
      const byAqi = [...sc].sort((a, b) => a.res.city.aqi - b.res.city.aqi);
      const best = byAqi[0], worst = byAqi[byAqi.length - 1];
      const dA = Math.round(worst.res.city.aqi) - Math.round(best.res.city.aqi), dT = best.res.city.delay - worst.res.city.delay;
      const delayText = Math.abs(dT) < 0.1 ? `при той же задержке (${fmt(best.res.city.delay, 1)} мин)` : dT > 0 ? `но дорога дольше на ${fmt(dT, 1)} мин` : `и дорога быстрее на ${fmt(-dT, 1)} мин`;
      if (dA < 0.5) return `По воздуху сценарии почти не различаются (AQI около ${fmt(best.res.city.aqi, 0)}). Смотрите на задержку и комфорт.`;
      return `${q(best)} даёт на ${fmt(dA, 0)} AQI меньше, чем ${q(worst)}, ${delayText}.`;
    },
    csv() {
      const { cols, metrics } = this.rows();
      const cell = (v) => `"${String(v).replace(/"/g, '""')}"`;
      const lines = [['Показатель', ...cols.map((c) => (c.base ? 'Сегодня' : c.letter + ' ' + c.name))].map(cell).join(';')];
      metrics.forEach((m) => lines.push([m.label, ...cols.map((c) => m.get(c.res).toFixed(m.dec).replace('.', ','))].map(cell).join(';')));
      lines.push(cell('Данные: демо-калибровка прототипа Twin Bishkek'));
      const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'twin-bishkek-sravnenie.csv';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    },
  };

  // =====================================================================
  // МЕТОДОЛОГИЯ
  // =====================================================================
  const Method = {
    init() {
      $('#aqi-table-body').innerHTML = D.AQI_CATS.map((c, i) => `<tr><td>${c.range}</td><td>${c.pm}</td><td>${chipHtml(i)} <span style="margin-left:6px">${c.name}</span></td></tr>`).join('');
      const W = M.P.weights;
      this.w = { air: W.air * 100, road: W.road * 100, green: W.green * 100, social: W.social * 100 };
      const labels = { air: 'Воздух', road: 'Дорога', green: 'Зелень', social: 'Соцобъекты' };
      $('#weights').innerHTML = Object.keys(this.w).map((k) => `<div class="field" data-range="w-${k}">
        <div class="field__head"><label class="field__label" for="w-${k}">${labels[k]}</label><output class="field__value num" for="w-${k}"></output></div>
        <div class="range"><input id="w-${k}" type="range" min="0" max="60" step="1" value="${this.w[k]}"><span class="range__base"></span></div></div>`).join('');
      this.ranges = Object.keys(this.w).map((k) => {
        const def = this.w[k];
        const r = bindRange($(`[data-range="w-${k}"]`), (v) => { this.w[k] = v; this.update(); }, () => def, (v) => v);
        r.paint();
        return r;
      });
      const links = $$('.toc a');
      if (typeof IntersectionObserver !== 'undefined') {
        const io = new IntersectionObserver((entries) => {
          entries.forEach((en) => {
            if (en.isIntersecting) links.forEach((a) => a.classList.toggle('is-active', a.getAttribute('href') === '#' + en.target.id));
          });
        }, { rootMargin: '-30% 0px -60% 0px' });
        $$('.doc section[id]').forEach((sec) => io.observe(sec));
      }
    },
    show() { this.update(); },
    update() {
      const { fmt } = ui();
      const sum = Object.values(this.w).reduce((a, b) => a + b, 0) || 1;
      const w = { air: this.w.air / sum, road: this.w.road / sum, green: this.w.green / sum, social: this.w.social / sum };
      let p = M.normalize(st().params), note = 'текущий сценарий симулятора';
      if (M.sameParams(p, M.defaults(p.season))) { p = M.presetParams('uc05'); note = 'пример: UC-05 «Худший зимний день»'; }
      const b = M.comfortWith(baseOf(p.season), w).city, s = M.comfortWith(M.simulate(p), w).city;
      $('#weights-out').innerHTML = `<div><span class="overline">Сегодня</span><div class="big num">${fmt(b, 0)}</div></div>
        <div><span class="overline">Если…</span><div class="big num">${fmt(s, 0)}</div></div>
        <div>${deltaHtml(s - b, 1, true, 0.1)}</div>
        <small>${note} · доли весов: воздух ${Math.round(w.air * 100)}%, дорога ${Math.round(w.road * 100)}%, зелень ${Math.round(w.green * 100)}%, соцобъекты ${Math.round(w.social * 100)}%</small>`;
    },
  };

  TB.screens = { start: Start, sim: Sim, compare: Compare, method: Method };
})();
