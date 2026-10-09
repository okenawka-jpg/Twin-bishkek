/* Twin Bishkek · состояние, навигация, тема и общие помощники интерфейса. */
(function () {
  const TB = window.TB;
  const M = TB.model, D = TB.data;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => [...(r || document).querySelectorAll(s)];

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* приватный режим — не страшно */ } },
  };
  const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fmt = (v, d) => (Math.abs(v) < Math.pow(10, -d) / 2 ? 0 : v).toFixed(d).replace('.', ',').replace('-', '−');
  const signed = (v, d) => (v > 0 ? '+' : v < 0 ? '−' : '') + fmt(Math.abs(v), d);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  // ---------- Состояние ----------
  const state = {
    route: 'start',
    params: M.defaults('summer'),
    selected: null,
    layer: 'both',
    delta: false,
    wf: 'aqi',
    type: 'jk',
    phase: 'done',
    view: 'now', // стройка на картах: 'now' — во время работ, 'after' — после окончания
    count: 1,
    slots: store.get('tb-slots', []).filter((s) => s && s.params),
  };

  // ---------- URL сценария: #/sim?s=w&f=20&e=35&g=-10&o=jal.jk.3&c=chuy&m=1&b=alaarcha&d=jal ----------
  function encodeHash() {
    const p = state.params, q = [];
    if (p.season === 'winter') q.push('s=w');
    if (p.hour !== null) q.push('h=' + p.hour);
    if (p.fleet) q.push('f=' + p.fleet);
    if (p.ev !== M.P.baseEv) q.push('e=' + p.ev);
    if (p.green) q.push('g=' + p.green);
    if (p.objects.length) q.push('o=' + p.objects.map((o) => `${o.d}.${o.t}.${o.n}${o.ph === 'build' ? '.b' : ''}`).join(','));
    if (p.trees && p.trees.length) q.push('t=' + p.trees.map((t) => `${t.sp}.${t.n}.${t.age}.${t.d ? 'd:' + t.d : t.s ? 's:' + t.s : 'p:' + t.pts.map((x) => x.join('_')).join('~')}`).join(','));
    if (p.roads && p.roads.length) q.push('r=' + p.roads.map((r) => `${r.kind[0]}.${r.lanes}.${r.ph === 'build' ? 'b' : 'd'}.${r.pts.map((x) => x.join('_')).join('~')}`).join(','));
    if (p.events.closure) q.push('c=' + p.events.closure);
    if (p.events.match) q.push('m=1');
    if (p.events.venue !== 'omurzakov') q.push('v=' + p.events.venue);
    if (p.events.bridge) q.push('b=' + p.events.bridge);
    if (p.events.widen) q.push('w=' + p.events.widen);
    if (state.selected) q.push('d=' + state.selected);
    if (state.layer !== 'both') q.push('l=' + state.layer);
    if (state.delta) q.push('x=1');
    return '#/sim' + (q.length ? '?' + q.join('&') : '');
  }
  function decodeQuery(query) {
    const q = Object.fromEntries((query || '').split('&').filter(Boolean).map((kv) => kv.split('=').map(decodeURIComponent)));
    if (!Object.keys(q).length) return false;
    state.params = M.normalize({
      season: q.s === 'w' ? 'winter' : 'summer',
      hour: q.h !== undefined ? q.h : null,
      fleet: q.f, ev: q.e !== undefined ? q.e : M.P.baseEv, green: q.g,
      objects: (q.o || '').split(',').filter(Boolean).map((s) => { const [d, t, n, ph] = s.split('.'); return { d, t, n: +n, ph: ph === 'b' ? 'build' : 'done' }; }),
      trees: (q.t || '').split(',').filter(Boolean).map((s) => {
        const [sp, n, age, at] = s.split('.'), [k, v] = (at || '').split(/:(.*)/);
        return { sp, n: +n, age: +age, d: k === 'd' ? v : undefined, s: k === 's' ? v : undefined, pts: k === 'p' ? (v || '').split('~').map((xy) => xy.split('_').map(Number)) : undefined };
      }),
      roads: (q.r || '').split(',').filter(Boolean).map((s) => {
        const [k, lanes, ph, pts] = s.split('.');
        return { kind: { t: 'tunnel', e: 'elevated', s: 'surface' }[k], lanes: +lanes, ph: ph === 'b' ? 'build' : 'done', pts: (pts || '').split('~').map((xy) => xy.split('_').map(Number)) };
      }),
      events: { closure: q.c || null, match: q.m === '1', bridge: q.b || null, venue: q.v, widen: q.w || null },
    });
    state.selected = D.byId[q.d] ? q.d : null;
    state.layer = ['air', 'traffic', 'both'].includes(q.l) ? q.l : 'both';
    state.delta = q.x === '1';
    return true;
  }
  let urlTimer = 0;
  function syncUrl() {
    if (state.route !== 'sim') return;
    clearTimeout(urlTimer);
    urlTimer = setTimeout(() => { try { history.replaceState(null, '', encodeHash()); } catch (e) { /* file:// в некоторых браузерах */ } }, 250);
  }

  // ---------- Помощники интерфейса ----------
  const ui = {
    $, $$, fmt, signed, esc, store, reduceMotion,
    toast(msg) {
      const t = $('#toast');
      t.innerHTML = '<svg class="ic"><use href="#i-check"/></svg><span>' + esc(msg) + '</span>';
      t.classList.add('is-on');
      clearTimeout(t._h);
      t._h = setTimeout(() => t.classList.remove('is-on'), 2600);
    },
    tip(html, x, y) {
      const t = $('#tooltip');
      t.innerHTML = html;
      t.hidden = false;
      const w = t.offsetWidth, h = t.offsetHeight;
      t.style.left = Math.min(window.innerWidth - w - 12, x + 16) + 'px';
      t.style.top = Math.min(window.innerHeight - h - 12, y + 16) + 'px';
    },
    hideTip() { $('#tooltip').hidden = true; },
    progress() {
      const p = $('#progress');
      p.classList.remove('is-running');
      void p.offsetWidth;
      p.classList.add('is-running');
    },
    tween(el, to, dec) {
      const from = parseFloat(el.dataset.v);
      el.dataset.v = to;
      cancelAnimationFrame(el._raf);
      if (!Number.isFinite(from) || reduceMotion()) { el.textContent = fmt(to, dec); return; }
      const t0 = performance.now();
      const step = (t) => {
        const k = Math.min(1, (t - t0) / 420), e = 1 - Math.pow(1 - k, 3);
        el.textContent = fmt(from + (to - from) * e, dec);
        if (k < 1) el._raf = requestAnimationFrame(step);
      };
      el._raf = requestAnimationFrame(step);
    },
    enter(node) {
      if (!node || reduceMotion()) return;
      node.classList.remove('is-entering');
      void node.offsetWidth;
      node.classList.add('is-entering');
      clearTimeout(node._enter);
      node._enter = setTimeout(() => node.classList.remove('is-entering'), 1200);
    },
    saveSlots() { store.set('tb-slots', state.slots); ui.updateNavCount(); },
    updateNavCount() {
      const c = $('#nav-count');
      c.hidden = !state.slots.length;
      c.textContent = state.slots.length;
    },
    syncUrl,
  };

  // ---------- Тема ----------
  function effectiveTheme() {
    const set = document.documentElement.dataset.theme;
    if (set) return set;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  $('#theme-toggle').addEventListener('click', () => {
    const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('tb-theme', next); } catch (e) { /* приватный режим — тема не запомнится */ }
    ui.toast(next === 'dark' ? 'Ночная тема' : 'Дневная тема');
  });

  // ---------- Навигация ----------
  const ROUTES = { '': 'start', '/': 'start', '/sim': 'sim', '/compare': 'compare', '/method': 'method' };
  function onHash(first) {
    const h = location.hash || '#/';
    if (!h.startsWith('#/')) return; // якорь внутри страницы
    const [path, query] = h.slice(1).split('?');
    const route = ROUTES[path] || 'start';
    if (route === 'sim' && query) decodeQuery(query);
    const changed = route !== state.route || first === true;
    state.route = route;
    $('#app').dataset.route = route;
    $$('[data-screen]').forEach((s) => { s.hidden = s.dataset.screen !== route; });
    $$('.nav a').forEach((a) => { if (a.dataset.route === route) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    ui.hideTip();
    if (changed) {
      window.scrollTo(0, 0);
      const screen = $(`[data-screen="${route}"]`);
      TB.screens[route].show(first === true);
      ui.enter(screen);
      if (route === 'sim') ui.enter($('#sidebar'));
      document.title = { start: 'Twin Bishkek', sim: 'Симулятор · Twin Bishkek', compare: 'Сравнение · Twin Bishkek', method: 'Методология · Twin Bishkek' }[route];
    }
  }
  // Якоря внутри экранов не должны ломать маршрут
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href^="#"]');
    if (!a) return;
    const href = a.getAttribute('href');
    if (href.startsWith('#/')) return;
    const target = document.getElementById(href.slice(1));
    if (target) { e.preventDefault(); target.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' }); }
  });
  window.addEventListener('hashchange', () => onHash(false));

  TB.state = state;
  TB.ui = ui;

  // ---------- Старт ----------
  M.init();
  Object.values(TB.screens).forEach((s) => s.init && s.init());
  ui.updateNavCount();
  onHash(true);

  if (/selftest/.test(location.search)) {
    const res = TB.selftest.run();
    const box = $('#selftest');
    const ok = res.filter((r) => r.pass).length;
    box.innerHTML = `<h2>Самопроверка модели: ${ok} из ${res.length}</h2><ul>` +
      res.map((r) => `<li><span class="id">${r.id}</span><span class="${r.pass ? 'ok' : 'fail'}">${r.pass ? 'PASS' : 'FAIL'}</span><span>${esc(r.name)}</span><small>${esc(r.detail)}</small></li>`).join('') + '</ul>';
    box.hidden = false;
    console.table(res.map((r) => ({ id: r.id, pass: r.pass, name: r.name, detail: r.detail })));
  }
})();
