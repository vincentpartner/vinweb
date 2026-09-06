/* Falling letters hero — MOBILE-Variante (Kopie von falling-letters.js).
   Unterschiede zur Desktop-Version:
   - Nur ein Wort: VINCENT, fett (weniger Buchstaben = bessere Performance).
   - Buchstaben schlagen auf einem Boden leicht oberhalb des ersten Textes auf.
   - Gyro-Steuerung: Neigt man das Gerät, fallen die Buchstaben in diese Richtung.
     (iOS fragt die Berechtigung beim ersten Antippen der Fläche an.)
   Wird von falling-letters.js über window.__flMobileSetup() aufgerufen,
   sobald der Container schmaler als 640px ist. */
(function () {
  function hexFromVar(el, name, fallback) {
    const v = getComputedStyle(el).getPropertyValue(name).trim();
    return v || fallback;
  }

  window.__flMobileSetup = function setup(container) {
    if (container.__fl) return;
    container.__fl = true;

    const { Engine, Render, Bodies, Composite, Body, MouseConstraint, Mouse, Events } = Matter;

    let width = container.clientWidth;
    const height = container.clientHeight || 460;
    container.style.position = 'relative';

    const inkCol = hexFromVar(container, '--ink', '#111111');

    // Mobile: bewusst nur EIN kurzes Wort.
    const rawWords = ['VINCENT'];
    function caseMode() {
      return document.documentElement.getAttribute('data-letter-case') || 'Versalien';
    }
    function applyCase(arr) {
      return caseMode() === 'Normal' ? arr.slice() : arr.map(w => w.toUpperCase());
    }
    let words = applyCase(rawWords);

    // Übergross: Startwert bewusst riesig — fitFont() skaliert exakt so weit
    // herunter, dass VINCENT die Fläche knapp ausfüllt.
    const baseFontSize = 480;
    let fontSize = baseFontSize;
    function headFamily() {
      const v = getComputedStyle(container).getPropertyValue('--font-head').trim();
      return v || 'Arial, sans-serif';
    }
    // Mobile: eine Stufe leichter als zuvor (900 -> 800).
    const fontWeight = '800';
    let fontFamily = headFamily();
    let fontStyle = `${fontWeight} ${fontSize}px ${fontFamily}`;
    // Original-Physik wie zu Beginn: sattes Bouncen beim Aufprall
    const bounciness = 0.7, friction = 0.02, airResistance = 0.015;
    const dropHeight = -300;

    // Boden leicht oberhalb der Unterkante (= leicht oberhalb des ersten Textes darunter).
    const FLOOR_LIFT = 14;
    const floorY = height - FLOOR_LIFT;

    // Die grössten Buchstaben: jeder Buchstabe nimmt gut 60% der Breite ein.
    // Das Wort muss nicht quer Platz haben — die Buchstaben stapeln sich.
    const PAD = 10;
    function fitFont() {
      const mc2 = document.createElement('canvas').getContext('2d');
      const probe = 100;
      mc2.font = `${fontWeight} ${probe}px ${fontFamily}`;
      let maxCh = 0;
      words.join('').split('').forEach(ch => { maxCh = Math.max(maxCh, mc2.measureText(ch).width); });
      const target = width * 0.62;              // Zielbreite des breitesten Buchstabens
      fontSize = Math.floor(probe * (target / maxCh));
      fontSize = Math.min(fontSize, Math.floor(height * 0.42));
      fontSize = Math.floor(fontSize * 0.72);   // 0.8 minus 10% — kleinere Mobile-Schrift
      fontStyle = `${fontWeight} ${fontSize}px ${fontFamily}`;
    }
    fitFont();

    const engine = Engine.create();
    engine.world.gravity.y = 2.4;
    container.__engine = engine;

    const render = Render.create({
      element: container,
      engine: engine,
      options: { width, height, wireframes: false, background: 'transparent', pixelRatio: Math.min(window.devicePixelRatio || 1, 2) }
    });

    const wallOpt = { isStatic: true, render: { visible: false }, friction: 0.1, restitution: 0.4 };
    const walls = [
      Bodies.rectangle(width / 2, floorY + 50, 6000, 100, wallOpt),  // Boden
      Bodies.rectangle(-50, height / 2, 100, 6000, wallOpt),
      Bodies.rectangle(width + 50, height / 2, 100, 6000, wallOpt)
    ];
    Composite.add(engine.world, walls);

    function makeLetter(char, x, y, color) {
      const c = document.createElement('canvas');
      const cx = c.getContext('2d');
      cx.font = fontStyle;
      const w = cx.measureText(char).width;
      const h = fontSize * 0.74;
      const body = Bodies.rectangle(x, y, w, h, {
        restitution: bounciness, friction: friction, frictionAir: airResistance,
        render: { fillStyle: 'transparent', strokeStyle: 'transparent', text: { content: char, font: fontStyle, color: color, z: Math.random() } }
      });
      Body.setAngle(body, (Math.random() - 0.5) * 0.15);
      return body;
    }

    function spawnWord(word, color, delay) {
      setTimeout(() => {
        const c = document.createElement('canvas');
        const cx = c.getContext('2d');
        cx.font = fontStyle;
        // Buchstaben fallen NACHEINANDER rein und stapeln sich. Verteilte
        // Slots (links/rechts/mitte) halten den Stapel flach genug, damit
        // trotz Riesenbuchstaben nichts oben abgeschnitten wird.
        const slots = [0.28, 0.72, 0.5];
        word.split('').forEach((char, index) => {
          const charWidth = cx.measureText(char).width;
          const min = PAD + charWidth / 2;
          const max = width - PAD - charWidth / 2;
          const jitter = (Math.random() - 0.5) * width * 0.06;
          let xCenter = width * slots[index % slots.length] + jitter;
          xCenter = Math.max(min, Math.min(max, xCenter));
          setTimeout(() => {
            Composite.add(engine.world, makeLetter(char, xCenter, dropHeight, color));
          }, index * 420);
        });
      }, delay);
    }

    let startedSpawn = false;
    function startSpawns() {
      if (startedSpawn) return;
      startedSpawn = true;
      words.forEach((w, i) => {
        spawnWord(w, inkCol, i * 2500); // erstes Wort sofort
      });
    }

    Events.on(render, 'afterRender', () => {
      const ctx = render.context;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      // Farbe live aus --ink lesen, damit Hell/Dunkel-Wechsel sofort greift
      const liveInk = hexFromVar(container, '--ink', '#111111');
      const letters = Composite.allBodies(engine.world).filter(b => b.render.text);
      letters.sort((a, b) => a.render.text.z - b.render.text.z);
      letters.forEach(b => {
        const { content, font } = b.render.text;
        ctx.save();
        ctx.translate(b.position.x, b.position.y);
        ctx.rotate(b.angle);
        ctx.font = font;
        ctx.fillStyle = liveInk;
        ctx.fillText(content, 0, fontSize * 0.06);
        ctx.restore();
      });
    });

    // Touch/Maus: Buchstaben greifen und werfen
    const mouse = Mouse.create(render.canvas);
    const mc = MouseConstraint.create(engine, { mouse, constraint: { stiffness: 0.2, render: { visible: false } } });
    mouse.element.removeEventListener('mousewheel', mouse.mousewheel);
    mouse.element.removeEventListener('DOMMouseScroll', mouse.mousewheel);
    Composite.add(engine.world, mc);

    // ----- Gyro: Gravitation folgt der Geräteneigung -----
    const G = 2.4; // Grundstärke
    let gyroActive = false;
    function onOrient(e) {
      if (e.gamma == null && e.beta == null) return;
      gyroActive = true;
      // Bildschirm-Rotation berücksichtigen (Portrait/Landscape)
      const angle = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
      const rad = Math.PI / 180;
      let gx = Math.sin((e.gamma || 0) * rad);   // links/rechts kippen
      let gy = Math.sin((e.beta || 0) * rad);    // vor/zurück kippen
      if (angle === 90)       { const t = gx; gx = gy;  gy = -t; }
      else if (angle === -90 || angle === 270) { const t = gx; gx = -gy; gy = t; }
      else if (angle === 180) { gx = -gx; gy = -gy; }
      engine.world.gravity.x = gx * G;
      engine.world.gravity.y = gy * G;
    }
    function tryEnableGyro() {
      if (typeof DeviceOrientationEvent !== 'undefined' &&
          typeof DeviceOrientationEvent.requestPermission === 'function') {
        // iOS: Berechtigung braucht eine Nutzer-Geste
        DeviceOrientationEvent.requestPermission()
          .then(s => { if (s === 'granted') window.addEventListener('deviceorientation', onOrient); })
          .catch(() => {});
      }
    }
    // Android/ältere Browser: direkt lauschen (feuert nur, wenn Sensor vorhanden)
    if (typeof DeviceOrientationEvent === 'undefined' ||
        typeof DeviceOrientationEvent.requestPermission !== 'function') {
      window.addEventListener('deviceorientation', onOrient);
    } else {
      // iOS: beim ersten Antippen der Fläche um Erlaubnis fragen
      container.addEventListener('touchend', tryEnableGyro, { once: true, passive: true });
    }

    Render.run(render);
    container.__render = render;
    render.canvas.style.position = 'absolute';
    render.canvas.style.top = '0';
    render.canvas.style.left = '0';
    render.canvas.style.zIndex = '1';

    let paused = false;
    let last = performance.now();
    (function tick(now) {
      const dt = Math.min(32, (now || performance.now()) - last);
      last = now || performance.now();
      if (!paused) Engine.update(engine, dt);
      requestAnimationFrame(tick);
    })(performance.now());

    startSpawns();

    // Tweaks: Schrift/Case-Wechsel -> neu aufbauen
    let lastCase = caseMode();
    document.addEventListener('tweaks:apply', () => {
      const fam = headFamily();
      const cs = caseMode();
      if (fam === fontFamily && cs === lastCase) return;
      fontFamily = fam;
      lastCase = cs;
      words = applyCase(rawWords);
      fitFont();
      Composite.allBodies(engine.world).forEach(b => { if (b.render.text) Composite.remove(engine.world, b); });
      startedSpawn = false;
      startSpawns();
    });

    const io = new IntersectionObserver((entries) => {
      entries.forEach(e => {
        if (e.isIntersecting) { startSpawns(); paused = false; }
        else { paused = true; }
      });
    }, { threshold: 0 });
    io.observe(container);

    const resetBtn = document.querySelector(container.dataset.reset || '');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        Composite.allBodies(engine.world).forEach(b => { if (b.render.text) Composite.remove(engine.world, b); });
        startedSpawn = false;
        startSpawns();
      });
    }

    let rT;
    window.addEventListener('resize', () => {
      clearTimeout(rT);
      rT = setTimeout(() => {
        const w = container.clientWidth;
        if (Math.abs(w - width) < 40) return;
        Render.stop(render); paused = true;
        render.canvas.remove(); container.__fl = false;
        // Über den Router neu aufbauen (wählt Mobile- oder Desktop-Variante)
        (window.__flSetupAny || setup)(container);
      }, 250);
    });
  };
})();