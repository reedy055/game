// app.js — core logic & UI wiring (v2)
// Implements: fixed bottom bar + "+" Quick Add drawer, Coins→Shop drawer,
// Weekly Boss quest (cumulative), Completed Today feed w/ Undo,
// no reroll (3 fixed daily challenges), simplified Settings, state migration v2.

import { loadState, saveState, clearAll, exportJSON, importJSON } from "./db.js";
import { renderBarChart, renderCalendarHeatmap } from "./charts.js";

/* =========================
   Utilities
========================= */
const $ = (sel, el=document) => el.querySelector(sel);
const $$ = (sel, el=document) => Array.from(el.querySelectorAll(sel));
const fmt = (n)=> new Intl.NumberFormat().format(n);

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(()=>t.classList.remove("show"), 1800);
}

function banner(msg) {
  const b = $("#banner");
  b.textContent = msg;
  b.classList.remove("hidden");
  requestAnimationFrame(()=>{
    b.classList.add("show");
    setTimeout(()=>{
      b.classList.remove("show");
      setTimeout(()=>b.classList.add("hidden"), 260);
    }, 1200);
  });
}

function vibrate(ms=40) {
  if (!state.settings.haptics) return;
  try { navigator.vibrate && navigator.vibrate(ms); } catch {}
}

function todayLocalDateStringAt(hour) {
  // "game day" = date after subtracting reset hour
  const now = new Date();
  const shifted = new Date(now.getTime() - hour*3600*1000);
  shifted.setHours(0,0,0,0);
  return shifted.toISOString().slice(0,10);
}
function dayDiff(a,b) {
  const da = new Date(a+"T00:00:00");
  const db = new Date(b+"T00:00:00");
  return Math.round((da - db)/(1000*60*60*24));
}
function uuid() { return crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)+Date.now(); }

// Monday (ISO) week start for a given "YYYY-MM-DD"
function weekStart(dayStr) {
  const d = new Date(dayStr+"T00:00:00");
  let wd = d.getDay(); // 0=Sun
  const delta = (wd === 0 ? -6 : 1 - wd); // move to Monday
  d.setDate(d.getDate()+delta);
  return d.toISOString().slice(0,10);
}

/* =========================
   Default State (v2)
========================= */
function defaultStateV2() {
  return {
    version: 2,
    settings: { resetHour: 4, haptics: true },
    profile: { coins: 0, bestStreak: 0, lastActiveDay: null },
    today: {
      day: null,
      points: 0,
      doneCounts: {},          // taskId -> count today
      challengeDone: {},       // challengeId -> true if done today
      lastMilestone: 0         // last Points milestone bannered (e.g., 0,100,200)
    },
    streak: { current: 0 },
    tasks: [],
    challenges: [],
    shop: [],
    assigned: {},              // { day: [challengeIds] }
    progress: {},              // { day: { points, completions, coinsEarned, coinsSpent } }
    logs: [],                  // append-only [{ts,type,id,name,points?,coins?,cost?,day}]
    weeklyBoss: {              // one quest per week
      weekStartDay: null,
      goals: [],               // [{id,label,target,tally,linkedTaskIds:[]}]
      completed: false
    }
  };
}

/* =========================
   Migration v1 -> v2
========================= */
function migrateToV2(old) {
  // If already v2, just return.
  if (old && old.version >= 2) return old;

  const state = defaultStateV2();
  if (!old) return state;

  // Carry over compatible fields
  state.profile = old.profile || state.profile;
  state.settings.resetHour = old.settings?.resetHour ?? state.settings.resetHour;
  state.settings.haptics = old.settings?.haptics ?? true;
  state.streak = old.streak || state.streak;
  state.tasks = old.tasks || [];
  state.challenges = old.challenges || [];
  state.shop = old.shop || [];
  state.assigned = old.assigned || {};
  state.progress = old.progress || {};
  state.logs = old.logs || [];
  // today.day/points if same day; else will be re-evaluated
  state.today.day = old.today?.day ?? null;
  state.today.points = old.today?.points ?? 0;
  state.today.doneCounts = old.today?.doneCounts || {};
  state.today.challengeDone = old.today?.challengeDone || {};
  state.today.lastMilestone = 0;

  // Weekly boss initialize
  const gd = todayLocalDateStringAt(state.settings.resetHour);
  state.weeklyBoss.weekStartDay = weekStart(gd);
  state.weeklyBoss.goals = []; // user can set templates later
  state.weeklyBoss.completed = false;

  state.version = 2;
  return state;
}

/* =========================
   Global state (in-memory)
========================= */
let state = null;

/* =========================
   Boot
========================= */
window.addEventListener("DOMContentLoaded", init);

async function init() {
  // Wire static UI handlers
  $("#pillStreak")?.addEventListener("click", ()=> switchView("statsView"));
  $("#pillCoins")?.addEventListener("click", openShopDrawer);

  $("#btnExport").addEventListener("click", onExport);
  $("#fileImport").addEventListener("change", onImport);
  $("#btnWipe").addEventListener("click", onWipe);
  $("#inpResetHour").addEventListener("change", onSettingChanged);
  $("#chkHaptics").addEventListener("change", onSettingChanged);

  $("#btnAddTask").addEventListener("click", ()=> openItemModal("task"));
  $("#btnAddChallenge").addEventListener("click", ()=> openItemModal("challenge"));
  $("#btnAddShop").addEventListener("click", ()=> openItemModal("shop"));

  // Boss templates (simple quick-setup)
  $("#btnBossTemplate1").addEventListener("click", ()=> applyBossTemplate("momentum"));
  $("#btnBossTemplate2").addEventListener("click", ()=> applyBossTemplate("social"));

  // Quick Add (+) wiring
  $("#tabAdd").addEventListener("click", openQuickAdd);
  $("#drawerQuickClose").addEventListener("click", closeQuickAdd);
  $("#drawerShopClose").addEventListener("click", closeShopDrawer);
  // Close drawers when clicking backdrop
  $("#drawerQuickAdd").addEventListener("click", (e)=> { if (e.target.id==="drawerQuickAdd") closeQuickAdd(); });
  $("#drawerShop").addEventListener("click", (e)=> { if (e.target.id==="drawerShop") closeShopDrawer(); });

  // Load or init state (with migration)
  const loaded = await loadState();
  state = migrateToV2(loaded || null);

  ensureGameDayRoll();        // also initializes weekly boss for week if needed
  renderAll();
  await saveState(state);
}

/* =========================
   Day & Streak Engine
========================= */
function ensureGameDayRoll() {
  const gd = todayLocalDateStringAt(state.settings.resetHour);
  // Weekly boss init if missing
  if (!state.weeklyBoss.weekStartDay) {
    state.weeklyBoss.weekStartDay = weekStart(gd);
  }
  // If first run
  if (state.today.day === null) {
    state.today.day = gd;
    ensureDailyAssignments();
    maybeResetWeeklyBoss(gd);
    return;
  }
  if (gd !== state.today.day) {
    // Day changed -> finalize previous day streak
    const prevDay = state.today.day;
    const prev = state.progress[prevDay];
    const hadCompletion = prev && prev.completions > 0;
    if (hadCompletion) {
      state.streak.current = (state.streak.current || 0) + 1;
      state.profile.bestStreak = Math.max(state.profile.bestStreak || 0, state.streak.current);
    } else {
      state.streak.current = 0;
    }
    // Reset today
    state.today.day = gd;
    state.today.points = 0;
    state.today.doneCounts = {};
    state.today.challengeDone = {};
    state.today.lastMilestone = 0;
    ensureDailyAssignments();
    maybeResetWeeklyBoss(gd);
  }
}

function ensureDailyAssignments() {
  const day = state.today.day;
  if (state.assigned[day] && state.assigned[day].length === 3) return;

  const pool = state.challenges.filter(c => c.active !== false);
  const ids = pool.map(x=>x.id);
  // Try to avoid yesterday's picks (if pool ≥6)
  const yest = new Date(day+"T00:00:00"); yest.setDate(yest.getDate()-1);
  const yKey = yest.toISOString().slice(0,10);
  const avoid = new Set(state.assigned[yKey] || []);
  const candidates = ids.filter(id => !avoid.has(id));
  const pickFrom = (candidates.length >= 3) ? candidates : ids;

  const selected = [];
  while (selected.length < 3 && pickFrom.length > 0) {
    const idx = Math.floor(Math.random() * pickFrom.length);
    const id = pickFrom.splice(idx,1)[0];
    if (!selected.includes(id)) selected.push(id);
  }
  state.assigned[day] = selected;
}

function maybeResetWeeklyBoss(currentDay) {
  const ws = state.weeklyBoss.weekStartDay || weekStart(currentDay);
  const needReset = weekStart(currentDay) !== ws;
  if (needReset) {
    // Start a fresh week, keep the same goals definitions but reset tallies
    state.weeklyBoss.weekStartDay = weekStart(currentDay);
    state.weeklyBoss.completed = false;
    for (const g of state.weeklyBoss.goals) g.tally = 0;
  }
}

/* =========================
   Render
========================= */
function renderAll() {
  ensureGameDayRoll();
  renderHeader();
  renderHome();
  renderStats();
  renderManage();
  renderSettings();
}

function renderHeader() {
  $("#statPoints").textContent = fmt(state.today.points || 0);
  $("#statCoins").textContent = fmt(state.profile.coins || 0);
  $("#statStreak").textContent = fmt(state.streak.current || 0);
  // XP-ish bar: fill up to 100 pts
  const pct = Math.max(0, Math.min(100, ((state.today.points||0) % 100)));
  $("#xpFill").style.width = `${pct}%`;
}

function renderHome() {
  // Hide legacy task card (we now show only Completed Today)
  const legacy = $("#legacyTasksCard");
  if (legacy) legacy.style.display = "none";

  // Daily challenges
  const list = $("#dailyList");
  list.innerHTML = "";
  const day = state.today.day;
  const assigned = state.assigned[day] || [];
  if (assigned.length === 0) {
    const d = document.createElement("div");
    d.className = "placeholder";
    d.textContent = "No challenges assigned. Add some in Manage → Challenge Pool.";
    list.appendChild(d);
  } else {
    assigned.forEach(id=>{
      const ch = state.challenges.find(x=>x.id===id);
      if (!ch) return;
      const done = !!state.today.challengeDone[id];
      const card = document.createElement("div");
      card.className = "tile" + (done ? " done" : "");
      const meta = document.createElement("div");
      meta.className = "meta";
      const title = document.createElement("div");
      title.className = "title";
      title.textContent = ch.name;
      const sub = document.createElement("div");
      sub.className = "sub";
      const pts = ch.points ?? 10;
      const coins = ch.coinsEarned ?? pts;
      sub.textContent = `+${pts} pts, +${coins} coins`;
      meta.appendChild(title); meta.appendChild(sub);

      const btn = document.createElement("button");
      btn.className = "btn small";
      btn.textContent = done ? "Undo" : "Do";
      btn.addEventListener("click", ()=> toggleChallenge(ch));

      card.appendChild(meta); card.appendChild(btn);
      list.appendChild(card);
    });
  }

  // Weekly Boss
  renderBoss();

  // Completed Today feed
  renderCompletedFeed();
}

function renderBoss() {
  const ring = $("#bossRing");
  const goalsWrap = $("#bossGoals");
  goalsWrap.innerHTML = "";

  // Compute progress
  const goals = state.weeklyBoss.goals || [];
  let totalTarget = 0, totalTally = 0;
  for (const g of goals) { totalTarget += (g.target||0); totalTally += Math.min(g.tally||0, g.target||0); }
  const pct = totalTarget>0 ? Math.round((totalTally/totalTarget)*100) : 0;

  drawBossRing(ring, pct);

  if (goals.length === 0) {
    const d = document.createElement("div");
    d.className = "placeholder";
    d.textContent = "Use a Boss template in Manage (bottom of Manage tab).";
    goalsWrap.appendChild(d);
    return;
  }

  for (const g of goals) {
    const row = document.createElement("div");
    row.className = "boss-goal";
    const top = document.createElement("div");
    top.className = "row";
    const label = document.createElement("div");
    label.className = "label";
    label.textContent = g.label;
    const meta = document.createElement("div");
    meta.className = "meta";
    const clamped = Math.min(g.tally||0, g.target||0);
    meta.textContent = `${clamped}/${g.target}`;
    top.appendChild(label); top.appendChild(meta);
    const bar = document.createElement("div");
    bar.className = "boss-bar";
    const fill = document.createElement("div");
    const gpct = g.target>0 ? Math.round((clamped/g.target)*100) : 0;
    fill.style.width = `${gpct}%`;
    bar.appendChild(fill);
    row.appendChild(top); row.appendChild(bar);
    goalsWrap.appendChild(row);
  }
}

function drawBossRing(canvas, pct) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  const cx = W/2, cy = H/2, r = Math.min(W,H)/2 - 14;
  ctx.clearRect(0,0,W,H);

  // Background circle
  ctx.lineWidth = 14;
  ctx.strokeStyle = "#1b2347";
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI*2);
  ctx.stroke();

  // Gradient arc (blue -> purple)
  const grad = ctx.createLinearGradient(0,0,W,H);
  grad.addColorStop(0, "#5B8CFF");
  grad.addColorStop(1, "#B85CFF");
  ctx.strokeStyle = grad;

  const start = -Math.PI/2;
  const end = start + (Math.PI*2)*(pct/100);
  ctx.beginPath();
  ctx.arc(cx, cy, r, start, end);
  ctx.stroke();

  // Text
  ctx.fillStyle = "rgba(230,233,242,.85)";
  ctx.font = "24px system-ui, -apple-system, Segoe UI, Roboto";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(`${pct}%`, cx, cy);
}

function renderCompletedFeed() {
  const wrap = $("#feedToday");
  wrap.innerHTML = "";

  const today = state.today.day;
  // Show only today's completions (task/challenge), newest first
  const items = state.logs.filter(l => l.day === today && (l.type==='task' || l.type==='challenge'));
  if (items.length === 0) {
    const d = document.createElement("div");
    d.className = "placeholder";
    d.textContent = "Nothing completed yet. Tap the + to get started.";
    wrap.appendChild(d);
    return;
  }
  items.forEach((log, idx) => {
    const row = document.createElement("div");
    row.className = "feed-item";
    const left = document.createElement("div");
    left.className = "feed-left";
    const title = document.createElement("div");
    title.className = "feed-title";
    title.textContent = log.name;
    const sub = document.createElement("div");
    sub.className = "feed-sub";
    if (log.type==='task') sub.textContent = `Task • +${log.points} pts, +${log.coins} coins`;
    else sub.textContent = `Challenge • +${log.points} pts, +${log.coins} coins`;
    left.appendChild(title); left.appendChild(sub);

    const right = document.createElement("div");
    right.className = "feed-right";
    const undo = document.createElement("button");
    undo.className = "chip-undo";
    undo.textContent = "Undo";
    undo.addEventListener("click", ()=> undoLogEntry(log));
    right.appendChild(undo);

    row.appendChild(left); row.appendChild(right);
    // newest first: logs are unshifted at grant(), so they already are newest-first
    wrap.appendChild(row);
  });
}

function renderStats() {
  // Streak
  $("#streakBig").textContent = fmt(state.streak.current||0);
  $("#bestStreak").textContent = fmt(state.profile.bestStreak||0);
  // completions/week
  const last7 = getLastNDays(7);
  let cmp = 0;
  for (const d of last7) {
    const p = state.progress[d];
    if (p) cmp += (p.completions || 0);
  }
  $("#cmpWeek").textContent = fmt(cmp);

  // 30-day points bar chart
  const last30 = getLastNDays(30);
  const vals = last30.map(d=> (state.progress[d]?.points) || 0);
  const cvs = $("#bar30");
  const r = window.devicePixelRatio || 1;
  cvs.style.width = "100%";
  const w = cvs.clientWidth || 600;
  const h = 260;
  cvs.width = Math.floor(w * r);
  cvs.height = Math.floor(h * r);
  cvs.getContext("2d").setTransform(r, 0, 0, r, 0, 0);
  renderBarChart(cvs, vals);

  // Heatmap (90 days)
  renderCalendarHeatmap($("#heatmap"), state.progress);
}

function renderManage() {
  renderAdminList("task");
  renderAdminList("challenge");
  renderAdminList("shop");
  renderBossManage(); // simple template actions UI
}

function renderSettings() {
  $("#inpResetHour").value = state.settings.resetHour;
  $("#chkHaptics").checked = !!state.settings.haptics;
}

/* =========================
   Actions: Grant/Spend/Undo
========================= */
function ensureProgressBucket(day) {
  if (!state.progress[day]) {
    state.progress[day] = { points: 0, completions: 0, coinsEarned: 0, coinsSpent: 0 };
  }
  return state.progress[day];
}

async function grant(points, coins, name, type, id) {
  const day = state.today.day;
  state.today.points = (state.today.points || 0) + points;
  state.profile.coins = (state.profile.coins || 0) + coins;

  // Milestone banner at 100, 200, 300 ...
  const nextMilestone = Math.floor((state.today.points)/100)*100;
  if (nextMilestone > 0 && nextMilestone > (state.today.lastMilestone||0)) {
    state.today.lastMilestone = nextMilestone;
    banner(`Milestone: ${nextMilestone} points today!`);
  }

  const bucket = ensureProgressBucket(day);
  bucket.points += points;
  bucket.coinsEarned += coins;
  bucket.completions += 1;

  const log = { ts:new Date().toISOString(), type, id, name, points, coins, day };
  state.logs.unshift(log);

  // Weekly boss tally: if this id is linked to any goal, increment
  tallyWeeklyBossForCompletion(id);

  vibrate(40);
  toast(`+${points} pts, +${coins} coins`);
  renderHeader();
  await saveState(state);
}

async function spend(cost, name, id) {
  const day = state.today.day;
  state.profile.coins = Math.max(0, (state.profile.coins || 0) - cost);
  const bucket = ensureProgressBucket(day);
  bucket.coinsSpent += cost;
  state.logs.unshift({ ts:new Date().toISOString(), type:'purchase', id, name, cost, day });
  vibrate(20);
  toast(`Spent ${cost} coins`);
  renderHeader();
  await saveState(state);
}

async function toggleChallenge(ch) {
  ensureGameDayRoll();
  const id = ch.id;
  const done = !!state.today.challengeDone[id];
  const pts = ch.points ?? 10;
  const coins = ch.coinsEarned ?? pts;
  if (!done) {
    state.today.challengeDone[id] = true;
    await grant(pts, coins, ch.name, "challenge", id);
  } else {
    // undo
    delete state.today.challengeDone[id];
    await reverseGrant(pts, coins, "challenge", id);
  }
  renderHeader(); renderHome(); renderStats();
}

async function reverseGrant(pts, coins, kind, id) {
  state.today.points = Math.max(0, (state.today.points||0) - pts);
  state.profile.coins = Math.max(0, (state.profile.coins||0) - coins);
  const bucket = ensureProgressBucket(state.today.day);
  bucket.points = Math.max(0, bucket.points - pts);
  bucket.coinsEarned = Math.max(0, bucket.coinsEarned - coins);
  bucket.completions = Math.max(0, bucket.completions - 1);
  // remove first matching log entry for today (most recent)
  const i = state.logs.findIndex(l => l.day===state.today.day && l.type===kind && l.id===id && l.points===pts && l.coins===coins);
  if (i>=0) state.logs.splice(i,1);

  // Weekly boss reverse tally
  reverseWeeklyBossForCompletion(id);

  toast("Undone");
  vibrate(10);
  await saveState(state);
}

async function undoLogEntry(log) {
  // Only allow same-day undo
  if (log.day !== state.today.day) { toast("Can only undo today"); return; }
  if (log.type==='task') {
    // decrement task count, if >0
    const count = state.today.doneCounts[log.id] || 0;
    if (count > 0) state.today.doneCounts[log.id] = count - 1;
    await reverseGrant(log.points, log.coins, 'task', log.id);
  } else if (log.type==='challenge') {
    if (state.today.challengeDone[log.id]) delete state.today.challengeDone[log.id];
    await reverseGrant(log.points, log.coins, 'challenge', log.id);
  }
  renderHome(); renderStats();
}

/* =========================
   Weekly Boss tally helpers
========================= */
function tallyWeeklyBossForCompletion(itemId) {
  const goals = state.weeklyBoss.goals || [];
  let allComplete = true;
  for (const g of goals) {
    const linked = g.linkedTaskIds || [];
    if (linked.includes(itemId)) {
      g.tally = Math.min((g.tally||0)+1, g.target||0);
    }
    if ((g.tally||0) < (g.target||0)) allComplete = false;
  }
  if (!state.weeklyBoss.completed && allComplete && goals.length>0) {
    state.weeklyBoss.completed = true;
    state.profile.coins = (state.profile.coins||0) + 100; // boss bonus
    toast("+100 coins • Boss defeated!");
    banner("WEEKLY BOSS DEFEATED!");
  }
}
function reverseWeeklyBossForCompletion(itemId) {
  const goals = state.weeklyBoss.goals || [];
  // Reverse only if tally > 0 and this item was linked
  for (const g of goals) {
    const linked = g.linkedTaskIds || [];
    if (linked.includes(itemId) && (g.tally||0) > 0) {
      g.tally = g.tally - 1;
    }
  }
  // If any goal now below target, boss no longer completed
  if (state.weeklyBoss.completed) {
    for (const g of goals) {
      if ((g.tally||0) < (g.target||0)) { state.weeklyBoss.completed = false; break; }
    }
  }
}

/* =========================
   Quick Add (+) & Shop drawers
========================= */
function openQuickAdd() {
  renderQuickAdd();
  $("#drawerQuickAdd").classList.remove("hidden");
}
function closeQuickAdd() {
  $("#drawerQuickAdd").classList.add("hidden");
}

function renderQuickAdd() {
  const favRow = $("#quickFavsRow");
  const favWrap = $("#quickFavs");
  const grid = $("#quickTaskList");
  favWrap.innerHTML = "";
  grid.innerHTML = "";

  const tasks = state.tasks.filter(t=>t.active!==false);
  if (tasks.length === 0) {
    const d = document.createElement("div");
    d.className = "placeholder";
    d.textContent = "No tasks yet. Add some in Manage → Tasks.";
    grid.appendChild(d);
    favRow.classList.add("hidden");
    return;
  }

  // Favorites: top 3 tasks by total appearances in logs
  const counts = new Map();
  for (const l of state.logs) {
    if (l.type==='task') counts.set(l.id, (counts.get(l.id)||0) + 1);
  }
  const favs = tasks
    .slice()
    .sort((a,b)=> (counts.get(b.id)||0) - (counts.get(a.id)||0))
    .slice(0,3);
  if (favs.length > 0) {
    favRow.classList.remove("hidden");
    for (const t of favs) {
      const chip = document.createElement("button");
      chip.className = "quick-chip";
      chip.textContent = t.name;
      chip.addEventListener("click", ()=> quickAddTask(t));
      favWrap.appendChild(chip);
    }
  } else {
    favRow.classList.add("hidden");
  }

  // All tasks grid
  for (const t of tasks) {
    const cap = t.perDayCap || 1;
    const count = state.today.doneCounts[t.id] || 0;
    const done = count >= cap;

    const card = document.createElement("button");
    card.className = "quick-card";
    card.disabled = done;
    card.innerHTML = `<div>${t.name}</div><div class="sub">${done ? "Done ✓" : `+${t.points??10} pts`}</div>`;
    card.addEventListener("click", ()=> quickAddTask(t));
    grid.appendChild(card);
  }
}

async function quickAddTask(t) {
  const cap = t.perDayCap || 1;
  const count = state.today.doneCounts[t.id] || 0;
  if (count >= cap) { toast("Reached today's cap"); return; }
  state.today.doneCounts[t.id] = count + 1;
  await grant(t.points ?? 10, t.coinsEarned ?? (t.points ?? 10), t.name, "task", t.id);
  renderHeader(); renderHome(); renderStats(); renderQuickAdd();
}

function openShopDrawer() {
  renderShopDrawer();
  $("#drawerShop").classList.remove("hidden");
}
function closeShopDrawer() {
  $("#drawerShop").classList.add("hidden");
}
function renderShopDrawer() {
  const wrap = $("#shopDrawerList");
  wrap.innerHTML = "";
  const items = state.shop.filter(s=>s.active!==false);
  if (items.length === 0) {
    const d = document.createElement("div");
    d.className = "placeholder";
    d.textContent = "No rewards yet. Add some in Manage → Shop.";
    wrap.appendChild(d);
    return;
  }
  for (const s of items) {
    const row = document.createElement("div");
    row.className = "shop-card";
    const title = document.createElement("div");
    title.className="shop-title"; title.textContent = s.name;
    const cost = document.createElement("div");
    cost.className="shop-cost"; cost.textContent = `${s.cost} coins`;
    const btn = document.createElement("button");
    btn.className="btn small"; btn.textContent="Buy";

    const cooldown = s.cooldownDays || 0;
    const last = s.lastBoughtDay || null;
    const blocked = cooldown>0 && last && dayDiff(state.today.day, last) <= cooldown-1;
    if (blocked) {
      btn.disabled = true;
      cost.textContent += ` • ${cooldown}-day cooldown`;
    }
    btn.addEventListener("click", async ()=>{
      const have = state.profile.coins||0;
      if (have < (s.cost||0)) { toast("Not enough coins"); vibrate(8); return; }
      await spend(s.cost||0, s.name, s.id);
      s.lastBoughtDay = state.today.day;
      await saveState(state);
      renderHeader(); renderShopDrawer(); renderStats();
    });

    row.appendChild(title); row.appendChild(cost); row.appendChild(btn);
    wrap.appendChild(row);
  }
}

/* =========================
   Manage CRUD (Tasks/Challenges/Shop)
========================= */
function renderAdminList(kind) {
  const targetId = kind==="task" ? "#manageTasks" : kind==="challenge" ? "#manageChallenges" : "#manageShop";
  const el = $(targetId);
  el.innerHTML = "";
  const items = kind==="task" ? state.tasks : kind==="challenge" ? state.challenges : state.shop;
  if (!items || items.length===0) {
    const d = document.createElement("div");
    d.className="placeholder";
    d.textContent = `No ${kind}s yet. Click “+ Add”.`;
    el.appendChild(d);
    return;
  }
  items.forEach(item=>{
    const row = document.createElement("div");
    row.className = "tile";
    const meta = document.createElement("div"); meta.className="meta";
    const title = document.createElement("div"); title.className="title"; title.textContent = item.name;
    const sub = document.createElement("div"); sub.className="sub";
    if (kind!=="shop") {
      const pts = item.points ?? 10;
      const coins = item.coinsEarned ?? pts;
      const cap = item.perDayCap || 1;
      sub.textContent = `+${pts} pts, +${coins} coins • cap ${cap}/day`;
    } else {
      sub.textContent = `cost ${item.cost} coins${item.cooldownDays?` • ${item.cooldownDays}-day cooldown`:''}`;
    }
    meta.appendChild(title); meta.appendChild(sub);

    const actions = document.createElement("div"); actions.className="row";
    const btnEdit = document.createElement("button"); btnEdit.className="btn ghost small"; btnEdit.textContent="Edit";
    btnEdit.addEventListener("click", ()=> openItemModal(kind, item));
    const btnToggle = document.createElement("button"); btnToggle.className="btn small";
    const active = item.active !== false;
    btnToggle.textContent = active ? "Archive" : "Activate";
    btnToggle.addEventListener("click", async ()=>{
      item.active = !active;
      await saveState(state); renderManage(); renderHome();
    });
    actions.appendChild(btnEdit); actions.appendChild(btnToggle);

    row.appendChild(meta); row.appendChild(actions);
    el.appendChild(row);
  });
}

function openItemModal(kind, existing=null) {
  const modal = $("#modal");
  const mTitle = $("#modalTitle");
  const mBody = $("#modalBody");
  const btnOk = $("#modalOk");
  const btnCancel = $("#modalCancel");
  const btnClose = $("#modalClose");

  const isEdit = !!existing;
  mTitle.textContent = (isEdit ? "Edit " : "Add ") + (kind==="task" ? "Task" : kind==="challenge" ? "Challenge" : "Shop Item");
  mBody.innerHTML = "";

  // Build form
  const name = inputField("Name", existing?.name || "");
  mBody.appendChild(name.wrap);

  if (kind !== "shop") {
    const points = numberField("Points", existing?.points ?? 10, 1, 999);
    const coins = numberField("Coins (optional, default = points)", existing?.coinsEarned ?? "", 0, 999, true);
    const cap = (kind==="task") ? numberField("Per-day cap", existing?.perDayCap ?? 1, 1, 10) : null;
    if (cap) mBody.appendChild(cap.wrap);
    mBody.appendChild(points.wrap);
    mBody.appendChild(coins.wrap);

    btnOk.onclick = async ()=>{
      const n = name.input.value.trim();
      if (!n) { toast("Name required"); return; }
      const item = existing || { id: uuid(), active: true };
      item.name = n;
      item.points = clampInt(points.input.value || "10", 1, 999);
      const cc = coins.input.value.trim();
      item.coinsEarned = cc==="" ? item.points : clampInt(cc, 0, 999);
      if (cap) item.perDayCap = clampInt(cap.input.value || "1", 1, 10);

      if (!existing) {
        if (kind==="task") state.tasks.push(item);
        else state.challenges.push(item);
      }
      await saveState(state);
      closeModal();
      renderManage(); renderHome();
      toast(isEdit?"Updated":"Added");
    };

  } else {
    const cost = numberField("Cost (coins)", existing?.cost ?? 20, 1, 999);
    const cd = numberField("Cooldown days (optional)", existing?.cooldownDays ?? "", 0, 30, true);
    mBody.appendChild(cost.wrap); mBody.appendChild(cd.wrap);

    btnOk.onclick = async ()=>{
      const n = name.input.value.trim();
      if (!n) { toast("Name required"); return; }
      const item = existing || { id: uuid(), active: true };
      item.name = n;
      item.cost = clampInt(cost.input.value || "20", 1, 999);
      const cdd = cd.input.value.trim();
      item.cooldownDays = cdd==="" ? undefined : clampInt(cdd, 0, 30);
      if (!existing) state.shop.push(item);
      await saveState(state);
      closeModal();
      renderManage(); renderHome();
      toast(isEdit?"Updated":"Added");
    };
  }

  btnCancel.onclick = closeModal;
  btnClose.onclick = closeModal;

  modal.classList.remove("hidden");

  function closeModal(){ modal.classList.add("hidden"); }
  function clampInt(v, min, max){ const n = parseInt(v,10); return isNaN(n)?min: Math.max(min, Math.min(max, n)); }
  function inputField(label, val=""){
    const wrap = document.createElement("label"); wrap.textContent = label;
    wrap.style.display="grid"; wrap.style.gap="6px"; wrap.style.color="var(--muted)";
    const input = document.createElement("input"); input.type="text"; input.value = val;
    input.style.background="#0F1630"; input.style.border="1px solid var(--border)"; input.style.color="var(--text)";
    input.style.borderRadius="10px"; input.style.padding="12px 12px"; input.style.fontSize="16px";
    wrap.appendChild(input); return {wrap, input};
  }
  function numberField(label, val=0, min=0, max=999, allowEmpty=false){
    const wrap = document.createElement("label"); wrap.textContent = label;
    wrap.style.display="grid"; wrap.style.gap="6px"; wrap.style.color="var(--muted)";
    const input = document.createElement("input"); input.type="number"; if (allowEmpty && val==="") input.value=""; else input.value = String(val);
    input.min = String(min); input.max = String(max);
    input.style.background="#0F1630"; input.style.border="1px solid var(--border)"; input.style.color="var(--text)";
    input.style.borderRadius="10px"; input.style.padding="12px 12px"; input.style.fontSize="16px";
    wrap.appendChild(input); return {wrap, input};
  }
}

/* =========================
   Boss Manage (Templates)
========================= */
function renderBossManage() {
  const wrap = $("#manageBoss");
  wrap.innerHTML = "";

  if (!state.weeklyBoss.goals || state.weeklyBoss.goals.length===0) {
    const d = document.createElement("div");
    d.className = "placeholder";
    d.textContent = "Use a template above to quickly create a weekly boss (linked to your Tasks).";
    wrap.appendChild(d);
    return;
  }
  // Show goals summary (read-only for now)
  for (const g of state.weeklyBoss.goals) {
    const row = document.createElement("div");
    row.className = "tile";
    const meta = document.createElement("div"); meta.className='meta';
    const t = document.createElement("div"); t.className='title'; t.textContent = g.label;
    const s = document.createElement("div"); s.className='sub'; s.textContent = `Target: ${g.target} • Linked tasks: ${g.linkedTaskIds.length}`;
    meta.appendChild(t); meta.appendChild(s);
    row.appendChild(meta);
    wrap.appendChild(row);
  }
}

async function applyBossTemplate(kind) {
  // Map by task name for convenience
  const byName = new Map();
  for (const t of state.tasks) byName.set(t.name.toLowerCase(), t.id);

  let goals = [];
  if (kind==="momentum") {
    // Template expects common task names; if missing, link none (user can rename tasks to match).
    goals = [
      {
        id: uuid(),
        label: "Talk to 10 people",
        target: 10,
        tally: 0,
        linkedTaskIds: byName.has("talk to someone") ? [byName.get("talk to someone")] : []
      },
      {
        id: uuid(),
        label: "Focused work 90 min",
        target: 2, // 2 x 45-min study
        tally: 0,
        linkedTaskIds: byName.has("45-min study") ? [byName.get("45-min study")] : []
      },
      {
        id: uuid(),
        label: "Workouts x3",
        target: 3,
        tally: 0,
        linkedTaskIds: byName.has("full workout") ? [byName.get("full workout")] : []
      }
    ];
  } else if (kind==="social") {
    goals = [
      {
        id: uuid(),
        label: "Meaningful chats x10",
        target: 10,
        tally: 0,
        linkedTaskIds: byName.has("talk to someone") ? [byName.get("talk to someone")] : []
      },
      {
        id: uuid(),
        label: "Call family x2",
        target: 2,
        tally: 0,
        linkedTaskIds: byName.has("call parents") ? [byName.get("call parents")] : []
      }
    ];
  }

  const gd = state.today.day || todayLocalDateStringAt(state.settings.resetHour);
  state.weeklyBoss.weekStartDay = weekStart(gd);
  state.weeklyBoss.goals = goals;
  state.weeklyBoss.completed = false;

  await saveState(state);
  renderBoss(); renderBossManage();
  toast("Boss template applied");
}

/* =========================
   Settings & Data ops
========================= */
async function onSettingChanged() {
  state.settings.resetHour = clampInt($("#inpResetHour").value || "4", 0, 23);
  state.settings.haptics = !!$("#chkHaptics").checked;
  await saveState(state);
  toast("Saved");
  ensureGameDayRoll();
  renderAll();

  function clampInt(v, min, max){ const n = parseInt(v,10); return isNaN(n)?min: Math.max(min, Math.min(max, n)); }
}

async function onExport() {
  const text = await exportJSON();
  const blob = new Blob([text], {type:"application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `liferpg-export-${Date.now()}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 500);
  toast("Exported");
}

async function onImport(e) {
  const f = e.target.files[0];
  if (!f) return;
  const text = await f.text();
  try {
    const obj = await importJSON(text);
    state = migrateToV2(obj);
    ensureGameDayRoll();
    renderAll();
    toast("Imported");
  } catch(err) {
    toast("Import failed");
  }
  // reset input so same file can be chosen again
  e.target.value = "";
}

async function onWipe() {
  if (!confirm("This will erase all data. Continue?")) return;
  await clearAll();
  state = defaultStateV2();
  ensureGameDayRoll();
  await saveState(state);
  renderAll();
  toast("Wiped");
}

/* =========================
   View switch (optional)
========================= */
function switchView(id) {
  const tabs = $$(".tabbar .tab");
  const views = $$(".view");
  tabs.forEach(b=>{
    const target = b.getAttribute("data-target");
    b.classList.toggle("active", target===id);
    b.setAttribute("aria-selected", target===id ? "true" : "false");
  });
  views.forEach(v=> v.classList.toggle("active", v.id===id));
  if (id==="statsView") renderStats();
}

/* =========================
   Helpers
========================= */
function getLastNDays(n) {
  const arr = [];
  const today = new Date();
  today.setHours(0,0,0,0);
  for (let i=n-1; i>=0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate()-i);
    arr.push(d.toISOString().slice(0,10));
  }
  return arr;
}
