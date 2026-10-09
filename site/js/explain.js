/* Twin Bishkek · «Разбор от модели»: текстовый ответ на изменение параметров.
   1) Что изменилось и почему: каждый шаг водопада (автопарк, EV, зелень, застройка, события, час) переводится в причину и следствие.
   2) Стройка: для каждого объекта в стадии «строится» модель считает район сейчас (во время работ) и после окончания.
   3) Что можно сделать: варианты исправления. Каждый, который можно задать параметрами, сначала прогоняется через модель,
      показываются только те, что реально улучшают результат, с кнопкой «Применить». Советы вне модели помечены отдельно.
   Все числа берутся из той же модели (TB.model), что и карточки KPI, текста «из головы» здесь нет. */
(function () {
  const TB = (window.TB = window.TB || {});
  const D = TB.data, M = TB.model;
  const $ = (s, r) => (r || document).querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const fmt = (v, d) => Number(v).toFixed(d).replace('.', ',').replace('-', '−');
  const abs = (v, d) => fmt(Math.abs(v), d);
  const clone = (p) => JSON.parse(JSON.stringify(p));
  const hh = (h) => String(h).padStart(2, '0') + ':00';
  const pct = (v) => Math.round(v * 100) + '%';
  // Варианты считаем локальной JS-моделью: она даёт те же числа, что и Python (расхождение ~1e-13), без запросов к серверу.
  // С включёнными замерами 2GIS поправка есть только на сервере, тогда считаем там.
  const run = (p) => ((TB.backend && TB.backend.learned) || !M.simulateLocal ? M.simulate : M.simulateLocal)(M.normalize(p));

  // Пороги «заметного» изменения: как в карточках KPI
  const EPS = { aqi: 0.5, delay: 0.05, comfort: 0.5 };
  const good = (txt) => `<b class="is-better">${txt}</b>`;
  const bad = (txt) => `<b class="is-worse">${txt}</b>`;
  // «пробки +1,2 мин, AQI +3» с цветом: рост задержки и AQI — хуже, рост комфорта — лучше
  function effects(d, keys = ['delay', 'aqi', 'comfort']) {
    const out = [];
    if (keys.includes('delay') && Math.abs(d.delay) >= EPS.delay) out.push(`задержка ${(d.delay > 0 ? bad : good)((d.delay > 0 ? '+' : '−') + abs(d.delay, 1) + ' мин')}`);
    if (keys.includes('aqi') && Math.abs(d.aqi) >= EPS.aqi) out.push(`AQI ${(d.aqi > 0 ? bad : good)((d.aqi > 0 ? '+' : '−') + abs(d.aqi, 0))}`);
    if (keys.includes('comfort') && Math.abs(d.comfort) >= EPS.comfort) out.push(`комфорт ${(d.comfort > 0 ? good : bad)((d.comfort > 0 ? '+' : '−') + abs(d.comfort, 0))}`);
    return out.length ? out.join(', ') : 'на итог почти не влияет';
  }
  const diff = (a, b) => ({ aqi: a.aqi - b.aqi, delay: a.delay - b.delay, comfort: a.comfort - b.comfort });
  const objName = (o) => `${D.OBJECT_TYPES[o.t].long}${o.n !== 1 ? ' ×' + fmt(o.n, 2).replace(/,?0+$/, '') : ''}`;
  const where = (id) => D.byId[id].name;

  // ---------- 1. что изменилось и почему ----------
  function causes(p, wf) {
    const step = (k) => wf.find((s) => s.key === k), items = [];
    const add = (k, text) => { const s = step(k); if (s) items.push(`${text} → ${effects(s.delta)}.`); };
    if (p.fleet) add('fleet', `Машин на ${abs(p.fleet, 0)}% ${p.fleet > 0 ? 'больше' : 'меньше'}, чем сегодня: ${p.fleet > 0 ? 'улицы загружаются сильнее, растут заторы и выхлоп' : 'улицы разгружаются, выхлопа меньше'}`);
    if (p.ev !== M.P.baseEv) add('ev', `Электромобилей ${fmt(p.ev, 0)}% вместо ${M.P.baseEv}%: ${p.ev > M.P.baseEv ? 'выхлопа меньше' : 'выхлопа больше'}, а место на дороге электромобиль занимает так же, поэтому на пробки это не влияет`);
    if (p.green) add('green', `Зелени на ${abs(p.green, 0)}% ${p.green > 0 ? 'больше: деревья задерживают пыль и выхлоп' : 'меньше: пыль и выхлоп задерживать нечем'}`);
    if (p.objects.length) {
      const list = p.objects.map((o) => `${objName(o)} в районе ${where(o.d)}${o.ph === 'build' ? ' (строится)' : ''}${o.tk > 1.001 ? `, парковок не хватает: машины на соседних улицах ×${fmt(o.tk, 2)}` : ''}`);
      add('objects', `Застройка: ${list.join('; ')}. Новые жители и посетители едут по тем же улицам`);
    }
    if ((p.roads || []).length) {
      const why = {
        tunnel: 'забирает машины с параллельных улиц и едет без светофоров, а выхлоп выходит у порталов на концах',
        elevated: 'забирает машины с параллельных улиц и едет над перекрёстками без светофоров, выхлоп рассеивается выше',
        surface: 'забирает машины с параллельных улиц, но на пересечениях появляются новые светофоры, а выхлоп остаётся на уровне улиц',
      };
      const list = p.roads.map((r) => `${TB.roads.label(r)}: ${r.ph === 'build' ? 'идёт стройка, вдоль трассы сужены улицы и ездят грузовики, сама дорога ещё закрыта' : why[r.kind]}`);
      add('roads', `Новые дороги: ${list.join('; ')}`);
    }
    if ((p.trees || []).length) {
      add('trees', `Посадки деревьев: ${p.trees.map((t) => TB.trees.label(t)).join('; ')}. Кроны дают тень и зелень на жителя, немного задерживают пыль; молодые деревья вдоль улиц поливают водовозы`);
    }
    const ev = p.events, evParts = [];
    if (ev.closure) evParts.push(`перекрыт ${D.CLOSURES[ev.closure].name}, машины уходят на параллельные улицы`);
    if (ev.bridge) evParts.push(`закрыт мост ${D.BRIDGES[ev.bridge].name}, поток идёт в объезд`);
    if (ev.match) { const v = D.STADIUMS[ev.venue]; evParts.push(`матч на стадионе «${v.name}» (${Math.round(v.capacity / 1000)} тыс. мест), к нему едут болельщики`); }
    if (ev.widen) evParts.push(`${D.CLOSURES[ev.widen].name} расширен (+${Math.round(M.P.widen * 100)}% пропускной способности), поток проходит свободнее`);
    if (evParts.length) add('events', evParts.join('; ').replace(/^./, (c) => c.toUpperCase()));
    if (p.hour !== null) {
      const tk = D.TIME.traffic[p.hour], ak = D.TIME.air[p.season][p.hour];
      add('hour', `Время ${hh(p.hour)}: машин ×${fmt(tk, 2)} к среднесуточному, воздух ×${fmt(ak, 2)} (${ak > 1 ? 'смог копится' : 'воздух чище, чем в среднем'})`);
    }
    if (p.season === 'winter') items.push('Зима: к выхлопу добавляется дым угольного отопления частного сектора, а инверсия держит его у земли. Поэтому «сегодня» зимой уже хуже, чем летом.');
    return items;
  }

  // ---------- 2. стройка: сейчас и после окончания ----------
  function construction(p, base, sim) {
    return [...objConstruction(p, base, sim), ...roadConstruction(p, base, sim)];
  }

  // самый задетый район: где задержка выросла (или упала) сильнее всего между двумя прогонами
  function mostAffected(a, b, sign) {
    let best = null;
    Object.values(a.districts).forEach((r) => { const d = (r.delay - b.districts[r.id].delay) * sign; if (d > 0.05 && (!best || d > best.d)) best = { r, d }; });
    return best;
  }
  const nearestDistrict = ([x, y]) => D.DISTRICTS.reduce((m, d) => (Math.hypot(d.x - x, d.y - y) < Math.hypot(m.x - x, m.y - y) ? d : m));

  function roadConstruction(p, base, sim) {
    const R = M.P.road;
    return (p.roads || []).map((r, i) => ({ r, i })).filter((x) => x.r.ph === 'build').map(({ r, i }) => {
      const others = p.roads.filter((_, k) => k !== i);
      const without = run({ ...p, roads: others });
      const after = run({ ...p, roads: p.roads.map((x, k) => (k === i ? { ...x, ph: 'done' } : x)) });
      const B = R.build[r.kind], hit = mostAffected(sim, without, 1);
      const how = {
        tunnel: `Пока роют тоннель (обычно ~${R.months.tunnel} мес.): улицы вдоль трассы почти не трогают, но у двух порталов проезд сужен (−${Math.round(B.portalLoss * 100)}%), там же ездят самосвалы с грунтом и пыль (до +${Math.round(B.dust * 100)}% PM2.5).`,
        elevated: `Пока ставят эстакаду (обычно ~${R.months.elevated} мес.): опоры сужают улицы вдоль трассы (−${Math.round(B.capLoss * 100)}% пропускной способности), ездят краны и грузовики, пыль (до +${Math.round(B.dust * 100)}% PM2.5).`,
        surface: `Пока строят дорогу (обычно ~${R.months.surface} мес.): вдоль трассы перекопано и сужено (−${Math.round(B.capLoss * 100)}% пропускной способности), грузовики, пыль (до +${Math.round(B.dust * 100)}% PM2.5).`,
      }[r.kind];
      const during = `${how} Для города из-за стройки: ${effects(diff(sim.city, without.city), ['delay', 'aqi'])}` +
        (hit ? `; сильнее всего задет район ${hit.r.name} (+${abs(hit.d, 1)} мин).` : '.');
      const rr = after.roads && after.roads[i], load = rr && rr.vc.length ? rr.vc.reduce((a, v) => a + v, 0) / rr.vc.length : null;
      const win = mostAffected(after, base, -1), vsNow = after.city.delay - sim.city.delay;
      let after_ = `После открытия: ${effects(diff(after.city, base.city))} к сегодняшнему.` +
        (load !== null ? ` Дорога загружена в среднем на ${Math.round(load * 100)}%: машины переходят на неё, пока она не заполнится.` : '') +
        (win ? ` Больше всего выигрывает район ${win.r.name} (−${abs(win.d, 1)} мин).` : '') +
        (Math.abs(vsNow) >= EPS.delay ? ` По сравнению со стройкой пробки ${vsNow < 0 ? good('уменьшатся') : bad('вырастут')} на ${abs(vsNow, 1)} мин.` : '');
      if (r.kind === 'tunnel') {
        const ends = [r.pts[0], r.pts[r.pts.length - 1]].map(nearestDistrict).filter((d, k, a) => a.findIndex((x) => x.id === d.id) === k);
        after_ += ` У порталов (${ends.map((d) => d.name).join(', ')}) воздух: ${ends.map((d) => `${d.name} AQI ${(after.districts[d.id].aqi - base.districts[d.id].aqi >= 0 ? '+' : '−')}${abs(after.districts[d.id].aqi - base.districts[d.id].aqi, 1)}`).join(', ')}.`;
      }
      if (r.kind === 'surface') after_ += ' На пересечениях с трассой появятся светофоры: поперечные улицы станут чуть медленнее.';
      return { title: TB.roads.label(r), during, after: after_ };
    });
  }

  function objConstruction(p, base, sim) {
    const B = M.P.build;
    return p.objects.filter((o) => o.ph === 'build').map((o) => {
      const d = o.d, others = p.objects.filter((x) => x !== o);
      const without = run({ ...p, objects: others }).districts[d];
      const after = run({ ...p, objects: [...others, { ...o, ph: 'done' }] });
      const now = sim.districts[d], A = after.districts[d], b0 = base.districts[d], T = D.OBJECT_TYPES[o.t];
      const during = `Пока идут работы: приезжает техника и грузовики (≈${Math.round(B.trafficK * 100)}% потока готового объекта), проезд рядом сужен (−${Math.round(B.capLoss * 100)}% пропускной способности ближайших улиц), в воздухе пыль (до +${Math.round(B.dust * 100)}% PM2.5 рядом), жителей ещё нет. ` +
        `В районе ${where(d)} из-за стройки: ${effects(diff(now, without), ['delay', 'aqi'])}.`;
      const res = T.residents * o.n;
      const afterBits = [];
      if (res) afterBits.push(`заселяются ≈${fmt(res / 1000, 1)} тыс. жителей`);
      if (T.traffic) afterBits.push('появляется постоянный поток машин жителей и посетителей');
      if (T.greenPerPerson) afterBits.push('добавляется зелень');
      if (A.school > 1.001) afterBits.push(`школы загружены на ${bad(pct(A.school))}`);
      else if (res) afterBits.push(`школы ${pct(A.school)}`);
      if (A.clinic > 1.001) afterBits.push(`поликлиники на ${bad(pct(A.clinic))}`);
      const vsNow = A.delay - now.delay;
      const after_ = `После окончания: ${afterBits.join(', ')}. Район ${where(d)} к сегодняшнему: ${effects(diff(A, b0))}. ` +
        (Math.abs(vsNow) >= EPS.delay ? `Пробки в районе станут ${vsNow > 0 ? bad('сильнее') : good('слабее')}, чем во время стройки (${vsNow > 0 ? '+' : '−'}${abs(vsNow, 1)} мин).` : 'Пробки в районе останутся примерно как во время стройки.');
      return { title: `${objName(o)} · ${where(d)}`, during, after: after_ };
    });
  }

  // ---------- 2б. деревья: что дают сейчас, когда вырастут, полив ----------
  function treesInfo(p, base, sim) {
    const T = M.P.trees, year = new Date().getFullYear(), FIELD = 7140; // м² футбольного поля
    return (p.trees || []).map((t, i) => {
      const S = T.species[t.sp], pl = sim.trees.plantings[i];
      const at = (age) => { // польза через age лет: та же модель, меняем только возраст этой посадки
        const q = { ...p, trees: p.trees.map((x, k) => (k === i ? { ...x, age } : x)) };
        const r = run({ ...q, season: 'summer' }), x = r.trees.plantings[i];
        return { age, crown: x.crown, shade: x.total, co2: x.co2t, pm: x.pmKg, cool: t.d ? r.districts[t.d].cool : r.trees.cool };
      };
      const grown = Math.ceil(M.grownAge(t.sp));
      const marks = [...new Set([t.age, Math.max(t.age, 5), Math.max(t.age, 15), Math.max(t.age, grown)])].sort((a, b) => a - b).slice(0, 4);
      const rows = marks.map(at);
      const now = rows[0];
      const left = grown - t.age;
      let html = `<p>${t.age ? `Прошло ${TB.trees.years(t.age)} после посадки` : 'Только посадили (саженцы ~1,5 м кроны)'}: крона ~${fmt(now.crown, 1)} м, тень ~${nfmt(now.shade)} м²${now.shade > FIELD ? ` (≈${fmt(now.shade / FIELD, 1)} футбольных поля)` : ''}, ` +
        `CO₂ ${fmt(now.co2, 1)} т/год, пыль PM2.5 ${fmt(now.pm, 1)} кг/год. ` +
        (left > 0 ? `<b>Вырастут</b> (80% взрослой кроны, ~${fmt(0.8 * S.crown, 0)} м) примерно через ${TB.trees.years(left)} — к ${year + left} году.` : '<b>Деревья уже взрослые</b>: крона близка к максимальной.') +
        (S.ever ? ' Хвойные задерживают пыль и зимой, в сезон смога.' : ' Лиственные дают тень летом, а зимой, в сезон смога, без листьев почти не задерживают пыль.') + '</p>';
      html += `<table class="explain__table"><thead><tr><th>через</th><th>крона</th><th>тень</th><th>CO₂, т/год</th><th>прохладнее летом</th></tr></thead><tbody>` +
        rows.map((r) => `<tr><td>${r.age ? TB.trees.years(r.age) : 'сейчас'}</td><td>${fmt(r.crown, 1)} м</td><td>${nfmt(r.shade)} м²</td><td>${fmt(r.co2, 1)}</td><td>${r.cool >= 0.005 ? '−' + fmt(r.cool, 2) + ' °C' : 'почти нет'}</td></tr>`).join('') + '</tbody></table>';
      html += '<p class="explain__note">«Прохладнее» — в среднем по району; прямо в тени крон летом ощущается до 8 °C прохладнее, чем на солнце.</p>';
      // полив
      const trips = pl.trips;
      let water = `Полив летом: ~${fmt(trips, trips < 10 ? 1 : 0)} рейсов водовоза (10 м³) в неделю${t.age < T.youngAge ? ', пока деревья молодые' : ' (взрослые в основном поливают из арыков)'}.`;
      if (!t.d) {
        const q = { ...p, season: 'summer', hour: 8 }, without = { ...q, trees: p.trees.filter((_, k) => k !== i) };
        const a = run(q), b = run(without), dd = a.city.delay - b.city.delay, spots = a.trees.plantings[i].water.length;
        water += ` Деревья вдоль дороги поливают прямо с проезжей части: утром (${T.waterFrom}:00–${T.waterTo + 1}:00) водовозы занимают полосу` +
          (spots ? ` в ${spots} ${spots === 1 ? 'месте' : 'местах'} одновременно — там возникают заторы` : '') +
          (Math.abs(dd) >= 0.01 ? `; для города в 8:00 это ${bad('+' + fmt(dd, 2) + ' мин')}.` : '.') + ' Днём и вечером не поливают.';
      } else water += ' Внутри района поливают во дворах и скверах, на дороги это не выходит.';
      html += `<p>${water}</p>`;
      return { title: TB.trees.label(t), html };
    });
  }
  const nfmt = (v) => Math.round(v).toLocaleString('ru-RU');

  // ---------- 3. что можно сделать ----------
  function fixes(p, base, sim) {
    const dCity = diff(sim.city, base.city), out = [], tips = [];
    const cands = [];
    const tryFix = (title, why, change) => cands.push({ title, why, p: change(clone(p)) });
    if (dCity.aqi >= 1 || dCity.delay >= 0.3) {
      if (p.fleet > 0) tryFix(`Сдержать рост автопарка: +${fmt(p.fleet / 2, 0)}% вместо +${fmt(p.fleet, 0)}%`, 'квоты на ввоз, платные парковки в центре, общественный транспорт', (q) => { q.fleet = Math.round(p.fleet / 2); return q; });
    }
    if (dCity.aqi >= 1) {
      if (p.ev < 100) tryFix(`Поднять долю электромобилей до ${Math.min(100, p.ev + 25)}%`, 'льготы на ввоз и зарядки; пробки это не уберёт, но выхлопа станет меньше', (q) => { q.ev = Math.min(100, p.ev + 25); return q; });
      if (p.green < 30) tryFix(`Добавить зелени: ${p.green + 10 > 0 ? '+' : ''}${Math.min(30, p.green + 10)}%`, 'посадки вдоль магистралей задерживают пыль и выхлоп', (q) => { q.green = Math.min(30, p.green + 10); return q; });
    }
    if (dCity.delay >= 0.3 || dCity.aqi >= 1) {
      p.objects.forEach((o, i) => {
        if (o.tk > 1.001) tryFix(`Достроить парковки у объекта «${objName(o)}» (${where(o.d)})`, 'машины перестанут стоять на соседних улицах', (q) => { q.objects[i].tk = 1; return q; });
        if (o.ph === 'build' && o.n >= 1.5) tryFix(`Строить в районе ${where(o.d)} по очереди: одновременно вдвое меньше`, 'меньше техники и перекрытий одновременно', (q) => { q.objects[i].n = Math.round((o.n / 2) * 100) / 100; return q; });
      });
      const ev = p.events;
      if (ev.closure) tryFix(`Перенести ремонт: ${D.CLOSURES[ev.closure].name} оставить открытым`, 'вести работы ночью или в выходные, не перекрывать улицу целиком', (q) => { q.events.closure = null; return q; });
      if (ev.bridge && (ev.match || ev.closure)) tryFix(`Не закрывать мост ${D.BRIDGES[ev.bridge].name} одновременно с ${ev.match ? 'матчем' : 'перекрытием улицы'}`, 'развести работы по времени', (q) => { q.events.bridge = null; return q; });
      if (!ev.widen) Object.keys(D.CLOSURES).filter((k) => k !== ev.closure).forEach((k) => tryFix(`Расширить ${D.CLOSURES[k].name} (+${Math.round(M.P.widen * 100)}% пропускной способности)`, 'новая полоса или реверсивное движение', (q) => { q.events.widen = k; return q; }));
      if (ev.match) tips.push('Матч: шаттлы от метро-остановок и перехватывающие парковки разгружают улицы у стадиона (в модели не считается).');
    }
    // новые дороги: другой тип или больше полос
    (p.roads || []).forEach((r, i) => {
      const nm = TB.roads.label(r);
      if (r.kind !== 'tunnel' && (r.ph === 'build' || dCity.aqi > 0)) {
        tryFix(`Сделать «${nm}» тоннелем`, r.ph === 'build' ? 'во время стройки почти не перекрывает улицы, но строится дольше и дороже' : 'выхлоп уйдёт к порталам, вдоль трассы воздух чище; дороже и дольше в стройке', (q) => { q.roads[i].kind = 'tunnel'; return q; });
      }
      if (r.ph === 'done' && r.lanes < 8) {
        const rr = sim.roads && sim.roads[i], load = rr && rr.vc.length ? Math.max(...rr.vc) : 0;
        if (load >= 0.85) tryFix(`Добавить «${nm}» две полосы`, 'дорога заполнена, на неё хотят перейти ещё машины', (q) => { q.roads[i].lanes = r.lanes + 2; return q; });
      }
    });
    // считаем каждый вариант моделью и оставляем только реально помогающие; из расширений улиц берём лучшее
    const scored = cands.map((c) => {
      const r = run(c.p).city, gain = diff(r, sim.city);
      return { ...c, gain, score: Math.max(0, -gain.delay) / 0.5 + Math.max(0, -gain.aqi) / 2 };
    }).filter((c) => c.gain.delay <= -EPS.delay * 2 || c.gain.aqi <= -EPS.aqi * 2);
    const widen = scored.filter((c) => c.p.events.widen && !p.events.widen).sort((a, b) => b.score - a.score).slice(1);    scored.filter((c) => !widen.includes(c)).sort((a, b) => b.score - a.score).slice(0, 4).forEach((c) => out.push(c));

    // деревья: советы по поливу и породам
    (p.trees || []).forEach((t) => {
      if (!t.d && t.age < M.P.trees.youngAge) tips.push(`${TB.trees.label(t)}: мешки для капельного полива (50 л на 3 дня, Бишкекзеленстрой уже их применяет) или полив ночью уберут утренние заторы от водовозов (в модели не считается).`);
    });
    if ((p.trees || []).length && p.trees.every((t) => !M.P.trees.species[t.sp].ever) && sim.city.aqi > 100) {
      tips.push('Все посадки лиственные: зимой, в сезон смога, они без листьев. Часть хвойных (сосна, ель) работает и зимой, но тени дают меньше.');
    }
    // советы вне модели: соцобъекты и зимний смог
    const over = Object.values(sim.districts).filter((r) => { const b = base.districts[r.id]; return (r.school > 1.05 && r.school > b.school + 0.005) || (r.clinic > 1.05 && r.clinic > b.clinic + 0.005); });
    over.forEach((r) => tips.push(`${r.name}: ${r.school > 1.05 ? `школы загружены на ${pct(r.school)}` : ''}${r.school > 1.05 && r.clinic > 1.05 ? ', ' : ''}${r.clinic > 1.05 ? `поликлиники на ${pct(r.clinic)}` : ''}. Нужна новая школа или поликлиника рядом с застройкой (в модели не строится).`));
    if (p.season === 'winter' && sim.city.aqi > 100) tips.push('Зимний смог в основном от угольного отопления: перевод частного сектора на газ и электричество даст больше, чем любые меры по машинам (в модели не задаётся).');
    return { out, tips };
  }

  // ---------- вывод ----------
  let key = null, timer = null, last = null;
  function render(detail) {
    const box = $('#explain-body');
    if (!box) return;
    const p = M.normalize(detail.params || detail.state.params), base = detail.base, sim = detail.sim;
    const k = JSON.stringify(p) + (TB.backend && TB.backend.learned ? 'L' : '');
    if (k === key) return;
    key = k;
    if (M.sameParams(p, M.defaults(p.season))) {
      box.innerHTML = '<p class="explain__empty">Измените параметры слева или выберите готовый сценарий: здесь модель объяснит словами, что произойдёт, почему, и что можно с этим сделать.</p>';
      return;
    }
    const scr = TB.screens && TB.screens.sim, wf = scr && scr._wfKey === JSON.stringify(p) && scr._wf ? scr._wf : M.decompose(p);
    const dC = diff(sim.city, base.city);
    let html = (detail.state.view === 'after' ? '<p class="explain__lead"><b>Показано после окончания всех работ</b> (переключатель над картами).</p>' : '') +
      `<p class="explain__lead">Итог для города: ${effects(dC)}.</p>`;
    const cs = causes(p, wf);
    if (cs.length) html += `<h3 class="explain__h">Что изменилось и почему</h3><ul class="explain__list">${cs.map((t) => `<li>${t}</li>`).join('')}</ul>`;
    const bl = construction(p, base, sim);
    if (bl.length) {
      html += '<h3 class="explain__h">Стройка</h3>' + bl.map((b) => `<div class="explain__build"><b>${esc(b.title)}</b>
        <p><span class="explain__tag explain__tag--now">сейчас</span>${b.during}</p>
        <p><span class="explain__tag explain__tag--after">после</span>${b.after}</p></div>`).join('');
    }
    const ti = sim.trees ? treesInfo(p, base, sim) : [];
    if (ti.length) html += '<h3 class="explain__h">Деревья: польза по годам</h3>' + ti.map((b) => `<div class="explain__build explain__trees"><b>${esc(b.title)}</b>${b.html}</div>`).join('');
    const { out, tips } = fixes(p, base, sim);
    last = out;
    if (out.length || tips.length) {
      html += '<h3 class="explain__h">Что можно сделать</h3><ul class="explain__list explain__fixes">' +
        out.map((f, i) => `<li><div><b>${esc(f.title)}</b> <small>${esc(f.why)}</small><br><span class="explain__check">проверено моделью: ${effects(f.gain)}</span></div><button type="button" class="btn btn--ghost btn--sm" data-fix="${i}">Применить</button></li>`).join('') +
        tips.map((t) => `<li class="explain__tip"><div>${esc(t)}</div></li>`).join('') + '</ul>';
    } else if (dC.delay >= 0.3 || dC.aqi >= 1) {
      html += '<h3 class="explain__h">Что можно сделать</h3><p class="explain__empty">Простые меры из модели здесь заметно не помогают.</p>';
    }
    box.innerHTML = html;
  }

  function init() {
    const box = $('#explain-body');
    if (!box) return;
    document.addEventListener('tb:render', (e) => { clearTimeout(timer); timer = setTimeout(() => render(e.detail), 200); });
    box.addEventListener('click', (e) => {
      const b = e.target.closest('[data-fix]');
      if (!b || !last || !last[+b.dataset.fix]) return;
      const f = last[+b.dataset.fix];
      TB.state.params = M.normalize(f.p);
      TB.screens.sim.render(true);
      if (TB.ui && TB.ui.toast) TB.ui.toast('Применено: ' + f.title);
    });
  }
  TB.explain = { causes, construction, fixes };
  init(); // скрипт стоит в конце body, карточка уже в DOM; слушатель должен успеть до первого рендера из app.js
})();
