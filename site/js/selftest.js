/* Twin Bishkek · самопроверка модели по тест-кейсам TC-01…TC-16 из USE_CASES.md.
   В браузере: index.html?selftest. Проверяются направления изменений и инварианты, а не точные числа. */
(function () {
  const TB = (window.TB = window.TB || {});

  function run() {
    const M = TB.model, D = TB.data;
    const base = (season) => M.simulate(M.defaults(season || 'summer'));
    const with_ = (patch, season) => {
      const d = M.defaults(season || 'summer');
      return M.simulate({ ...d, ...patch, events: { ...d.events, ...(patch.events || {}) } });
    };
    const B = base();
    const results = [];
    const t = (id, name, fn) => {
      let pass = false, detail = '';
      try { [pass, detail] = fn(); } catch (e) { pass = false; detail = 'ошибка: ' + e.message; }
      results.push({ id, name, pass: !!pass, detail });
    };
    const f2 = (x) => (Math.round(x * 100) / 100).toString();

    t('TC-01', 'По умолчанию Simulated = Base', () => {
      const r = base();
      const same = ['pm', 'aqi', 'delay', 'speed', 'comfort'].every((k) => r.city[k] === B.city[k]);
      return [same, 'Δ = 0 по всем KPI'];
    });
    t('TC-02', 'Автопарк +20%, EV 0% → пробки ↑, PM ↑', () => {
      const r = with_({ fleet: 20, ev: 0 });
      return [r.city.delay > B.city.delay && r.city.speed < B.city.speed && r.city.pm > B.city.pm,
        `задержка ${f2(B.city.delay)}→${f2(r.city.delay)}, PM ${f2(B.city.pm)}→${f2(r.city.pm)}`];
    });
    t('TC-03', 'Весь прирост — EV → пробки ↑, PM = база', () => {
      const ev = 100 * (1 - (1 - M.P.baseEv / 100) / 1.2);
      const r = with_({ fleet: 20, ev });
      return [r.city.delay > B.city.delay && Math.abs(r.city.pm - B.city.pm) < 1e-6,
        `EV ${f2(ev)}%: задержка ${f2(B.city.delay)}→${f2(r.city.delay)}, ΔPM ${(r.city.pm - B.city.pm).toExponential(1)}`];
    });
    t('TC-04', 'EV 5% → 35%: задержка та же, PM ↓', () => {
      const a = with_({ fleet: 20, ev: 5 }), b = with_({ fleet: 20, ev: 35 });
      return [Math.abs(a.city.delay - b.city.delay) < 1e-9 && b.city.pm < a.city.pm,
        `PM ${f2(a.city.pm)}→${f2(b.city.pm)}`];
    });
    t('TC-05', 'Зелень +10% → PM ↓, комфорт ↑', () => {
      const r = with_({ green: 10 });
      return [r.city.pm < B.city.pm && r.city.comfort > B.city.comfort, `комфорт ${f2(B.city.comfort)}→${f2(r.city.comfort)}`];
    });
    t('TC-06', 'Зелень −15% → PM ↑, комфорт ↓', () => {
      const r = with_({ green: -15 });
      return [r.city.pm > B.city.pm && r.city.comfort < B.city.comfort, `комфорт ${f2(B.city.comfort)}→${f2(r.city.comfort)}`];
    });
    t('TC-07', 'ЖК в Джале: эффект локальный', () => {
      const r = with_({ objects: [{ d: 'jal', t: 'jk', n: 1 }] });
      const near = r.districts.jal.delay > B.districts.jal.delay;
      const far = ['tunguch', 'alamedin', 'uchkun'].every((id) =>
        Math.abs(r.districts[id].delay - B.districts[id].delay) < 0.1 && Math.abs(r.districts[id].aqi - B.districts[id].aqi) < 0.5);
      return [near && far, `Джал +${f2(r.districts.jal.delay - B.districts.jal.delay)} мин; дальние районы без изменений`];
    });
    t('TC-08', '1 ЖК → 3 ЖК: эффект растёт', () => {
      const one = with_({ objects: [{ d: 'jal', t: 'jk', n: 1 }] }), three = with_({ objects: [{ d: 'jal', t: 'jk', n: 3 }] });
      return [three.city.delay >= one.city.delay && three.districts.jal.delay >= one.districts.jal.delay && three.districts.jal.school > one.districts.jal.school,
        `школы Джала ${Math.round(one.districts.jal.school * 100)}% → ${Math.round(three.districts.jal.school * 100)}%`];
    });
    t('TC-09', 'Матч → заторы у стадиона', () => {
      const r = with_({ events: { match: true } });
      const segs = M.segments().filter((s) => Math.hypot(s.mx - D.STADIUM.x, s.my - D.STADIUM.y) < 150);
      const ok = segs.every((s) => r.seg.vc[s.i] >= B.seg.vc[s.i]) && segs.some((s) => r.seg.vc[s.i] > B.seg.vc[s.i] + 0.1);
      return [ok, `${segs.length} сегментов рядом со стадионом`];
    });
    t('TC-10', 'Матч + мост ≥ каждого по отдельности', () => {
      const m = with_({ events: { match: true } }), b = with_({ events: { bridge: 'alaarcha' } });
      const both = with_({ events: { match: true, bridge: 'alaarcha' } });
      const dm = m.city.delay - B.city.delay, db = b.city.delay - B.city.delay, dmb = both.city.delay - B.city.delay;
      return [dmb >= Math.max(dm, db) - 1e-9, `Δ матч ${f2(dm)}, мост ${f2(db)}, вместе ${f2(dmb)} мин`];
    });
    t('TC-11', 'Монотонность по автопарку', () => {
      let prev = -Infinity, ok = true;
      for (let fl = -30; fl <= 50; fl += 5) {
        const d = with_({ fleet: fl }).city.delay;
        if (d < prev - 1e-9) ok = false;
        prev = d;
      }
      return [ok, 'задержка не убывает от −30% до +50%'];
    });
    t('TC-12', 'Граничные значения без NaN', () => {
      let ok = true;
      ['summer', 'winter'].forEach((season) => [0, 100].forEach((ev) => [-30, 50].forEach((fleet) => [-30, 30].forEach((green) => {
        const r = with_({ fleet, ev, green, objects: [{ d: 'center', t: 'tc', n: 9 }, { d: 'jal', t: 'jk', n: 9 }, { d: 'jal', t: 'park', n: 9 }], events: { match: true, closure: 'chuy', bridge: 'alamedin' } }, season);
        const vals = [r.city.pm, r.city.aqi, r.city.delay, r.city.speed, r.city.comfort, ...r.aqi];
        if (!vals.every(Number.isFinite)) ok = false;
        if (r.city.aqi < 0 || r.city.aqi > 500 || r.city.comfort < 0 || r.city.comfort > 100) ok = false;
        if ([...r.cat].some((c) => c > 5)) ok = false;
      }))));
      return [ok, '32 крайних комбинации'];
    });
    t('TC-13', 'Детерминизм', () => {
      const p = M.presetParams('uc05');
      const a = M.simulate(p), b = M.simulate(p);
      return [JSON.stringify([a.city, [...a.pm]]) === JSON.stringify([b.city, [...b.pm]]), 'одинаковый вход → одинаковый выход'];
    });
    t('TC-14', 'Расчёт < 0.5 с (p95 на 100 прогонах)', () => {
      let seed = 7;
      const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      const times = [];
      for (let i = 0; i < 100; i++) {
        const r = M.simulate({ season: rnd() > 0.5 ? 'winter' : 'summer', fleet: -30 + rnd() * 80, ev: rnd() * 100, green: -30 + rnd() * 60,
          objects: rnd() > 0.5 ? [{ d: D.DISTRICTS[Math.floor(rnd() * 12)].id, t: ['jk', 'tc', 'park'][Math.floor(rnd() * 3)], n: 1 + Math.floor(rnd() * 5) }] : [],
          events: { match: rnd() > 0.5, closure: rnd() > 0.7 ? 'chuy' : null, bridge: rnd() > 0.7 ? 'alaarcha' : null } });
        times.push(r.ms);
      }
      times.sort((a, b) => a - b);
      const p95 = times[94];
      return [p95 < 500, `p95 = ${p95.toFixed(2)} мс`];
    });
    t('TC-15', 'Сброс возвращает базу', () => {
      M.simulate(M.presetParams('uc05'));
      const r = M.simulate(M.defaults('summer'));
      return [r.city.pm === B.city.pm && r.city.delay === B.city.delay && r.city.comfort === B.city.comfort, 'скрытого состояния нет'];
    });
    t('TC-16', 'Удаление объекта обратимо', () => {
      with_({ objects: [{ d: 'asanbay', t: 'tc', n: 2 }] });
      const r = with_({ objects: [] });
      return [r.city.pm === B.city.pm && r.city.delay === B.city.delay, 'KPI вернулись к значениям до добавления'];
    });
    return results;
  }

  TB.selftest = { run };
})();
