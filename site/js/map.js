/* Twin Bishkek · карта из сот (SVG).
   Соты — цвет AQI (непрерывная шкала EPA), улицы — толщина и бегущий пунктир (скорость = скорость потока),
   объекты конструктора и события — значки. Подписи держат постоянный экранный размер при любом масштабе. */
(function () {
  const TB = (window.TB = window.TB || {});
  const NS = 'http://www.w3.org/2000/svg';

  const AQI_STOPS = [[25, '#4CB87A'], [75, '#EFD24A'], [125, '#F2953A'], [175, '#E8604C'], [250, '#8A4BA6'], [400, '#6A1F3D']];
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const STOPS_RGB = AQI_STOPS.map(([a, c]) => [a, rgb(c)]);
  function aqiColor(a) {
    if (a <= STOPS_RGB[0][0]) return AQI_STOPS[0][1];
    for (let k = 1; k < STOPS_RGB.length; k++) {
      const [a1, c1] = STOPS_RGB[k];
      if (a <= a1) {
        const [a0, c0] = STOPS_RGB[k - 1], t = (a - a0) / (a1 - a0);
        return 'rgb(' + c0.map((v, i) => Math.round(v + (c1[i] - v) * t)).join(',') + ')';
      }
    }
    return AQI_STOPS[AQI_STOPS.length - 1][1];
  }
  function deltaColor(d) {
    const k = d <= -10 ? 'b3' : d <= -4 ? 'b2' : d <= -1 ? 'b1' : d < 1 ? '0' : d < 4 ? 'w1' : d < 10 ? 'w2' : 'w3';
    return 'var(--d-' + k + ')';
  }
  // как в навигаторах: зелёный — едем почти свободно, жёлтый — плотно, красный — затор, бордовый — стоим.
  // Цвет по потере скорости, как в навигаторах: пороги V/C 1.0 / 1.25 / 1.5 = замедление по BPR на 50% / 120% / 250%
  // (скорость ≥67% свободной — зелёный, 45–67% — жёлтый, 28–45% — красный, ниже — бордовый).
  const congestion = (vc, closed) => (closed === 2 ? 'closed' : vc >= 1.5 ? 'severe' : vc >= 1.25 ? 'jam' : vc >= 1.0 ? 'dense' : 'free');

  function el(tag, attrs, parent) {
    const n = document.createElementNS(NS, tag);
    if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }
  const poly = (pts) => 'M' + pts.map((p) => p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('L');
  const smooth = (pts) => {
    // Catmull-Rom → кубические Безье: реки и изолинии без изломов
    let d = 'M' + pts[0][0] + ' ' + pts[0][1];
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
      d += `C${(p1[0] + (p2[0] - p0[0]) / 6).toFixed(1)} ${(p1[1] + (p2[1] - p0[1]) / 6).toFixed(1)},${(p2[0] - (p3[0] - p1[0]) / 6).toFixed(1)} ${(p2[1] - (p3[1] - p1[1]) / 6).toFixed(1)},${p2[0]} ${p2[1]}`;
    }
    return d;
  };

  let uid = 0;

  function create(container, opts) {
    opts = opts || {};
    const M = TB.model, D = TB.data, G = M.grid(), SEG = M.segments();
    const id = 'm' + ++uid;
    container.style.aspectRatio = D.W + ' / ' + D.H;
    const svg = el('svg', { viewBox: `0 0 ${D.W} ${D.H}`, class: 'tbmap' + (opts.mini ? ' tbmap--mini' : ''), role: 'img', 'aria-label': opts.label || 'Карта Бишкека из сот' });
    const defs = el('defs', null, svg);
    const clip = el('clipPath', { id: id + '-land' }, defs);
    el('path', { d: poly(D.OUTLINE) + 'Z' }, clip);

    el('rect', { x: 0, y: 0, width: D.W, height: D.H, class: 'm-outside' }, svg);
    if (!opts.mini && D.CONTOURS) {
      const gc = el('g', { class: 'm-contours' }, svg);
      D.CONTOURS.forEach((c) => {
        el('path', { d: smooth(c.pts), class: 'm-contour' }, gc);
        const [x, y] = c.pts[c.pts.length - 1];
        const t = el('text', { x: x - 6, y: y - 8, class: 'm-contour-label', 'text-anchor': 'end' }, gc);
        t.textContent = c.label;
      });
    }
    el('path', { d: poly(D.OUTLINE) + 'Z', class: 'm-land' }, svg);

    // Соты
    const gHex = el('g', { class: 'm-hexes' }, svg);
    const hexEls = G.hexes.map((h) => {
      const pts = [0, 1, 2, 3, 4, 5].map((k) => G.corner(h, k, G.R + 0.4));
      const p = el('path', { d: poly(pts) + 'Z', class: 'm-hex', 'data-i': h.i }, gHex);
      const dc = Math.hypot(h.x - D.CENTER.x, h.y - D.CENTER.y);
      p.style.setProperty('--rise', Math.round(dc * 0.9) + 'ms');
      return p;
    });

    // Границы районов: рёбра между сотами разных районов
    let border = '';
    G.hexes.forEach((h) => h.nb.forEach((j, k) => {
      if (j > h.i && G.hexes[j].d !== h.d) {
        const a = G.corner(h, k), b = G.corner(h, (k + 1) % 6);
        border += `M${a[0].toFixed(1)} ${a[1].toFixed(1)}L${b[0].toFixed(1)} ${b[1].toFixed(1)}`;
      }
    }));
    el('path', { d: border, class: 'm-border' }, svg);

    const api = { svg, update, select, resize, hexEls, toMap };
    // экранные координаты → пиксели схемы (для рисования новой дороги кликами)
    function toMap(clientX, clientY) {
      const pt = svg.createSVGPoint();
      pt.x = clientX; pt.y = clientY;
      const p = pt.matrixTransform(svg.getScreenCTM().inverse());
      return [p.x, p.y];
    }
    if (opts.mini) {
      container.appendChild(svg);
      return api;
    }

    // Вода
    const gWater = el('g', { class: 'm-water-g' }, svg);
    D.RIVERS.forEach((r) => el('path', { d: smooth(r.pts), class: 'm-water' }, gWater));
    D.CANALS.forEach((c) => el('path', { d: smooth(c.pts), class: 'm-water m-canal' }, gWater));

    // Улицы: подложка (для затора), линия, бегущий поток
    const gStreets = el('g', { class: 'm-streets' }, svg);
    const gCasings = el('g', null, gStreets); // сначала все подложки, потом все линии: иначе подложка соседа «рвёт» линию
    const gLines = el('g', null, gStreets);
    const segEls = SEG.map((s) => {
      const d = `M${s.ax.toFixed(1)} ${s.ay.toFixed(1)}L${s.bx.toFixed(1)} ${s.by.toFixed(1)}`;
      return {
        casing: el('path', { d, class: 'm-casing' }, gCasings),
        line: el('path', { d, class: 'm-street' }, gLines),
      };
    });
    const pulse = el('circle', { r: 7, class: 'm-pulse', cx: -100, cy: -100 }, svg);
    const gRoads = el('g', { class: 'm-roads' }, svg); // новые дороги сценария (тоннель / эстакада / обычная)
    const gTrees = el('g', { class: 'm-trees' }, svg); // кроны новых посадок и водовозы у молодых деревьев

    // Подписи
    const gLabels = el('g', { class: 'm-labels' }, svg);
    const label = (x, y, text, cls, rot) => {
      const t = el('text', { x, y, class: 'm-label ' + (cls || ''), 'text-anchor': 'middle' }, gLabels);
      if (rot) t.setAttribute('transform', `rotate(${rot} ${x} ${y})`);
      t.textContent = text;
      return t;
    };
    D.RIVERS.forEach((r) => { if (r.label) label(r.label.x, r.label.y, r.name, 'm-label--water', r.label.rot); });
    D.CANALS.forEach((c) => { if (c.label) label(c.label.x, c.label.y, c.name, 'm-label--water'); });
    D.STREET_LABELS.slice(0, 8).forEach((s) => label(s.x, s.y, s.name, 'm-label--street', s.rot));
    const distLabels = {};
    D.DISTRICTS.forEach((d) => { distLabels[d.id] = label(d.x, d.y + 5, d.name, 'm-label--district'); });

    // Места притяжения: стадионы и парки развлечений (постоянные значки с подписями)
    const gVenues = el('g', { class: 'm-venues' }, svg);
    D.VENUES.forEach((v) => {
      pin(gVenues, v.x, v.y, v.kind === 'stadium' ? 'i-stadium' : 'i-fun', 1, 'm-pin--venue');
      label(v.x, v.y, v.name, 'm-label--venue').setAttribute('dy', v.id === 'arena' ? '-1.9em' : '2.4em'); // «Арена» и «Евразия» рядом: подписи разводим
    });

    const gSel = el('g', { class: 'm-sel-g' }, svg);
    const selPath = el('path', { class: 'm-sel', d: '' }, gSel);
    const gEvents = el('g', { class: 'm-events' }, svg);
    const gObjects = el('g', { class: 'm-objects' }, svg);

    if (opts.note !== false) {
      const note = el('text', { x: D.W - 16, y: D.H - 14, class: 'm-note', 'text-anchor': 'end' }, svg);
      note.textContent = 'OSM · районы условные · пробки — расчёт модели';
    }

    container.appendChild(svg);

    // Интерактив: наведение и выбор района
    gHex.addEventListener('mousemove', (e) => {
      const i = e.target.getAttribute && e.target.getAttribute('data-i');
      if (i !== null && opts.onHover) opts.onHover(+i, e);
    });
    gHex.addEventListener('mouseleave', () => opts.onHover && opts.onHover(-1));
    gHex.addEventListener('click', (e) => {
      const i = e.target.getAttribute && e.target.getAttribute('data-i');
      if (i !== null && opts.onSelect) opts.onSelect(G.hexes[+i].d);
    });

    // Значок постоянного экранного размера: сдвиг ox/oy задаётся в экранных пикселях
    function pin(parent, x, y, icon, count, cls, ox, oy) {
      const g = el('g', { class: 'm-pin ' + (cls || '') }, parent);
      g.style.transform = `translate(${x}px, ${y}px) scale(var(--inv, 1)) translate(${ox || 0}px, ${oy || 0}px)`;
      el('circle', { r: 15, class: 'm-pin__bg' }, g);
      el('use', { href: '#' + icon, x: -9, y: -9, width: 18, height: 18, class: 'm-pin__icon' }, g);
      if (count > 1) {
        el('circle', { cx: 13, cy: -12, r: 9, class: 'm-pin__badge' }, g);
        const t = el('text', { x: 13, y: -8.5, class: 'm-pin__count', 'text-anchor': 'middle' }, g);
        t.textContent = count;
      }
      return g;
    }

    let lastSelected = undefined;
    function select(distId) {
      if (distId === lastSelected) return;
      lastSelected = distId;
      Object.entries(distLabels).forEach(([k, t]) => t.classList.toggle('is-selected', k === distId));
      if (!distId) { selPath.setAttribute('d', ''); return; }
      let d = '';
      G.hexes.forEach((h) => {
        if (h.d !== distId) return;
        h.nb.forEach((j, k) => {
          if (j === -1 || G.hexes[j].d !== distId) {
            const a = G.corner(h, k), b = G.corner(h, (k + 1) % 6);
            d += `M${a[0].toFixed(1)} ${a[1].toFixed(1)}L${b[0].toFixed(1)} ${b[1].toFixed(1)}`;
          }
        });
      });
      selPath.setAttribute('d', d);
    }

    function update(res, o) {
      o = o || {};
      const base = o.base, layer = o.layer || 'both';
      svg.classList.toggle('layer-air', layer === 'air');
      svg.classList.toggle('layer-traffic', layer === 'traffic');
      svg.classList.toggle('is-delta', !!o.delta);
      for (let i = 0; i < hexEls.length; i++) {
        hexEls[i].style.fill = o.delta && base ? deltaColor(res.aqi[i] - base.aqi[i]) : aqiColor(res.aqi[i]);
        hexEls[i].classList.toggle('is-high', res.cat[i] >= 4);
      }
      if (opts.mini) return;

      let worst = -1, worstVc = 1.1;
      SEG.forEach((s, i) => {
        const vc = res.seg.vc[i], closed = res.seg.closed[i];
        const c = congestion(vc, closed);
        const els = segEls[i];
        els.line.setAttribute('class', 'm-street ' + c + (closed === 1 ? ' is-narrowed' : ''));
        els.casing.setAttribute('class', 'm-casing ' + c);
        if (closed !== 2 && vc > worstVc) { worstVc = vc; worst = i; }
      });
      if (worst >= 0 && layer !== 'air') {
        pulse.setAttribute('cx', SEG[worst].mx);
        pulse.setAttribute('cy', SEG[worst].my);
        pulse.style.display = '';
      } else pulse.style.display = 'none';

      // Новые дороги: цвет по загрузке; стройка — серый пунктир; тоннель — штрих (под землёй) и порталы на концах
      gRoads.textContent = '';
      (res.roads || []).forEach((r) => {
        const cls = 'm-road m-road--' + r.kind + (r.ph === 'build' ? ' is-build' : '');
        if (r.ph === 'build') el('path', { d: poly(r.pts), class: cls }, gRoads);
        else r.segs.forEach((s, j) => {
          const d = `M${s[0].toFixed(1)} ${s[1].toFixed(1)}L${s[2].toFixed(1)} ${s[3].toFixed(1)}`;
          if (r.kind === 'elevated') el('path', { d, class: 'm-road__casing' }, gRoads);
          el('path', { d, class: cls + ' ' + congestion(r.vc[j], 0) }, gRoads);
        });
        if (r.kind === 'tunnel') [r.pts[0], r.pts[r.pts.length - 1]].forEach(([x, y]) => el('circle', { cx: x, cy: y, r: 6, class: 'm-road__portal' }, gRoads));
      });

      // Деревья: круг на соте = настоящая площадь крон (1 px = 25 м); летом в часы полива — водовозы на улицах
      gTrees.textContent = '';
      const tr = res.trees;
      if (tr && tr.hexes.length) {
        tr.hexes.forEach(([i, c]) => el('circle', { cx: G.hexes[i].x, cy: G.hexes[i].y, r: Math.max(2.5, Math.sqrt(c / 625 / Math.PI)).toFixed(1), class: 'm-tree' }, gTrees));
        const h = res.params.hour, T = M.P.trees;
        if (res.params.season === 'summer' && (h === null || (h >= T.waterFrom && h <= T.waterTo))) {
          tr.plantings.forEach((pl) => pl.water.forEach((si) => pin(gTrees, SEG[si].mx, SEG[si].my, 'i-car', 1, 'm-pin--water')));
        }
      }

      // События: контуры и значки
      gEvents.textContent = '';
      const ev = res.params.events;
      if (ev.match) {
        const sv = D.STADIUMS[ev.venue] || D.STADIUM;
        el('circle', { cx: sv.x, cy: sv.y, r: 80, class: 'm-zone' }, gEvents);
        pin(gEvents, sv.x, sv.y, 'i-stadium', 1, 'm-pin--event');
      }
      if (ev.bridge) {
        const b = D.BRIDGES[ev.bridge];
        el('circle', { cx: b.x, cy: b.y, r: 36, class: 'm-zone' }, gEvents);
        pin(gEvents, b.x, b.y, 'i-bridge', 1, 'm-pin--event', 0, -30);
      }
      if (ev.closure) {
        const segs = SEG.filter((s, i) => res.seg.closed[i] === 1);
        if (segs.length) {
          // отрезки лежат в произвольном порядке: ставим значок на ближайший к «центру тяжести» закрытого участка
          const cx = segs.reduce((a, s) => a + s.mx, 0) / segs.length, cy = segs.reduce((a, s) => a + s.my, 0) / segs.length;
          const mid = segs.reduce((best, s) => (Math.hypot(s.mx - cx, s.my - cy) < Math.hypot(best.mx - cx, best.my - cy) ? s : best));
          pin(gEvents, mid.mx, mid.my, 'i-barrier', 1, 'm-pin--event', 0, -26);
        }
      }
      // Объекты конструктора — только на карте «Если…»: ряд значков над подписью района
      gObjects.textContent = '';
      const byDistrict = {};
      res.params.objects.forEach((obj) => { (byDistrict[obj.d] = byDistrict[obj.d] || []).push(obj); });
      Object.entries(byDistrict).forEach(([dId, list]) => {
        const dd = D.byId[dId];
        list.forEach((obj, k) => {
          pin(gObjects, dd.x, dd.y, D.OBJECT_TYPES[obj.t].icon, obj.n, 'm-pin--obj', (k - (list.length - 1) / 2) * 36, -22);
        });
      });
    }

    function resize() {
      const w = container.clientWidth || 500;
      const k = w / D.W;
      svg.style.setProperty('--lbl', (12.5 / k).toFixed(2) + 'px');
      svg.style.setProperty('--lbl-s', (11.5 / k).toFixed(2) + 'px');
      svg.style.setProperty('--halo', (3.2 / k).toFixed(2) + 'px');
      svg.style.setProperty('--inv', (1 / k).toFixed(3));
    }
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resize).observe(container);
    resize();
    return api;
  }

  TB.map = { create, aqiColor, deltaColor, congestion };
})();
