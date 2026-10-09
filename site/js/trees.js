/* Twin Bishkek · посадка деревьев: какая порода, сколько, где (район, вдоль улицы, линия на карте или словами)
   и сколько лет прошло. Модель — P.trees в model.js / TREES в simulator.py; здесь интерфейс и разбор текста. */
(function () {
  const TB = (window.TB = window.TB || {});
  const D = TB.data, M = TB.model;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
  const fmt = (v, d) => Number(v).toFixed(d).replace('.', ',');
  const nf = (v) => Math.round(v).toLocaleString('ru-RU');
  const SP = () => M.P.trees.species;
  const years = (n) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'год' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'года' : 'лет'}`;

  // улицы, вдоль которых можно сажать: подписанные главные улицы + улицы перекрытий
  const STREETS = () => {
    const m = new Map();
    D.STREET_LABELS.forEach((s) => m.set(s.id, s.name));
    Object.entries(D.CLOSURES).forEach(([id, v]) => m.set(id, v.name));
    return [...m];
  };
  const placeName = (t) => (t.d ? `в районе ${D.byId[t.d].name}` : t.s ? `вдоль: ${(STREETS().find(([id]) => id === t.s) || [0, t.s])[1]}` : `по линии ${fmt(TB.roads.lengthKm(t.pts), 1)} км`);
  const label = (t) => `${SP()[t.sp].name} ×${nf(t.n)} · ${placeName(t)} · ${t.age ? 'через ' + years(t.age) : 'посадили'}`;

  // ---------- разбор текста ----------
  // [начало слова, порода, точное совпадение]: «ель/ели/елей» только целым словом, остальное — по началу («платанов», «липы»)
  const SP_WORDS = [['платан', 'platan'], ['чинар', 'platan'], ['карагач', 'karagach'], ['вяз', 'karagach'], ['лип', 'lipa'], ['дуб', 'dub'], ['топол', 'topol'],
    ['клен', 'klen'], ['гледич', 'gledichia'], ['сосн', 'sosna'], ['елк', 'el'], ['ель', 'el', true], ['ели', 'el', true], ['елей', 'el', true]];
  function parse(text) {
    const t = text.toLowerCase().replace(/ё/g, 'е'), toks = TB.roads.words(t), res = {};
    for (const w of toks) { const hit = SP_WORDS.find(([s, , exact]) => (exact ? w === s : w.startsWith(s))); if (hit) { res.sp = hit[1]; break; } }
    const age = t.match(/через\s+(\d+)\s*(год|лет)/) || t.match(/(\d+)\s*(год|лет)\s+(спустя|назад)/);
    if (age) res.age = +age[1];
    // количество: число не из названия района (Восток-5, Юг-2) и не годы; «1 000» и «тыс» тоже понимаем
    const cleaned = t.replace(/через\s+\d+\s*(год|лет)\w*/g, ' ').replace(/\d+\s*(год|лет)\w*\s+(спустя|назад)/g, ' ').replace(/-\s*\d+/g, ' ');
    const nm = cleaned.match(/(\d[\d\s]*\d|\d)\s*(тыс)?/);
    if (nm) res.n = +nm[1].replace(/\s/g, '') * (nm[2] ? 1000 : 1);
    const r = TB.roads.parse(text);
    const pl = r.places || [];
    if (r.street && pl.length < 2) res.at = { s: r.street.id };
    else if (pl.length >= 2 && r.pts) res.at = { pts: r.pts };
    else if (pl.length === 1) {
      const p = pl[0];
      res.at = p.kind === 'district' ? { d: p.id } : { d: D.DISTRICTS.reduce((m, d) => (Math.hypot(d.x - p.x, d.y - p.y) < Math.hypot(m.x - p.x, m.y - p.y) ? d : m)).id };
    }
    if (!res.at) res.error = 'Не понял, где сажать. Например: «300 платанов вдоль Чуя», «1000 карагачей в Джале», «липы от Джала до центра».';
    return res;
  }

  // ---------- интерфейс ----------
  const ui = { where: 'd' };
  const st = () => TB.state, sim = () => TB.screens.sim;
  const hint = (msg) => { $('#tree-hint').textContent = msg || ''; };
  function spHint() {
    const sp = $('#tree-sp').value, S = SP()[sp];
    $('#tree-sp-hint').textContent = `Взрослая крона ~${S.crown} м, вырастет (80% кроны) примерно за ${years(Math.round(M.grownAge(sp)))}; ${S.ever ? 'хвойное: работает и зимой' : 'лиственное: тень летом, зимой без листьев'}.`;
  }
  function add(t, how) {
    const p = st().params;
    if ((p.trees || []).length >= M.P.trees.max) { hint(`Не больше ${M.P.trees.max} посадок в сценарии: уберите одну.`); return false; }
    const n = M.normalize({ ...p, trees: [...(p.trees || []), t] });
    if (n.trees.length === (p.trees || []).length) { hint('Не получилось: линия посадки слишком короткая или вне карты.'); return false; }
    st().params = n;
    sim().render(true);
    const nt = n.trees[n.trees.length - 1];
    hint(`${how}: ${label(nt)}.`);
    TB.ui.toast('Посадка: ' + label(nt));
    return true;
  }
  const current = () => ({ sp: $('#tree-sp').value, n: +$('#tree-n').value || 100, age: +$('#tree-age').value });
  function paintChips() {
    const ts = st().params.trees || [];
    $('#tree-chips').innerHTML = ts.map((t, i) => `<span class="chip"><svg class="ic"><use href="#i-leaf"/></svg>${TB.ui.esc(label(t))}<button type="button" data-tree-del="${i}" aria-label="Убрать посадку"><svg class="ic"><use href="#i-x"/></svg></button></span>`).join('');
    const age = ts.length ? ts[0].age : +$('#tree-age').value;
    $('#tree-age').value = age;
    paintAge();
  }
  function paintAge() {
    const a = +$('#tree-age').value, f = $('[data-range="treeage"]');
    $('output', f).textContent = a ? years(a) : 'посадили';
    $('.range', f).style.setProperty('--b', 0); $('.range', f).style.setProperty('--lo', 0); $('.range', f).style.setProperty('--hi', a / 30);
  }
  const paintWhere = () => {
    $$('#tree-where button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === ui.where)));
    $('#tree-d-wrap').hidden = ui.where !== 'd';
    $('#tree-s-wrap').hidden = ui.where !== 's';
    $('#tree-add').lastChild.textContent = ui.where === 'p' ? 'Нарисовать линию посадки' : 'Посадить';
  };

  function init() {
    if (!$('#tree-sp') || !TB.screens || !TB.screens.sim.mapSim) return;
    $('#tree-sp').innerHTML = Object.entries(SP()).map(([k, v]) => `<option value="${k}">${v.name}</option>`).join('');
    $('#tree-sp').value = 'karagach';
    $('#tree-d').innerHTML = D.DISTRICTS.map((d) => `<option value="${d.id}">${d.name}</option>`).join('');
    $('#tree-s').innerHTML = STREETS().map(([id, name]) => `<option value="${id}">${name}</option>`).join('');
    spHint(); paintWhere(); paintAge();
    $('#tree-sp').addEventListener('change', spHint);
    $('#tree-where').addEventListener('click', (e) => { const b = e.target.closest('[data-value]'); if (b) { ui.where = b.dataset.value; paintWhere(); } });
    $('#tree-add').addEventListener('click', () => {
      const t = current();
      if (ui.where === 'd') add({ ...t, d: $('#tree-d').value || st().selected }, 'Посажено');
      else if (ui.where === 's') add({ ...t, s: $('#tree-s').value }, 'Посажено');
      else TB.roads.startDraw({ bar: $('#tree-drawbar'), btn: $('#tree-add'), hint, done: (pts) => add({ ...current(), pts }, 'Аллея нарисована') });
    });
    $('#tree-text-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const text = $('#tree-text').value.trim();
      if (!text) { hint('Напишите, например: «300 платанов вдоль Чуя».'); return; }
      const r = parse(text);
      if (r.error) { hint(r.error); return; }
      if (r.sp) { $('#tree-sp').value = r.sp; spHint(); }
      if (r.n) $('#tree-n').value = Math.min(100000, r.n);
      if (r.age !== undefined) { $('#tree-age').value = Math.min(30, r.age); paintAge(); }
      if (add({ ...current(), ...r.at }, 'Понял')) $('#tree-text').value = '';
    });
    // «Прошло после посадки» двигает возраст всех посадок сценария: видно, как деревья растут
    $('#tree-age').addEventListener('input', () => {
      paintAge();
      const p = st().params;
      if (!(p.trees || []).length) return;
      p.trees = p.trees.map((t) => ({ ...t, age: +$('#tree-age').value }));
      sim().schedule();
    });
    $('#tree-chips').addEventListener('click', (e) => {
      const b = e.target.closest('[data-tree-del]'); if (!b) return;
      const p = st().params;
      p.trees = (p.trees || []).filter((_, i) => i !== +b.dataset.treeDel);
      sim().render(true);
    });
    document.addEventListener('tb:render', paintChips);
    paintChips();
  }
  TB.trees = { parse, label, years, STREETS };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
