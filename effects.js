// effects.js — micro-confetti (lightweight, no deps)
export function confettiBurst(opts = {}) {
  const {
    count = 14,
    duration = 800,
    spread = Math.PI * 1.2,      // radians
    startV = 4.2,                 // initial velocity
    gravity = 0.12,               // downward accel
    x = window.innerWidth / 2,
    y = window.innerHeight * 0.22 // near header
  } = opts;

  const canvas = document.createElement("canvas");
  canvas.style.position = "fixed";
  canvas.style.inset = "0";
  canvas.style.pointerEvents = "none";
  canvas.style.zIndex = "9999";
  document.body.appendChild(canvas);

  const ctx = canvas.getContext("2d");
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  function resize() {
    canvas.width = Math.floor(window.innerWidth * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
  }
  resize();

  const colors = ["#5B8CFF", "#B85CFF", "#53FF88", "#E6E9F2"];
  const parts = [];
  const angle0 = -Math.PI / 2;

  for (let i = 0; i < count; i++) {
    const ang = angle0 + (Math.random() - 0.5) * spread;
    const speed = startV * (0.6 + Math.random() * 0.8);
    parts.push({
      x: x * dpr,
      y: y * dpr,
      vx: Math.cos(ang) * speed * dpr,
      vy: Math.sin(ang) * speed * dpr,
      w: (6 + Math.random() * 6) * dpr,
      h: (6 + Math.random() * 10) * dpr,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.4,
      color: colors[i % colors.length],
      alpha: 1
    });
  }

  let start = performance.now();
  function tick(t) {
    const elapsed = t - start;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (const p of parts) {
      p.vy += gravity * dpr;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      // fade out
      p.alpha = Math.max(0, 1 - elapsed / duration);
      ctx.save();
      ctx.globalAlpha = p.alpha;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      roundRect(ctx, -p.w / 2, -p.h / 2, p.w, p.h, Math.min(p.w, p.h) * 0.3);
      ctx.fill();
      ctx.restore();
    }

    if (elapsed < duration) {
      requestAnimationFrame(tick);
    } else {
      document.body.removeChild(canvas);
    }
  }
  requestAnimationFrame(tick);

  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + rr, rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
    ctx.lineTo(x + rr, y + h);
    ctx.arcTo(x, y + h, x, y + h - rr, rr);
    ctx.lineTo(x, y + rr);
    ctx.arcTo(x, y, x + rr, y, rr);
    ctx.closePath();
  }
}
