// app.js — core logic & UI wiring
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

function vibrate(ms=40) {
  if (!state.settings.haptics) return;
  try { navigator.vibrate && navigator.vibrate(ms); } catch {}
}

function todayLocalDateStringAt(hour) {
  // "game day" = date after subtracting reset hour
  const now = new Date();
  const t = new Date(now.getTime());
  // shift by reset hour
  const offsetMs = hour * 60 * 60 * 1000;
  const shifted = new Date(now.getTime() - offsetMs);
  shifted.setHours(0,0,0,0);
  return shifted.toISOString().slice(0,10);
}

function dayDiff(a,b) {
  // a,b: "YYYY-MM-DD"
  const da = new Date(a+"T00:00:00");
  const db = new Date(b+"T00:00:00");
  return Math.round((da - db)/(1000*60*60*24));
}

function uuid() { return crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)+Date.now(); }

/* =========================
   Default State
========================= */
function defaultState() {
  return {
    version: 1,
    settings: { resetHour: 4, rerollCost: 20, haptics: true },
    profile: { coins: 0, bestStreak: 0, lastActiveDay: null },
    today: { day: null, points: 0, rerolled: false, doneCounts: {}, challengeDone: {} },
    streak: { current: 0 },
    tasks: [],
    challenges: [],
    shop: [],
    assigned: {},              // { day: [challengeIds] }
    progress: {},              // { day: { points, completions, coinsEarned, coinsSpent } }
    logs: []                   // append-only
  };
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
  // Wire some static UI handlers
  $("#pillStreak")?.addEventListener("click", ()=> switchView("statsView"));
  $("#btnReroll").addEventListener("click", onReroll);
  $("#btnExport").addEventListener("click", onExport);
  $("#fileImport").addEventListener("change", onImport);
  $("#btnWipe").addEventListener("click", onWipe);
  $("#inpResetHour").addEventListener("change", onSettingChanged);
  $("#inpRerollCost").addEventListener("change", onSettingChanged);
  $("#chkHaptics").addEventListener("change", onSettingChanged);

  $("#btnAddTask").addEventListener("click", ()=> openItemModal("task"));
  $("#btnAddChallenge").addEventListener("click", ()=> openItemModal("challenge"));
  $("#btnAddShop").addEventListener("click", ()=> openItemModal("shop"));

  // Load or init state
  const loaded = await loadState();
  state = loaded || defaultState();

  ensureGameDayRoll();
  renderAll();
  await saveState(state);
}

/* =========================
   Day & Streak Engine
========================= */
function ensureGameDayRoll() {
  const gd = todayLocalDateStringAt(state.settings.resetHour);
  if (state.today.day === null) {
    // first run
    state.today.day = gd;
    ensureDailyAssignments();
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
    state.today.rerolled = false;
    state.today.doneCounts = {};
    state.today.challengeDone = {};
    ensureDailyAssignments();
  }
}

function ensureDailyAssignments() {
  const day = state.today.day;
  if (state.assigned[day] && state.assigned[day].length === 3) return;

  const pool = state.challenges.filter(c => c.active !== false);
  const ids = pool.map(x=>x.id);
  // Pick up to 3 unique; prefer avoiding yesterday's if possible
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

  // Reroll button
  const cost = state.settings.rerollCost || 0;
  const canReroll = !state.today.rerolled && cost <= (state.profile.coins||0) && (assigned.length>0);
  const btnR = $("#btnReroll");
  btnR.disabled = !canReroll;
  btnR.textContent = `↻ Reroll (${cost}🪙)`;

  // Tasks
  const tl = $("#taskList");
  tl.innerHTML = "";
  const tasks = state.tasks.filter(t=>t.active!==false);
  if (tasks.length===0) {
    const d = document.createElement("div");
    d.className="placeholder"; d.textContent="Add tasks in Manage → Tasks.";
    tl.appendChild(d);
  } else {
    tasks.forEach(t=>{
      const tile = document.createElement("div");
      const cap = t.perDayCap || 1;
      const count = state.today.doneCounts[t.id] || 0;
      const isDone = count >= cap;

      tile.className = "tile" + (isDone ? " done" : "");
      const meta = document.createElement("div");
      meta.className = "meta";
      const title = document.createElement("div");
      title.className = "title"; title.textContent = t.name;
      const sub = document.createElement("div");
      sub.className = "sub";
      const pts = t.points ?? 10;
      const coins = t.coinsEarned ?? pts;
      sub.textContent = `+${pts} pts, +${coins} coins`;
      const capLabel = document.createElement("div");
      capLabel.className = "cap";
      capLabel.textContent = cap>1 ? `${count}/${cap} today` : (isDone ? "Done today" : "1×/day");

      meta.appendChild(title); meta.appendChild(sub); meta.appendChild(capLabel);

      const controls = document.createElement("div");
      controls.className = "row";
      const btnPlus = document.createElement("button");
      btnPlus.className = "btn small"; btnPlus.textContent = isDone ? "Undo" : "Do";
      btnPlus.addEventListener("click", ()=> toggleTaskOnce(t));

      // For caps >1, provide "-" button to undo one
      if (cap>1) {
        const btnMinus = document.createElement("button");
        btnMinus.className = "btn ghost small"; btnMinus.textContent = "−";
        btnMinus.addEventListener("click", ()=> undoTaskOnce(t));
        controls.appendChild(btnMinus);
      }
      controls.appendChild(btnPlus);

      tile.appendChild(meta); tile.appendChild(controls);
      tl.appendChild(tile);
    });
  }

  // Shop
  const sh = $("#shopList");
  sh.innerHTML = "";
  const items = state.shop.filter(s=>s.active!==false);
  if (items.length===0) {
    const d = document.createElement("div");
    d.className="placeholder"; d.textContent="Create rewards in Manage → Shop.";
    sh.appendChild(d);
  } else {
    items.forEach(s=>{
      const card = document.createElement("div");
      card.className = "shop-card";
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
      btn.addEventListener("click", ()=> buyItem(s));
      card.appendChild(title); card.appendChild(cost); card.appendChild(btn);
      sh.appendChild(card);
    });
  }
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
  // ensure pixel-perfect canvas sizing on HiDPI
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
}

function renderSettings() {
  $("#inpResetHour").value = state.settings.resetHour;
  $("#inpRerollCost").value = state.settings.rerollCost;
  $("#chkHaptics").checked = !!state.settings.haptics;
}

/* =========================
   Actions
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
  const bucket = ensureProgressBucket(day);
  bucket.points += points;
  bucket.coinsEarned += coins;
  bucket.completions += 1;
  state.logs.unshift({ ts:new Date().toISOString(), type, id, name, points, coins, day });
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

// Task toggle (increments up to cap, then Undo reduces by 1; for cap=1 toggle)
async function toggleTaskOnce(t) {
  ensureGameDayRoll();
  const cap = t.perDayCap || 1;
  const count = state.today.doneCounts[t.id] || 0;
  if (count < cap) {
    state.today.doneCounts[t.id] = count + 1;
    await grant(t.points ?? 10, t.coinsEarned ?? (t.points ?? 10), t.name, "task", t.id);
  } else {
    // undo last
    await undoTaskOnce(t);
    return;
  }
  await saveState(state);
  renderHome(); renderStats();
}

async function undoTaskOnce(t) {
  const count = state.today.doneCounts[t.id] || 0;
  if (count <= 0) return;
  state.today.doneCounts[t.id] = count - 1;
  // Reverse effects on *today* only (simple)
  const pts = t.points ?? 10;
  const coins = t.coinsEarned ?? pts;
  state.today.points = Math.max(0, (state.today.points||0) - pts);
  state.profile.coins = Math.max(0, (state.profile.coins||0) - coins);
  const bucket = ensureProgressBucket(state.today.day);
  bucket.points = Math.max(0, bucket.points - pts);
  bucket.coinsEarned = Math.max(0, bucket.coinsEarned - coins);
  bucket.completions = Math.max(0, bucket.completions - 1);
  toast("Undone");
  vibrate(10);
  await saveState(state);
  renderHeader(); renderHome(); renderStats();
}

async function toggleChallenge(ch) {
  ensureGameDayRoll();
  const id = ch.id;
  const done = !!state.today.challengeDone[id];
  if (!done) {
    state.today.challengeDone[id] = true;
    await grant(ch.points ?? 10, ch.coinsEarned ?? (ch.points ?? 10), ch.name, "challenge", id);
  } else {
    // undo
    delete state.today.challengeDone[id];
    const pts = ch.points ?? 10;
    const coins = ch.coinsEarned ?? pts;
    state.today.points = Math.max(0, (state.today.points||0) - pts);
    state.profile.coins = Math.max(0, (state.profile.coins||0) - coins);
    const bucket = ensureProgressBucket(state.today.day);
    bucket.points = Math.max(0, bucket.points - pts);
    bucket.coinsEarned = Math.max(0, bucket.coinsEarned - coins);
    bucket.completions = Math.max(0, bucket.completions - 1);
    toast("Undone");
    vibrate(10);
    await saveState(state);
  }
  renderHeader(); renderHome(); renderStats();
}

async function onReroll() {
  const cost = state.settings.rerollCost || 0;
  if (state.today.rerolled) return;
  if ((state.profile.coins||0) < cost) {
    toast("Not enough coins");
    vibrate(8);
    return;
  }
  // Spend & reroll
  await spend(cost, "Reroll", "reroll");
  state.today.rerolled = true;
  // Reassign
  delete state.assigned[state.today.day];
  ensureDailyAssignments();
  await saveState(state);
  renderHome();
}

async function buyItem(s) {
  const cost = s.cost || 0;
  if ((state.profile.coins||0) < cost) {
    toast("Not enough coins");
    vibrate(8);
    return;
  }
  const cooldown = s.cooldownDays || 0;
  const last = s.lastBoughtDay || null;
  const blocked = cooldown>0 && last && dayDiff(state.today.day, last) <= cooldown-1;
  if (blocked) { toast("On cooldown"); return; }
  await spend(cost, s.name, s.id);
  s.lastBoughtDay = state.today.day;
  await saveState(state);
  renderHome(); renderStats();
}

/* =========================
   Manage CRUD
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
    const coins = numberField("Coins (default = points)", existing?.coinsEarned ?? "", 0, 999, true);
    const cap = (kind==="task") ? numberField("Per-day cap", existing?.perDayCap ?? 1, 1, 10) : null;
    const cat = inputField("Category (optional)", existing?.category || "");
    if (cap) mBody.appendChild(cap.wrap);
    mBody.appendChild(points.wrap);
    mBody.appendChild(coins.wrap);
    mBody.appendChild(cat.wrap);

    btnOk.onclick = async ()=>{
      const n = name.input.value.trim();
      if (!n) { toast("Name required"); return; }
      const item = existing || { id: uuid(), active: true };
      item.name = n;
      item.points = clampInt(points.input.value || "10", 1, 999);
      const cc = coins.input.value.trim();
      item.coinsEarned = cc==="" ? item.points : clampInt(cc, 0, 999);
      if (cap) item.perDayCap = clampInt(cap.input.value || "1", 1, 10);
      item.category = cat.input.value.trim() || undefined;

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
  $("#modalCard")?.focus();

  function closeModal(){ modal.classList.add("hidden"); }
  function clampInt(v, min, max){ const n = parseInt(v,10); return isNaN(n)?min: Math.max(min, Math.min(max, n)); }
  function inputField(label, val=""){
    const wrap = document.createElement("label"); wrap.textContent = label;
    wrap.style.display="grid"; wrap.style.gap="6px"; wrap.style.color="var(--muted)";
    const input = document.createElement("input"); input.type="text"; input.value = val;
    input.style.background="#0F1630"; input.style.border="1px solid var(--border)"; input.style.color="var(--text)";
    input.style.borderRadius="10px"; input.style.padding="10px 12px";
    wrap.appendChild(input); return {wrap, input};
  }
  function numberField(label, val=0, min=0, max=999, allowEmpty=false){
    const wrap = document.createElement("label"); wrap.textContent = label;
    wrap.style.display="grid"; wrap.style.gap="6px"; wrap.style.color="var(--muted)";
    const input = document.createElement("input"); input.type="number"; if (allowEmpty && val==="") input.value=""; else input.value = String(val);
    input.min = String(min); input.max = String(max);
    input.style.background="#0F1630"; input.style.border="1px solid var(--border)"; input.style.color="var(--text)";
    input.style.borderRadius="10px"; input.style.padding="10px 12px";
    wrap.appendChild(input); return {wrap, input};
  }
}

/* =========================
   Settings & Data ops
========================= */
async function onSettingChanged() {
  state.settings.resetHour = clampInt($("#inpResetHour").value || "4", 0, 23);
  state.settings.rerollCost = clampInt($("#inpRerollCost").value || "20", 0, 999);
  state.settings.haptics = !!$("#chkHaptics").checked;
  await saveState(state);
  toast("Saved");
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
    state = obj;
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
  state = defaultState();
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
