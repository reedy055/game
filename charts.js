// charts.js — lightweight renderers (no libs)

// --- 30-day bar chart ---
export function renderBarChart(canvas, values = [], opts = {}) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  // Clear
  ctx.clearRect(0,0,W,H);

  // Theme
  const bg = "#1e1e2f";
  const grid = "rgba(255,255,255,0.08)";
  const bar = "#5B8CFF";
  const label = "rgba(230,233,242,0.8)";

  // Padding
  const PAD_L = 28, PAD_R = 10, PAD_T = 16, PAD_B = 24;

  // Background
  ctx.fillStyle = bg;
  roundRect(ctx, 0, 0, W, H, 10);
  ctx.fill();

  // Axes/grid
  const maxVal = Math.max(10, Math.max(...values, 0));
  const steps = 4;
  ctx.strokeStyle = grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i <= steps; i++) {
    const y = PAD_T + (H-PAD_T-PAD_B) * (i/steps);
    ctx.moveTo(PAD_L, y);
    ctx.lineTo(W-PAD_R, y);
  }
  ctx.stroke();

  // Bars
  const n = values.length;
  if (n === 0) return;
  const usableW = W - PAD_L - PAD_R;
  const gap = 2;
  const barW = Math.max(2, Math.floor((usableW - gap*(n-1))/n));

  ctx.fillStyle = bar;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    const h = (v / maxVal) * (H - PAD_T - PAD_B);
    const x = PAD_L + i * (barW + gap);
    const y = H - PAD_B - h;
    roundRect(ctx, x, y, barW, h, 3);
    ctx.fill();
  }

  // Y labels (0 and max)
  ctx.fillStyle = label;
  ctx.font = "12px system-ui, -apple-system, Segoe UI, Roboto";
  ctx.textAlign = "right";
  ctx.fillText(String(0), PAD_L - 6, H - PAD_B + 12);
  ctx.fillText(String(maxVal), PAD_L - 6, PAD_T + 4);
}

function roundRect(ctx, x, y, w, h, r){
  ctx.beginPath();
  ctx.moveTo(x+r, y);
  ctx.arcTo(x+w, y, x+w, y+h, r);
  ctx.arcTo(x+w, y+h, x, y+h, r);
  ctx.arcTo(x, y+h, x, y, r);
  ctx.arcTo(x, y, x+w, y, r);
  ctx.closePath();
}

// --- 90-day heatmap ---
export function renderCalendarHeatmap(container, progressByDay) {
  if (!container) return;
  container.innerHTML = "";
  // Build last 90 days array (oldest -> newest)
  const days = [];
  const today = new Date();
  today.setHours(0,0,0,0);
  for (let i = 89; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const key = d.toISOString().slice(0,10);
    const points = (progressByDay && progressByDay[key] && progressByDay[key].points) || 0;
    days.push({ key, points });
  }

  // thresholds for coloring
  const t1 = 10, t2 = 30, t3 = 60;
  for (const day of days) {
    const cell = document.createElement("div");
    cell.className = "hm-cell";
    if (day.points > 0 && day.points <= t1) cell.classList.add("hm-l1");
    if (day.points > t1 && day.points <= t2) cell.classList.add("hm-l2");
    if (day.points > t2 && day.points <= t3) cell.classList.add("hm-l3");
    if (day.points > t3) cell.classList.add("hm-l4");
    cell.title = `${day.key}: ${day.points} pts`;
    container.appendChild(cell);
  }
}
