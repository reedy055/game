// charts.js — v4 visuals
// Exports:
//   renderBarChart(canvas, values:number[])
//   renderCalendarHeatmap(containerEl, progress:{[day:string]:{points:number}})

export function renderBarChart(canvas, values) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;

  // Clear
  ctx.clearRect(0, 0, W, H);

  // Layout
  const padL = 18, padR = 8, padT = 12, padB = 28;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  // Scales
  const maxVal = Math.max(1, ...values);
  const stepX = innerW / Math.max(1, values.length);
  const barGap = Math.min(8, stepX * 0.25);
  const barW = Math.max(2, stepX - barGap);
  const radius = Math.min(10, barW * 0.45);

  // Gridlines (0, 25, 50, 75, 100%)
  ctx.save();
  ctx.translate(padL, padT);
  ctx.lineWidth = 1;
  for (let p = 0; p <= 1.0001; p += 0.25) {
    const y = innerH - p * innerH + 0.5; // crisp line
    ctx.strokeStyle = "rgba(230,233,242,0.08)";
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(innerW, y);
    ctx.stroke();
  }

  // Bars
  const grad = ctx.createLinearGradient(0, padT, 0, padT + innerH);
  grad.addColorStop(0, "#6CA0FF");
  grad.addColorStop(1, "#3A64CC");

  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    const h = (v / maxVal) * innerH;
    const x = i * stepX + (barGap / 2);
    const y = innerH - h;

    // Rounded rect bar
    ctx.fillStyle = grad;
    roundRect(ctx, x, y, barW, h, radius);
    ctx.fill();

    // Soft outer glow on taller bars
    if (h > innerH * 0.25) {
      ctx.save();
      ctx.shadowColor = "rgba(91,140,255,0.18)";
      ctx.shadowBlur = 12;
      ctx.shadowOffsetY = 0;
      ctx.fillStyle = "rgba(0,0,0,0)"; // shadow only
      roundRect(ctx, x, y, barW, h, radius);
      ctx.fill();
      ctx.restore();
    }
  }

  // X-axis ticks (start, mid, end) — subtle
  ctx.strokeStyle = "rgba(230,233,242,0.10)";
  ctx.beginPath();
  ctx.moveTo(0, innerH + 0.5);
  ctx.lineTo(innerW, innerH + 0.5);
  ctx.stroke();

  ctx.restore();

  // Helper: rounded rect path
  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(padL + x + rr, padT + y);
    ctx.arcTo(padL + x + w, padT + y, padL + x + w, padT + y + rr, rr);
    ctx.lineTo(padL + x + w, padT + y + h - rr);
    ctx.arcTo(padL + x + w, padT + y + h, padL + x + w - rr, padT + y + h, rr);
    ctx.lineTo(padL + x + rr, padT + y + h);
    ctx.arcTo(padL + x, padT + y + h, padL + x, padT + y + h - rr, rr);
    ctx.lineTo(padL + x, padT + y + rr);
    ctx.arcTo(padL + x, padT + y, padL + x + rr, padT + y, rr);
    ctx.closePath();
  }
}

export function renderCalendarHeatmap(container, progress) {
  if (!container) return;

  // Build last 90 days
  const days = [];
  const base = new Date();
  base.setHours(0, 0, 0, 0);
  for (let i = 89; i >= 0; i--) {
    const d = new Date(base);
    d.setDate(base.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }

  // Extract values (points per day)
  const vals = days.map(d => (progress && progress[d] ? (progress[d].points || 0) : 0));

  // Determine levels using adaptive thresholds
  const nonZero = vals.filter(v => v > 0).sort((a, b) => a - b);
  let t1 = 5, t2 = 20, t3 = 50, t4 = 100; // fallbacks
  if (nonZero.length >= 4) {
    t1 = quantile(nonZero, 0.35);
    t2 = quantile(nonZero, 0.60);
    t3 = quantile(nonZero, 0.80);
    t4 = quantile(nonZero, 0.95);
    // Ensure monotonic increase
    const uniq = [...new Set([t1, t2, t3, t4])];
    while (uniq.length < 4) uniq.push(uniq[uniq.length - 1] + 1);
    [t1, t2, t3, t4] = uniq;
  }

  // Render
  container.innerHTML = "";
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    const v = vals[i];

    const cell = document.createElement("div");
    cell.className = "hm-cell";

    if (v > 0) {
      if (v <= t1) cell.classList.add("hm-l1");
      else if (v <= t2) cell.classList.add("hm-l2");
      else if (v <= t3) cell.classList.add("hm-l3");
      else cell.classList.add("hm-l4");
    }

    cell.title = `${d}: ${v} pts`;
    container.appendChild(cell);
  }

  function quantile(arr, q) {
    const pos = (arr.length - 1) * q;
    const base = Math.floor(pos);
    const rest = pos - base;
    if (arr[base + 1] !== undefined) {
      return arr[base] + rest * (arr[base + 1] - arr[base]);
    } else {
      return arr[base];
    }
  }
}
