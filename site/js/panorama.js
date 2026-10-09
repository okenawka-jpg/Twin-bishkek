/* Twin Bishkek · панорама Ала-Тоо: «Горы видно?».
   Хребет со снегом, предгорья и силуэт города (тополя и панельки). Дымка растёт с AQI,
   дальний хребет размывается сильнее ближнего (воздушная перспектива). Видимость — иллюстрация, не измерение. */
(function () {
  const TB = (window.TB = window.TB || {});
  const NS = 'http://www.w3.org/2000/svg';
  let uid = 0;

  function mulberry(seed) {
    return function () {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // Ломаная хребта методом смещения середины между опорными пиками
  function ridge(W, anchors, amp, rough, levels, rnd) {
    let pts = anchors.map(([x, y]) => [x * W, y]);
    for (let lv = 0; lv < levels; lv++) {
      const next = [pts[0]];
      for (let i = 0; i < pts.length - 1; i++) {
        const [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
        next.push([(x1 + x2) / 2 + (rnd() - 0.5) * (x2 - x1) * 0.25, (y1 + y2) / 2 + (rnd() - 0.5) * 2 * amp], pts[i + 1]);
      }
      pts = next;
      amp *= rough;
    }
    return pts;
  }

  // Силуэт Ала-Тоо: длинная стена с несколькими доминирующими вершинами
  const FAR = [[0, .38], [.06, .3], [.13, .35], [.21, .2], [.29, .3], [.37, .16], [.45, .27], [.53, .19], [.61, .1], [.69, .24], [.77, .15], [.86, .27], [.93, .2], [1, .3]];
  const MID = [[0, .62], [.1, .55], [.22, .62], [.35, .52], [.48, .6], [.6, .53], [.73, .61], [.86, .54], [1, .6]];
  const NEAR = [[0, .2], [.15, .1], [.32, .22], [.5, .12], [.68, .24], [.84, .14], [1, .2]];

  const VARIANTS = {
    strip: { W: 1000, H: 150, farA: .02, farB: 1, midA: .1, midB: .92, nearA: .72, nearB: .6, valleyFrom: '.55', scale: 1, blur: 4, seed: 11 },
    hero:  { W: 1600, H: 620, farA: .06, farB: 1.05, midA: .26, midB: .8, nearA: .74, nearB: .55, valleyFrom: '.6', scale: 1.35, blur: 7, seed: 11, transparentSky: true },
  };

  function el(tag, attrs, parent) {
    const n = document.createElementNS(NS, tag);
    if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }
  const path = (pts, W, H) => `M0 ${H}L` + pts.map((p) => p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('L') + `L${W} ${H}Z`;

  function create(container, opts) {
    opts = opts || {};
    const v = VARIANTS[opts.variant || 'strip'];
    const { W, H } = v;
    const id = 'pano' + ++uid;
    const rnd = mulberry(v.seed);

    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMax slice', class: 'pano-svg', 'aria-hidden': 'true' });
    const defs = el('defs', null, svg);
    const sky = el('linearGradient', { id: id + '-sky', x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
    el('stop', { offset: '0', style: 'stop-color: var(--sky-top)' }, sky);
    el('stop', { offset: '1', style: 'stop-color: var(--sky-bottom)' }, sky);
    const rock = el('linearGradient', { id: id + '-rock', x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
    el('stop', { offset: '0', style: 'stop-color: var(--ridge-far)' }, rock);
    el('stop', { offset: '1', style: 'stop-color: var(--ridge-mid)' }, rock);
    // Смог гуще у земли: вершины выглядывают над слоем инверсии, как в реальном Бишкеке
    const hazeGrad = el('linearGradient', { id: id + '-haze', x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
    el('stop', { offset: '0', style: 'stop-color: var(--haze); stop-opacity: 0' }, hazeGrad);
    el('stop', { offset: '.3', style: 'stop-color: var(--haze); stop-opacity: .35' }, hazeGrad);
    el('stop', { offset: '.62', style: 'stop-color: var(--haze); stop-opacity: 1' }, hazeGrad);
    el('stop', { offset: '1', style: 'stop-color: var(--haze); stop-opacity: 1' }, hazeGrad);
    const filter = el('filter', { id: id + '-blur', x: '-5%', y: '-20%', width: '110%', height: '140%' }, defs);
    const blur = el('feGaussianBlur', { stdDeviation: 0 }, filter);

    // Хребет
    const farPts = ridge(W, FAR.map(([x, y]) => [x, (v.farA + y * v.farB) * H]), 0.055 * H, 0.56, 6, rnd);
    const midPts = ridge(W, MID.map(([x, y]) => [x, (v.midA + y * v.midB) * H]), 0.03 * H, 0.5, 5, rnd);
    const nearPts = ridge(W, NEAR.map(([x, y]) => [x, (v.nearA + y * v.nearB) * H]), 0.018 * H, 0.5, 5, rnd);
    const farD = path(farPts, W, H), midD = path(midPts, W, H), nearD = path(nearPts, W, H);
    const valley = el('linearGradient', { id: id + '-valley', x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
    el('stop', { offset: v.valleyFrom, style: 'stop-color: var(--sky-bottom); stop-opacity: 0' }, valley);
    el('stop', { offset: '1', style: 'stop-color: var(--sky-bottom); stop-opacity: .55' }, valley);

    // Снег: всё, что выше волнистой снеговой линии, внутри силуэта хребта
    const snowBase = (v.farA + 0.36 * v.farB) * H;
    const snowLine = [];
    for (let x = 0; x <= W; x += W / 80) snowLine.push([x, snowBase + Math.sin(x * 0.021) * 0.025 * H + Math.sin(x * 0.067 + 1) * 0.012 * H]);
    const snowClip = el('clipPath', { id: id + '-snow' }, defs);
    el('path', { d: 'M0 0L' + snowLine.map((p) => p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('L') + `L${W} 0Z` }, snowClip);
    const farClip = el('clipPath', { id: id + '-far' }, defs);
    el('path', { d: farD }, farClip);

    if (!v.transparentSky) el('rect', { x: 0, y: 0, width: W, height: H, fill: `url(#${id}-sky)` }, svg);
    const stars = el('g', { class: 'pano-stars' }, svg);
    for (let i = 0; i < 40; i++) el('circle', { cx: (rnd() * W).toFixed(1), cy: (rnd() * snowBase * 0.7).toFixed(1), r: (0.5 + rnd() * 0.9) * (v.scale > 1 ? 1.6 : 1) }, stars);

    const gFar = el('g', { class: 'pano-layer pano-far', filter: `url(#${id}-blur)` }, svg);
    el('path', { d: farD, fill: `url(#${id}-rock)` }, gFar);
    el('path', { d: farD, class: 'pano-snow', 'clip-path': `url(#${id}-snow)` }, gFar);
    // Кулуары: тонкие тени на снегу от вершин вниз-вправо
    const couloirs = el('g', { class: 'pano-couloirs', 'clip-path': `url(#${id}-far)` }, gFar);
    for (let i = 2; i < farPts.length - 2; i++) {
      const [x, y] = farPts[i];
      if (y < farPts[i - 2][1] && y < farPts[i + 2][1] && y < snowBase) {
        const len = (snowBase - y) * (0.6 + rnd() * 0.5);
        el('path', { d: `M${x.toFixed(1)} ${y.toFixed(1)}L${(x + len * 0.42).toFixed(1)} ${(y + len).toFixed(1)}L${(x + len * 0.22).toFixed(1)} ${(y + len).toFixed(1)}Z` }, couloirs);
      }
    }
    const haze1 = el('rect', { x: 0, y: 0, width: W, height: H, class: 'pano-haze', fill: `url(#${id}-haze)` }, svg);

    const gMid = el('g', { class: 'pano-layer pano-mid' }, svg);
    el('path', { d: midD, class: 'pano-mid-fill' }, gMid);
    // Ближние предгорья (адыры) темнее; между слоями — светлая дымка долины для глубины
    el('rect', { x: 0, y: 0, width: W, height: H, fill: `url(#${id}-valley)`, class: 'pano-valley' }, gMid);
    el('path', { d: nearD, class: 'pano-near-fill' }, gMid);
    el('rect', { x: 0, y: 0, width: W, height: H, fill: `url(#${id}-valley)`, class: 'pano-valley pano-valley--near' }, gMid);
    const haze2 = el('rect', { x: 0, y: 0, width: W, height: H, class: 'pano-haze', fill: `url(#${id}-haze)` }, svg);

    // Город: панельные дома и ряды тополей
    const gCity = el('g', { class: 'pano-layer pano-city' }, svg);
    const windows = el('g', { class: 'pano-windows' }, svg);
    const s = v.scale;
    let x = -10;
    while (x < W + 10) {
      if (rnd() < 0.58) {
        const w = (22 + rnd() * 30) * s, h = (9 + rnd() * 17) * s;
        el('rect', { x: x.toFixed(1), y: (H - h).toFixed(1), width: w.toFixed(1), height: (h + 1).toFixed(1) }, gCity);
        const floors = Math.floor(h / (4.2 * s)), cols = Math.floor(w / (5 * s));
        for (let f = 1; f < floors; f++) for (let c = 0; c < cols; c++) {
          if (rnd() < 0.22) el('rect', { x: (x + 2 * s + c * 5 * s).toFixed(1), y: (H - h + f * 4.2 * s).toFixed(1), width: (1.6 * s).toFixed(1), height: (1.4 * s).toFixed(1) }, windows);
        }
        x += w + rnd() * 6 * s;
      } else {
        const n = 2 + Math.floor(rnd() * 4);
        for (let k = 0; k < n; k++) {
          const tw = (5 + rnd() * 3) * s, th = (16 + rnd() * 20) * s;
          el('ellipse', { cx: (x + tw / 2).toFixed(1), cy: (H - th / 2).toFixed(1), rx: (tw / 2).toFixed(1), ry: (th / 2).toFixed(1) }, gCity);
          x += tw + 1.5 * s;
        }
        x += rnd() * 8 * s;
      }
    }
    const haze3 = el('rect', { x: 0, y: 0, width: W, height: H, class: 'pano-haze', fill: `url(#${id}-haze)` }, svg);

    container.appendChild(svg);

    let verdictEl = null;
    if (opts.verdict) {
      verdictEl = document.createElement('div');
      verdictEl.className = 'pano__verdict';
      verdictEl.innerHTML = '<span class="pano__dot"></span><b></b><span class="num"></span>';
      verdictEl.title = 'Иллюстрация: видимость гор пересчитывается из AQI, это не измерение';
      container.appendChild(verdictEl);
    }

    let curBlur = 0, raf = 0, last = null;
    function set(aqi, instant) {
      const vis = TB.model.visibility(aqi);
      const hz = Math.pow(1 - vis.value, 0.85);
      haze1.style.opacity = (hz * 0.92).toFixed(3);
      haze2.style.opacity = (hz * 0.6).toFixed(3);
      haze3.style.opacity = (hz * 0.28).toFixed(3);
      const target = (1 - vis.value) * v.blur;
      cancelAnimationFrame(raf);
      const reduce = instant || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
      if (reduce) { curBlur = target; blur.setAttribute('stdDeviation', target.toFixed(2)); }
      else {
        const from = curBlur, t0 = performance.now();
        const step = (t) => {
          const k = Math.min(1, (t - t0) / 600), e = 1 - Math.pow(1 - k, 3);
          curBlur = from + (target - from) * e;
          blur.setAttribute('stdDeviation', curBlur.toFixed(2));
          if (k < 1) raf = requestAnimationFrame(step);
        };
        raf = requestAnimationFrame(step);
      }
      if (verdictEl) {
        verdictEl.dataset.key = vis.key;
        verdictEl.querySelector('b').textContent = vis.verdict;
        verdictEl.querySelector('.num').textContent = Math.round(vis.value * 100) + '%';
      }
      last = vis;
      return vis;
    }
    return { svg, set, get vis() { return last; } };
  }

  TB.pano = { create };
})();
