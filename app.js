// app.js — v4 core
// New: Today's Tasks (one-offs + simple recurrence), Daily Habits (binary/counter),
// Daily Goal bar + ghost tick, Calendar month view, Points→Coins conversion.
// Kept: Challenges, Quick Add (Library), Shop, Weekly Boss, Completed feed, Export/Import.

import { loadState, saveState, clearAll, exportJSON, importJSON } from "./db.js";
import { renderBarChart, renderCalendarHeatmap } from "./charts.js";

/* =========================
   Tiny utilities
========================= */
const $ = (s, el=document)=>el.querySelector(s);
const $$ = (s, el=document)=>Array.from(el.querySelectorAll(s));
const fmt = n => new Intl.NumberFormat().format(n);
const uuid = ()=> (crypto.randomUUID ? crypto.randomUUID() : (Math.random().toString(36).slice(2)+Date.now()));
const clamp = (n,min,max)=>Math.max(min,Math.min(max,n));
const isoDay = (d)=>d.toISOString().slice(0,10);
const todayStr = ()=>isoDay(new Date());        // midnight-based

function banner(msg) {
  const b = $("#banner"); if (!b) return;
  b.textContent = msg; b.classList.remove("hidden");
  requestAnimationFrame(()=>{ b.classList.add("show"); setTimeout(()=>{ b.classList.remove("show"); setTimeout(()=>b.classList.add("hidden"), 260); }, 1200); });
}
function toast(msg) {
  const t = $("#toast"); if (!t) return;
  t.textContent = msg; t.classList.add("show");
  setTimeout(()=>t.classList.remove("show"), 1800);
}
function vibrate(ms=40){ try{ if(state.settings.haptics && navigator.vibrate) navigator.vibrate(ms); }catch{} }

function startOfWeekISO(yyyy_mm_dd){ // Monday
  const d = new Date(yyyy_mm_dd+"T00:00:00");
  const wd = d.getDay(); // 0..6 Sun..Sat
  const delta = (wd===0 ? -6 : 1-wd);
  d.setDate(d.getDate()+delta);
  return isoDay(d);
}
function addDaysStr(yyyy_mm_dd, days){
  const d = new Date(yyyy_mm_dd+"T00:00:00");
  d.setDate(d.getDate()+days);
  return isoDay(d);
}
function parseHM(str){ // "HH:MM" -> {h,m}
  if(!str) return {h:0,m:0};
  const [h,m] = str.split(":").map(x=>parseInt(x,10)||0);
  return {h,m};
}

/* =========================
   Default State v4
========================= */
function defaultStateV4() {
  return {
    version: 4,
    settings: {
      dailyGoal: 60,
      pointsPerCoin: 100,
      haptics: true,
      resetHour: 0   // midnight (fixed)
    },
    profile: { coins: 0, bestStreak: 0 },
    streak: { current: 0 },

    today: {
      day: null,                  // "YYYY-MM-DD"
      points: 0,
      unconvertedPoints: 0,
      lastMilestone: 0,
      habitsStatus: {}            // habitId -> { tally:number, done:boolean }
    },

    // New models
    habits: [],                   // Habit {id,name,type:"binary"|"counter",targetPerDay?,pointsOnComplete,active}
    todos: [],                    // Today/any-day instances: {id,name,dueDay,dueTime?,points,done?,ruleId?}
    todoRules: [],                // Recurrence rules {id,name,points,recurrence:{freq:"daily"|"weekly"|"custom",interval?:number,byWeekday?:number[],time?}}
    library: [],                  // Quick Add earners: {id,name,points,cooldownHours?,lastDoneAt?,active}

    challenges: [],
    assigned: {},                 // day -> [challengeIds]

    shop: [],
    powerHour: { active:false, endsAt:null },

    progress: {},                 // day -> { points, coinsEarned, tasksDone, habitsDone, challengesDone }
    logs: [],                     // append-only: {ts,type:'habit'|'todo'|'library'|'challenge'|'purchase', id,name, points?, coins?, cost?, day}

    // Weekly boss (kept)
    weeklyBoss: {
      weekStartDay: null,
      goals: [],
      completed: false
    },

    economy: { repairsThisMonth: 0 } // reserved for streak repair caps
  };
}

/* =========================
   Migration (v1/v2/v3 -> v4)
========================= */
function migrateToV4(old) {
  if (!old) return defaultStateV4();
  if (old.version >= 4) return old;

  const s = defaultStateV4();

  // carry simple fields when present
  s.profile.coins = old.profile?.coins ?? 0;
  s.profile.bestStreak = old.profile?.bestStreak ?? 0;
  s.streak.current = old.streak?.current ?? 0;

  // settings
  s.settings.haptics = old.settings?.haptics ?? true;
  s.settings.dailyGoal = 60;
  s.settings.pointsPerCoin = 100;

  // map old "tasks" => library
  const oldTasks = old.tasks || [];
  s.library = oldTasks.map(t => ({
    id: t.id || uuid(),
    name: t.name || "Task",
    points: t.points ?? 10,
    cooldownHours: (t.perDayCap && t.perDayCap>1) ? 24 : 24, // old cap≈1/day → 24h
    lastDoneAt: null,
    active: t.active!==false
  }));

  // challenges / assigned
  s.challenges = (old.challenges||[]).map(c=>({ id:c.id||uuid(), name:c.name, points:c.points??10, active:c.active!==false }));
  s.assigned = old.assigned || {};

  // shop & boss
  s.shop = old.shop || [];
  s.weeklyBoss = {
    weekStartDay: old.weeklyBoss?.weekStartDay || startOfWeekISO(todayStr()),
    goals: (old.weeklyBoss?.goals||[]).map(g=>({ ...g, linkedTaskIds: g.linkedTaskIds||[] })),
    completed: !!old.weeklyBoss?.completed
  };

  // progress logs & today snapshot
  s.progress = old.progress || {};
  s.logs = old.logs || [];

  // today points -> v4 buckets
  const oldDay = old.today?.day || todayStr();
  s.today.day = oldDay === todayStr() ? oldDay : todayStr();
  s.today.points = (old.today?.points||0);
  s.today.unconvertedPoints = 0;
  s.today.lastMilestone = 0;

  // habits empty initially; user will create
  // todos empty initially; user will add

  s.version = 4;
  return s;
}

/* =========================
   Global state
========================= */
let state = null;

/* =========================
   Boot
========================= */
window.addEventListener("DOMContentLoaded", init);

async function init() {
  // UI wiring (static)
  $("#pillStreak")?.addEventListener("click", ()=> switchView("statsView"));
  $("#pillCoins")?.addEventListener("click", openShopDrawer);

  // Home: Today’s Tasks & Habits add buttons
  $("#btnAddTodoInline")?.addEventListener("click", ()=> openTodoModal());
  $("#btnOverdueToggle")?.addEventListener("click", ()=> $("#overdueBlock").classList.toggle("hidden"));
  $("#btnAddHabit")?.addEventListener("click", ()=> openHabitModal());

  // Manage CRUD
  $("#btnAddTask").addEventListener("click", ()=> openLibraryModal()); // library item
  $("#btnAddChallenge").addEventListener("click", ()=> openChallengeModal());
  $("#btnAddShop").addEventListener("click", ()=> openShopItemModal());

  // Preferences
  $("#inpDailyGoal").addEventListener("change", onPrefChange);
  $("#inpPPC").addEventListener("change", onPrefChange);
  $("#chkHaptics").addEventListener("change", onPrefChange);

  // Data
  $("#btnExport").addEventListener("click", onExport);
  $("#fileImport").addEventListener("change", onImport);
  $("#btnWipe").addEventListener("click", onWipe);

  // Boss templates
  $("#btnBossTemplate1").addEventListener("click", ()=> applyBossTemplate("momentum"));
  $("#btnBossTemplate2").addEventListener("click", ()=> applyBossTemplate("social"));

  // Quick Add / Shop drawers
  $("#tabAdd").addEventListener("click", openQuickAdd);
  $("#drawerQuickClose").addEventListener("click", closeQuickAdd);
  $("#drawerQuickAdd").addEventListener("click", (e)=>{ if(e.target.id==="drawerQuickAdd") closeQuickAdd(); });
  $("#drawerShopClose").addEventListener("click", closeShopDrawer);
  $("#drawerShop").addEventListener("click", (e)=>{ if(e.target.id==="drawerShop") closeShopDrawer(); });

  // Calendar nav
  $("#calPrev").addEventListener("click", ()=> changeCalendarMonth(-1));
  $("#calNext").addEventListener("click", ()=> changeCalendarMonth(1));
  $("#calToday").addEventListener("click", ()=>{ calendarCursor = new Date(); renderCalendar(); });

  // Load state + migrate
  const loaded = await loadState();
  state = migrateToV4(loaded);

  // Day init & weekly boss init
  ensureDayRollover();  // sets today.day, assigns challenges, generates recurring todos, evaluates yesterday streak
  if (!state.weeklyBoss.weekStartDay) state.weeklyBoss.weekStartDay = startOfWeekISO(state.today.day);

  // Initial render + save
  renderAll();
  await saveState(state);
}

/* =========================
   Day engine (midnight rollover)
========================= */
function ensureDayRollover(){
  const gd = todayStr(); // midnight-based local
  // first run
  if (!state.today.day) {
    state.today.day = gd;
    ensureDailyAssignments();
    generateRecurringTodosForDay(gd);
    return;
  }
  // crossed day?
  if (gd !== state.today.day) {
    // Evaluate yesterday streak (only if all active habits done)
    const y = state.today.day;
    const yAllHabitsDone = areAllHabitsDoneForDay(y);
    const hadActivity = (state.progress[y]?.points || 0) > 0 || yAllHabitsDone;
    if (yAllHabitsDone) {
      state.streak.current = (state.streak.current||0) + 1;
      state.profile.bestStreak = Math.max(state.profile.bestStreak||0, state.streak.current);
    } else if (hadActivity) {
      // activity but not all habits -> streak breaks
      state.streak.current = 0;
    } else {
      // no activity: streak stays (neither increment nor keep? we break: consistent rule)
      state.streak.current = 0;
    }

    // reset today buckets
    state.today.day = gd;
    state.today.points = 0;
    state.today.unconvertedPoints = 0;
    state.today.lastMilestone = 0;
    state.today.habitsStatus = {};

    ensureDailyAssignments();
    generateRecurringTodosForDay(gd);
  }
}

function ensureDailyAssignments(){
  const d = state.today.day;
  if (state.assigned[d] && state.assigned[d].length===3) return;
  const pool = state.challenges.filter(c=>c.active!==false);
  const ids = pool.map(c=>c.id);
  // try to avoid yesterday’s
  const y = addDaysStr(d,-1);
  const avoid = new Set(state.assigned[y]||[]);
  const candidates = ids.filter(id=>!avoid.has(id));
  const bag = (candidates.length>=3)?candidates:ids.slice();
  const selected = [];
  while(selected.length<3 && bag.length){
    const i = Math.floor(Math.random()*bag.length);
    selected.push(bag.splice(i,1)[0]);
  }
  state.assigned[d] = selected;
}

function generateRecurringTodosForDay(dayStr){
  const weekday = new Date(dayStr+"T00:00:00").getDay(); // 0..6
  for (const r of state.todoRules) {
    const rec = r.recurrence||{};
    let due = false;
    if (rec.freq==="daily") due = true;
    else if (rec.freq==="weekly") due = (rec.byWeekday ? rec.byWeekday.includes(weekday) : true);
    else if (rec.freq==="custom") {
      // every N days since anchor
      const anchor = r.anchorDay || state.today.day;
      const diff = Math.round((new Date(dayStr)-new Date(anchor))/(1000*60*60*24));
      due = (diff % (rec.interval||1) === 0);
    }
    if (due) {
      // don't duplicate same rule/day
      const exists = state.todos.some(t=>t.ruleId===r.id && t.dueDay===dayStr);
      if (!exists) {
        state.todos.push({
          id: uuid(),
          name: r.name,
          dueDay: dayStr,
          dueTime: rec.time || "",
          points: r.points,
          done: false,
          ruleId: r.id
        });
      }
    }
  }
}

function areAllHabitsDoneForDay(dayStr) {
  // We only track today's tally explicitly; for previous days we infer from logs.
  if (dayStr === state.today.day) {
    // Determine from habits list + today.habitsStatus
    const activeHabits = state.habits.filter(h=>h.active!==false);
    if (activeHabits.length===0) return false;
    for (const h of activeHabits) {
      const st = state.today.habitsStatus[h.id] || {tally:0,done:false};
      if (!st.done) return false;
    }
    return true;
  }
  // For older days: derive from logs for that day
  const activeIds = new Set(state.habits.filter(h=>h.active!==false).map(h=>h.id));
  if (activeIds.size===0) return false;
  const completedToday = new Set(state.logs.filter(l=>l.day===dayStr && l.type==='habit').map(l=>l.id));
  // If every active habit appeared in logs at least once for that day → done
  for (const id of activeIds) if (!completedToday.has(id)) return false;
  return true;
}

/* =========================
   Render orchestrator
========================= */
function renderAll(){
  renderHeader();
  renderHome();
  renderCalendar();  // month
  renderStats();
  renderManage();
}

/* =========================
   Header (points, goal bar)
========================= */
function renderHeader(){
  $("#statPoints").textContent = fmt(state.today.points||0);
  $("#statCoins").textContent = fmt(state.profile.coins||0);
  $("#statStreak").textContent = fmt(state.streak.current||0);

  // Goal bar
  const goal = state.settings.dailyGoal||60;
  const pct = clamp(Math.round((state.today.points/goal)*100), 0, 100);
  $("#xpFill").style.width = pct+"%";
  $("#goalText").textContent = `${state.today.points||0} / ${goal} pts`;

  // Ghost tick: points on same weekday last week
  const d = new Date(state.today.day+"T00:00:00");
  const ghostDay = isoDay(new Date(d.setDate(d.getDate()-7)));
  const ghostPts = state.progress[ghostDay]?.points || 0;
  const ghostPct = clamp(Math.round((ghostPts/goal)*100), 0, 100);
  $("#goalGhostTick").style.left = ghostPct+"%";
}

/* =========================
   HOME: Today’s Tasks, Habits, Challenges, Boss, Feed
========================= */
function renderHome(){
  renderTodaysTasks();
  renderHabits();
  renderChallenges();
  renderBoss();
  renderCompletedFeed();
}

/* ---------- Today’s Tasks ---------- */
function renderTodaysTasks(){
  const list = $("#todaysTasksList"); list.innerHTML="";
  const overdue = $("#overdueBlock"); overdue.innerHTML="";

  const today = state.today.day;
  const todays = state.todos.filter(t=>t.dueDay===today).sort((a,b)=> (a.dueTime||"") > (b.dueTime||"") ? 1 : -1);
  const overdueList = state.todos.filter(t=>!t.done && t.dueDay < today).sort((a,b)=> a.dueDay.localeCompare(b.dueDay));

  if (todays.length===0) {
    const d = document.createElement("div"); d.className="placeholder";
    d.textContent="You’re all caught up. Add a task for today or schedule one.";
    list.appendChild(d);
  } else {
    for (const t of todays) list.appendChild(todoRow(t));
  }

  if (overdueList.length===0) {
    const d = document.createElement("div"); d.className="placeholder";
    d.textContent="No overdue tasks — nice.";
    overdue.appendChild(d);
  } else {
    for (const t of overdueList) {
      const wrap = document.createElement("div"); wrap.className="overdue";
      wrap.appendChild(todoRow(t));
      overdue.appendChild(wrap);
    }
  }
}
function todoRow(t){
  const row = document.createElement("div"); row.className="todo-row";
  const left = document.createElement("div"); left.className="todo-left";
  const title = document.createElement("div"); title.className="todo-title"; title.textContent = t.name;
  const sub = document.createElement("div"); sub.className="todo-sub";
  const when = t.dueTime ? ` • ${t.dueTime}` : "";
  sub.textContent = `${t.dueDay}${when} • +${t.points} pts`;
  left.appendChild(title); left.appendChild(sub);

  const right = document.createElement("div"); right.className="todo-right";
  if (t.dueDay < state.today.day && !t.done) {
    const b = document.createElement("div"); b.className="badge warn"; b.textContent="Overdue";
    right.appendChild(b);
  }

  const btn = document.createElement("button");
  btn.className = "btn small";
  btn.textContent = t.done ? "Undo" : "Complete";
  btn.addEventListener("click", ()=> toggleTodoDone(t));
  right.appendChild(btn);

  // kebab: edit/reschedule
  const keb = document.createElement("button");
  keb.className="icon-btn"; keb.textContent="⋯";
  keb.title="Edit or reschedule";
  keb.addEventListener("click", ()=> openTodoModal(t));
  right.appendChild(keb);

  row.appendChild(left); row.appendChild(right);
  return row;
}
async function toggleTodoDone(t){
  if (!t.done) {
    t.done = true;
    await grantPoints(t.points, t.name, "todo", t.id);
  } else {
    t.done = false;
    await reversePoints(t.points, "todo", t.id);
  }
  await saveState(state);
  renderHeader(); renderTodaysTasks(); renderCompletedFeed(); renderCalendar(); renderStats();
}
function openTodoModal(existing=null){
  const modal = $("#modal"); const mTitle=$("#modalTitle"); const mBody=$("#modalBody"); const ok=$("#modalOk");
  const cancel=$("#modalCancel"), close=$("#modalClose");
  const isEdit = !!existing;
  mTitle.textContent = isEdit? "Edit Task" : "Add Task";

  mBody.innerHTML="";
  const name = fieldText("Title", existing?.name || "");
  const points = fieldNum("Points", existing?.points ?? 10, 1, 999);
  const due = fieldDate("Due date", existing?.dueDay || state.today.day);
  const time = fieldTime("Time (optional)", existing?.dueTime || "");

  // Simple recurrence
  const recWrap = document.createElement("div"); recWrap.className="form";
  const recLabel = document.createElement("label"); recLabel.textContent = "Recurrence";
  const sel = document.createElement("select");
  sel.style.cssText = "background:#0F1630;border:1px solid var(--border);color:var(--text);border-radius:10px;padding:12px;font-size:16px";
  sel.innerHTML = `
    <option value="none">None (one-off)</option>
    <option value="daily">Daily</option>
    <option value="weekly">Weekly (same weekday)</option>
  `;
  recLabel.appendChild(sel); recWrap.appendChild(recLabel);

  mBody.appendChild(name.wrap); mBody.appendChild(points.wrap); mBody.appendChild(due.wrap); mBody.appendChild(time.wrap); mBody.appendChild(recWrap);

  ok.onclick = async ()=>{
    const n = name.input.value.trim(); if(!n){ toast("Title required"); return; }
    const p = clamp(parseInt(points.input.value||"10",10), 1, 999);
    const day = due.input.value || state.today.day;
    const tm = time.input.value || "";
    if (isEdit) {
      existing.name = n; existing.points = p; existing.dueDay = day; existing.dueTime = tm;
    } else {
      const todo = { id: uuid(), name:n, points:p, dueDay:day, dueTime:tm, done:false };
      state.todos.push(todo);
      // if recurrence selected, create/update rule for future days
      const r = sel.value;
      if (r!=="none") {
        const rule = {
          id: uuid(),
          name: n, points: p,
          recurrence: (r==="daily") ? {freq:"daily", time:tm} : {freq:"weekly", byWeekday:[new Date(day+"T00:00:00").getDay()], time:tm},
          anchorDay: day
        };
        state.todoRules.push(rule);
      }
    }
    await saveState(state);
    closeModal();
    renderTodaysTasks(); renderCalendar();
  };

  cancel.onclick = closeModal; close.onclick = closeModal;
  modal.classList.remove("hidden");

  function closeModal(){ modal.classList.add("hidden"); }
}

/* ---------- Daily Habits ---------- */
function renderHabits(){
  const wrap = $("#habitsList"); wrap.innerHTML="";
  const active = state.habits.filter(h=>h.active!==false);
  if (active.length===0) {
    const d = document.createElement("div"); d.className="placeholder";
    d.textContent = "No habits yet. Add 1–3 to start your streak.";
    wrap.appendChild(d);
    return;
  }
  for (const h of active) wrap.appendChild(habitRow(h));
}
function habitRow(h){
  const row = document.createElement("div"); row.className="habit-row";
  const st = state.today.habitsStatus[h.id] || {tally:0, done:false};
  if (st.done) row.classList.add("done");

  const left = document.createElement("div"); left.className="habit-left";
  const title = document.createElement("div"); title.className="habit-title"; title.textContent = h.name;
  const sub = document.createElement("div"); sub.className="habit-sub";
  if (h.type==="binary") sub.textContent = `+${h.pointsOnComplete} pts`;
  else sub.textContent = `${st.tally||0}/${h.targetPerDay} • +${h.pointsOnComplete} pts when done`;
  left.appendChild(title); left.appendChild(sub);

  const right = document.createElement("div"); right.className="habit-right";
  if (h.type==="binary") {
    const toggle = document.createElement("div"); toggle.className="habit-toggle";
    toggle.addEventListener("click", ()=> toggleHabitBinary(h));
    right.appendChild(toggle);
  } else {
    const ctr = document.createElement("div"); ctr.className="counter";
    const minus = document.createElement("button"); minus.textContent="−";
    const num = document.createElement("div"); num.className="num"; num.textContent= String(st.tally||0);
    const plus = document.createElement("button"); plus.textContent="+";
    minus.addEventListener("click", ()=> adjustHabitTally(h,-1));
    plus.addEventListener("click", ()=> adjustHabitTally(h, +1));
    ctr.appendChild(minus); ctr.appendChild(num); ctr.appendChild(plus);
    right.appendChild(ctr);
  }
  row.appendChild(left); row.appendChild(right);
  return row;
}
async function toggleHabitBinary(h){
  const st = state.today.habitsStatus[h.id] || {tally:0,done:false};
  if (!st.done) {
    st.done = true; state.today.habitsStatus[h.id] = st;
    await grantPoints(h.pointsOnComplete, h.name, "habit", h.id);
  } else {
    st.done = false; state.today.habitsStatus[h.id] = st;
    await reversePoints(h.pointsOnComplete, "habit", h.id);
  }
  await saveState(state);
  renderHeader(); renderHabits(); renderCompletedFeed(); renderCalendar(); renderStats();
}
async function adjustHabitTally(h, delta){
  const st = state.today.habitsStatus[h.id] || {tally:0,done:false};
  const prevDone = st.done;
  const next = clamp((st.tally||0)+delta, 0, h.targetPerDay||1);
  st.tally = next; st.done = (next >= (h.targetPerDay||1));
  state.today.habitsStatus[h.id] = st;

  if (!prevDone && st.done) {
    await grantPoints(h.pointsOnComplete, h.name, "habit", h.id);
  } else if (prevDone && !st.done) {
    await reversePoints(h.pointsOnComplete, "habit", h.id);
  } else {
    await saveState(state);
  }
  renderHeader(); renderHabits(); renderCompletedFeed(); renderCalendar(); renderStats();
}
function openHabitModal(existing=null){
  const modal = $("#modal"); const mTitle=$("#modalTitle"); const mBody=$("#modalBody"); const ok=$("#modalOk");
  const cancel=$("#modalCancel"), close=$("#modalClose");
  const isEdit = !!existing;
  mTitle.textContent = isEdit? "Edit Habit" : "Add Habit";
  mBody.innerHTML="";

  const name = fieldText("Name", existing?.name || "");
  // type select
  const typeWrap = document.createElement("label"); typeWrap.textContent="Type";
  typeWrap.style.color="var(--muted)"; typeWrap.style.display="grid"; typeWrap.style.gap="6px";
  const typeSel = document.createElement("select");
  typeSel.style.cssText="background:#0F1630;border:1px solid var(--border);color:var(--text);border-radius:10px;padding:12px;font-size:16px";
  typeSel.innerHTML = `
    <option value="binary">Binary (Done/Not)</option>
    <option value="counter">Counter (e.g., 3/3)</option>
  `;
  typeSel.value = existing?.type || "binary";
  typeWrap.appendChild(typeSel);

  const target = fieldNum("Target per day (for Counter)", existing?.targetPerDay ?? 3, 1, 20);
  const pts = fieldNum("Points when completed", existing?.pointsOnComplete ?? 10, 1, 999);

  mBody.appendChild(name.wrap); mBody.appendChild(typeWrap); mBody.appendChild(target.wrap); mBody.appendChild(pts.wrap);

  ok.onclick = async ()=>{
    const n = name.input.value.trim(); if(!n){ toast("Name required"); return; }
    const item = existing || { id: uuid(), active:true };
    item.name = n; item.type = typeSel.value;
    item.targetPerDay = clamp(parseInt(target.input.value||"3",10), 1, 20);
    item.pointsOnComplete = clamp(parseInt(pts.input.value||"10",10), 1, 999);
    if (!existing) state.habits.push(item);
    await saveState(state);
    closeModal(); renderHabits();
  };
  cancel.onclick = closeModal; close.onclick = closeModal;
  modal.classList.remove("hidden");
  function closeModal(){ modal.classList.add("hidden"); }
}

/* ---------- Daily Challenges (kept) ---------- */
function renderChallenges(){
  const list = $("#dailyList"); list.innerHTML="";
  const day = state.today.day;
  const assigned = state.assigned[day] || [];
  if (assigned.length===0) {
    const d = document.createElement("div"); d.className="placeholder";
    d.textContent="No challenges assigned. Add some in Manage → Challenge Pool.";
    list.appendChild(d); return;
  }
  for (const id of assigned) {
    const ch = state.challenges.find(x=>x.id===id);
    if (!ch) continue;
    const done = !!state.logs.find(l=>l.day===day && l.type==='challenge' && l.id===id);
    const card = document.createElement("div"); card.className="tile" + (done?" done":"");
    const meta = document.createElement("div"); meta.className="meta";
    const title=document.createElement("div"); title.className="title"; title.textContent=ch.name;
    const sub=document.createElement("div"); sub.className="sub"; sub.textContent = `+${ch.points??10} pts`;
    meta.appendChild(title); meta.appendChild(sub);
    const btn = document.createElement("button"); btn.className="btn small"; btn.textContent = done? "Undo" : "Complete";
    btn.addEventListener("click", ()=> toggleChallenge(ch, done));
    card.appendChild(meta); card.appendChild(btn);
    list.appendChild(card);
  }
}
async function toggleChallenge(ch, isDone){
  if (!isDone) {
    await grantPoints(ch.points??10, ch.name, "challenge", ch.id);
  } else {
    await reversePoints(ch.points??10, "challenge", ch.id);
  }
  await saveState(state);
  renderHeader(); renderChallenges(); renderCompletedFeed(); renderCalendar(); renderStats(); renderBoss();
}

/* ---------- Boss (kept) ---------- */
function renderBoss(){
  const ring = $("#bossRing"); const goalsWrap=$("#bossGoals"); goalsWrap.innerHTML="";
  const goals = state.weeklyBoss.goals || [];
  let totalT=0, total=0;
  for(const g of goals){ totalT += (g.target||0); total += Math.min(g.tally||0, g.target||0); }
  const pct = totalT>0 ? Math.round((total/totalT)*100) : 0;
  drawBossRing(ring, pct);

  if(goals.length===0){ const d=document.createElement("div"); d.className="placeholder"; d.textContent="Use a Boss template in Manage."; goalsWrap.appendChild(d); return; }
  for(const g of goals){
    const row=document.createElement("div"); row.className="boss-goal";
    const top=document.createElement("div"); top.className="row";
    const label=document.createElement("div"); label.className="label"; label.textContent=g.label;
    const meta=document.createElement("div"); meta.className="meta";
    const clampT = Math.min(g.tally||0, g.target||0);
    meta.textContent=`${clampT}/${g.target}`;
    const bar=document.createElement("div"); bar.className="boss-bar";
    const fill=document.createElement("div"); fill.style.width = (g.target>0? Math.round((clampT/g.target)*100):0)+"%";
    bar.appendChild(fill); top.appendChild(label); top.appendChild(meta);
    row.appendChild(top); row.appendChild(bar); goalsWrap.appendChild(row);
  }
}
function drawBossRing(canvas, pct){
  if(!canvas) return;
  const ctx = canvas.getContext("2d");
  const W=canvas.width, H=canvas.height; const cx=W/2, cy=H/2, r=Math.min(W,H)/2-14;
  ctx.clearRect(0,0,W,H);
  ctx.lineWidth=14; ctx.strokeStyle="#1b2347"; ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.stroke();
  const grad=ctx.createLinearGradient(0,0,W,H); grad.addColorStop(0,"#5B8CFF"); grad.addColorStop(1,"#B85CFF");
  const start=-Math.PI/2; const end=start+(Math.PI*2)*(pct/100);
  ctx.strokeStyle=grad; ctx.beginPath(); ctx.arc(cx,cy,r,start,end); ctx.stroke();
  ctx.fillStyle="rgba(230,233,242,.85)"; ctx.font="24px system-ui, -apple-system, Segoe UI, Roboto";
  ctx.textAlign="center"; ctx.textBaseline="middle"; ctx.fillText(`${pct}%`, cx, cy);
}

/* ---------- Completed feed ---------- */
function renderCompletedFeed(){
  const wrap=$("#feedToday"); wrap.innerHTML="";
  const day = state.today.day;
  const items = state.logs.filter(l=>l.day===day && (l.type==='todo'||l.type==='habit'||l.type==='challenge'||l.type==='library'));
  if(items.length===0){ const d=document.createElement("div"); d.className="placeholder"; d.textContent="Nothing completed yet. Tap the + to get started."; wrap.appendChild(d); return; }
  for(const log of items){
    const row=document.createElement("div"); row.className="feed-item";
    const left=document.createElement("div"); left.className="feed-left";
    const title=document.createElement("div"); title.className="feed-title"; title.textContent=log.name;
    const sub=document.createElement("div"); sub.className="feed-sub";
    const map = {todo:"Task",habit:"Habit",challenge:"Challenge",library:"Quick Task"};
    sub.textContent = `${map[log.type]||"Item"} • +${log.points} pts`;
    left.appendChild(title); left.appendChild(sub);
    const right=document.createElement("div"); right.className="feed-right";
    const btn=document.createElement("button"); btn.className="chip-undo"; btn.textContent="Undo";
    btn.addEventListener("click", ()=> undoLogEntry(log));
    right.appendChild(btn);
    row.appendChild(left); row.appendChild(right);
    wrap.appendChild(row);
  }
}
async function undoLogEntry(log){
  if (log.day!==state.today.day){ toast("Can only undo today"); return; }
  if (log.type==='todo'){
    const t = state.todos.find(x=>x.id===log.id); if(t){ t.done=false; }
    await reversePoints(log.points, 'todo', log.id);
  } else if (log.type==='habit'){
    const st = state.today.habitsStatus[log.id] || {tally:0,done:false};
    st.done=false; state.today.habitsStatus[log.id]=st;
    await reversePoints(log.points, 'habit', log.id);
  } else if (log.type==='challenge'){
    await reversePoints(log.points, 'challenge', log.id);
  } else if (log.type==='library'){
    await reversePoints(log.points, 'library', log.id);
  }
  await saveState(state);
  renderHeader(); renderHome(); renderCalendar(); renderStats();
}

/* =========================
   POINTS/COINS ECONOMY
========================= */
function ensureProgressBucket(day){
  if(!state.progress[day]) state.progress[day]={ points:0, coinsEarned:0, tasksDone:0, habitsDone:0, challengesDone:0 };
  return state.progress[day];
}
async function grantPoints(points, name, type, id){
  const day = state.today.day;
  // Power Hour bonus (simple +50%)
  const now = Date.now();
  if (state.powerHour?.active && state.powerHour.endsAt && now < Date.parse(state.powerHour.endsAt)) {
    points = Math.round(points * 1.5);
  }
  state.today.points += points;
  state.today.unconvertedPoints += points;

  // points -> coins conversion
  const rate = state.settings.pointsPerCoin || 100;
  const minted = Math.floor(state.today.unconvertedPoints / rate);
  if (minted > 0){
    state.today.unconvertedPoints -= minted * rate;
    state.profile.coins += minted;
    const bucket = ensureProgressBucket(day);
    bucket.coinsEarned += minted;
  }

  // milestone banners each +100 pts
  const nextMilestone = Math.floor((state.today.points)/100)*100;
  if (nextMilestone>0 && nextMilestone>(state.today.lastMilestone||0)){
    state.today.lastMilestone = nextMilestone;
    banner(`Milestone: ${nextMilestone} points today!`);
  }

  const bucket = ensureProgressBucket(day);
  bucket.points += points;
  if (type==='todo') bucket.tasksDone += 1;
  if (type==='habit') bucket.habitsDone += 1;
  if (type==='challenge') bucket.challengesDone += 1;

  state.logs.unshift({ ts:new Date().toISOString(), type, id, name, points, day });
  vibrate(40); toast(`+${points} pts`);
  await saveState(state);
}
async function reversePoints(points, type, id){
  const day = state.today.day;
  state.today.points = Math.max(0, state.today.points - points);
  // we don't reverse coins minted (keeps economy stable)
  const bucket = ensureProgressBucket(day);
  bucket.points = Math.max(0, bucket.points - points);
  if (type==='todo') bucket.tasksDone = Math.max(0, bucket.tasksDone - 1);
  if (type==='habit') bucket.habitsDone = Math.max(0, bucket.habitsDone - 1);
  if (type==='challenge') bucket.challengesDone = Math.max(0, bucket.challengesDone - 1);
  const i = state.logs.findIndex(l=> l.day===day && l.type===type && l.id===id && l.points===points);
  if (i>=0) state.logs.splice(i,1);
  vibrate(12); toast("Undone");
  await saveState(state);
}

/* =========================
   QUICK ADD (Library) & SHOP
========================= */
function openQuickAdd(){ renderQuickAdd(); $("#drawerQuickAdd").classList.remove("hidden"); }
function closeQuickAdd(){ $("#drawerQuickAdd").classList.add("hidden"); }

function renderQuickAdd(){
  const favRow=$("#quickFavsRow"), favWrap=$("#quickFavs"), grid=$("#quickTaskList");
  favWrap.innerHTML=""; grid.innerHTML="";
  const tasks = state.library.filter(t=>t.active!==false);
  if (tasks.length===0){ const d=document.createElement("div"); d.className="placeholder"; d.textContent="No tasks yet. Add in Manage → Task Library."; grid.appendChild(d); favRow.classList.add("hidden"); return; }

  // favorites by usage
  const counts=new Map(); for(const l of state.logs){ if(l.type==='library') counts.set(l.id,(counts.get(l.id)||0)+1); }
  const favs=tasks.slice().sort((a,b)=>(counts.get(b.id)||0)-(counts.get(a.id)||0)).slice(0,3);
  if (favs.length>0){ favRow.classList.remove("hidden"); for(const t of favs){ const c=document.createElement("button"); c.className="quick-chip"; c.textContent=t.name; c.addEventListener("click",()=> quickAddLibrary(t)); favWrap.appendChild(c);} } else favRow.classList.add("hidden");

  for(const t of tasks){
    const disabled = isLibraryOnCooldown(t);
    const card=document.createElement("button"); card.className="quick-card"; card.disabled = disabled;
    const sub = disabled ? "Cooling…" : `+${t.points} pts`;
    card.innerHTML = `<div>${t.name}</div><div class="sub">${sub}</div>`;
    card.addEventListener("click", ()=> quickAddLibrary(t));
    grid.appendChild(card);
  }
}
function isLibraryOnCooldown(t){
  if (!t.cooldownHours) return false;
  if (!t.lastDoneAt) return false;
  const last = Date.parse(t.lastDoneAt);
  const readyAt = last + t.cooldownHours*3600*1000;
  return Date.now() < readyAt;
}
async function quickAddLibrary(t){
  if (isLibraryOnCooldown(t)) { toast("Cooling down"); return; }
  t.lastDoneAt = new Date().toISOString();
  await grantPoints(t.points, t.name, "library", t.id);
  renderQuickAdd(); renderHeader(); renderCompletedFeed(); renderCalendar(); renderStats();
}

function openShopDrawer(){ renderShopDrawer(); $("#drawerShop").classList.remove("hidden"); }
function closeShopDrawer(){ $("#drawerShop").classList.add("hidden"); }
function renderShopDrawer(){
  const wrap=$("#shopDrawerList"); wrap.innerHTML="";
  const items=state.shop.filter(s=>s.active!==false);
  if(items.length===0){ const d=document.createElement("div"); d.className="placeholder"; d.textContent="No rewards yet. Add some in Manage → Shop."; wrap.appendChild(d); return; }
  for(const s of items){
    const row=document.createElement("div"); row.className="shop-card";
    const title=document.createElement("div"); title.className="shop-title"; title.textContent=s.name;
    const cost=document.createElement("div"); cost.className="shop-cost"; cost.textContent = `${s.cost} coins`;
    const btn=document.createElement("button"); btn.className="btn small"; btn.textContent="Buy";
    btn.addEventListener("click", ()=> buyShopItem(s));
    row.appendChild(title); row.appendChild(cost); row.appendChild(btn);
    wrap.appendChild(row);
  }
}
async function buyShopItem(item){
  if ((state.profile.coins||0) < (item.cost||0)) { toast("Not enough coins"); return; }
  state.profile.coins -= (item.cost||0);
  state.logs.unshift({ ts:new Date().toISOString(), type:'purchase', id:item.id, name:item.name, cost:item.cost, day: state.today.day });
  // simple power hour
  if (item.type==='powerHour'){
    state.powerHour.active = true;
    state.powerHour.endsAt = new Date(Date.now() + 60*60*1000).toISOString();
    toast("Power Hour Active (+50% pts for 60m)");
  }
  // streak repair placeholder (guardrails to be added later)
  await saveState(state);
  renderHeader(); closeShopDrawer();
}

/* =========================
   MANAGE: Library / Challenges / Shop / Boss / Preferences
========================= */
function renderManage(){
  // Library (old Tasks)
  renderLibraryAdmin();
  renderChallengesAdmin();
  renderShopAdmin();
  renderBossManage();
  // Prefill preferences UI
  $("#inpDailyGoal").value = state.settings.dailyGoal||60;
  $("#inpPPC").value = state.settings.pointsPerCoin||100;
  $("#chkHaptics").checked = !!state.settings.haptics;
}

function renderLibraryAdmin(){
  const el=$("#manageTasks"); el.innerHTML="";
  const items=state.library||[];
  if(items.length===0){ const d=document.createElement("div"); d.className="placeholder"; d.textContent="No items yet. Click “+ Add”."; el.appendChild(d); return; }
  for(const it of items){
    const row=document.createElement("div"); row.className="tile";
    const meta=document.createElement("div"); meta.className="meta";
    const t=document.createElement("div"); t.className="title"; t.textContent=it.name;
    const s=document.createElement("div"); s.className="sub"; s.textContent = `+${it.points} pts${it.cooldownHours?` • ${it.cooldownHours}h cooldown`:''}`;
    meta.appendChild(t); meta.appendChild(s);
    const actions=document.createElement("div"); actions.className="row";
    const edit=document.createElement("button"); edit.className="btn ghost small"; edit.textContent="Edit";
    edit.addEventListener("click", ()=> openLibraryModal(it));
    const tog=document.createElement("button"); tog.className="btn small"; const active=it.active!==false; tog.textContent=active?"Archive":"Activate";
    tog.addEventListener("click", async()=>{ it.active = !active; await saveState(state); renderLibraryAdmin(); });
    actions.appendChild(edit); actions.appendChild(tog);
    row.appendChild(meta); row.appendChild(actions); el.appendChild(row);
  }
}
function openLibraryModal(existing=null){
  const modal=$("#modal"), mTitle=$("#modalTitle"), mBody=$("#modalBody"), ok=$("#modalOk"); const cancel=$("#modalCancel"), close=$("#modalClose");
  const isEdit=!!existing; mTitle.textContent=isEdit?"Edit Library Item":"Add Library Item";
  mBody.innerHTML="";
  const name=fieldText("Name", existing?.name || "");
  const pts=fieldNum("Points", existing?.points ?? 10, 1, 999);
  const cd=fieldNum("Cooldown hours (optional)", existing?.cooldownHours ?? "", 0, 168, true);
  mBody.appendChild(name.wrap); mBody.appendChild(pts.wrap); mBody.appendChild(cd.wrap);
  ok.onclick = async ()=>{
    const n=name.input.value.trim(); if(!n){ toast("Name required"); return; }
    const item= existing || { id:uuid(), active:true };
    item.name=n; item.points=clamp(parseInt(pts.input.value||"10",10),1,999);
    const c=cd.input.value.trim(); item.cooldownHours = c===""? undefined : clamp(parseInt(c,10),0,168);
    if(!existing) state.library.push(item);
    await saveState(state); closeModal(); renderLibraryAdmin();
  };
  cancel.onclick=closeModal; close.onclick=closeModal; modal.classList.remove("hidden");
  function closeModal(){ modal.classList.add("hidden"); }
}

function renderChallengesAdmin(){
  const el=$("#manageChallenges"); el.innerHTML="";
  const items=state.challenges||[];
  if(items.length===0){ const d=document.createElement("div"); d.className="placeholder"; d.textContent="No challenges yet. Click “+ Add”."; el.appendChild(d); return; }
  for(const it of items){
    const row=document.createElement("div"); row.className="tile";
    const meta=document.createElement("div"); meta.className="meta";
    const t=document.createElement("div"); t.className="title"; t.textContent=it.name;
    const s=document.createElement("div"); s.className="sub"; s.textContent = `+${it.points??10} pts`;
    meta.appendChild(t); meta.appendChild(s);
    const actions=document.createElement("div"); actions.className="row";
    const edit=document.createElement("button"); edit.className="btn ghost small"; edit.textContent="Edit";
    edit.addEventListener("click", ()=> openChallengeModal(it));
    const tog=document.createElement("button"); tog.className="btn small"; const active=it.active!==false; tog.textContent=active?"Archive":"Activate";
    tog.addEventListener("click", async()=>{ it.active = !active; await saveState(state); renderChallengesAdmin(); });
    actions.appendChild(edit); actions.appendChild(tog);
    row.appendChild(meta); row.appendChild(actions); el.appendChild(row);
  }
}
function openChallengeModal(existing=null){
  const modal=$("#modal"), mTitle=$("#modalTitle"), mBody=$("#modalBody"), ok=$("#modalOk"); const cancel=$("#modalCancel"), close=$("#modalClose");
  const isEdit=!!existing; mTitle.textContent=isEdit?"Edit Challenge":"Add Challenge";
  mBody.innerHTML="";
  const name=fieldText("Name", existing?.name || "");
  const pts=fieldNum("Points", existing?.points ?? 10, 1, 999);
  mBody.appendChild(name.wrap); mBody.appendChild(pts.wrap);
  ok.onclick = async ()=>{
    const n=name.input.value.trim(); if(!n){ toast("Name required"); return; }
    const item= existing || { id:uuid(), active:true };
    item.name=n; item.points=clamp(parseInt(pts.input.value||"10",10),1,999);
    if(!existing) state.challenges.push(item);
    await saveState(state); closeModal(); renderChallengesAdmin(); renderChallenges();
  };
  cancel.onclick=closeModal; close.onclick=closeModal; modal.classList.remove("hidden");
  function closeModal(){ modal.classList.add("hidden"); }
}

function renderShopAdmin(){
  const el=$("#manageShop"); el.innerHTML="";
  const items=state.shop||[];
  if(items.length===0){ const d=document.createElement("div"); d.className="placeholder"; d.textContent="No rewards yet. Click “+ Add”."; el.appendChild(d); return; }
  for(const it of items){
    const row=document.createElement("div"); row.className="tile";
    const meta=document.createElement("div"); meta.className="meta";
    const t=document.createElement("div"); t.className="title"; t.textContent=it.name;
    const s=document.createElement("div"); s.className="sub"; s.textContent = `${it.cost} coins${it.type?` • ${it.type}`:""}`;
    meta.appendChild(t); meta.appendChild(s);
    const actions=document.createElement("div"); actions.className="row";
    const edit=document.createElement("button"); edit.className="btn ghost small"; edit.textContent="Edit";
    edit.addEventListener("click", ()=> openShopItemModal(it));
    const tog=document.createElement("button"); tog.className="btn small"; const active=it.active!==false; tog.textContent=active?"Archive":"Activate";
    tog.addEventListener("click", async()=>{ it.active = !active; await saveState(state); renderShopAdmin(); });
    actions.appendChild(edit); actions.appendChild(tog);
    row.appendChild(meta); row.appendChild(actions); el.appendChild(row);
  }
}
function openShopItemModal(existing=null){
  const modal=$("#modal"), mTitle=$("#modalTitle"), mBody=$("#modalBody"), ok=$("#modalOk"); const cancel=$("#modalCancel"), close=$("#modalClose");
  const isEdit=!!existing; mTitle.textContent=isEdit?"Edit Shop Item":"Add Shop Item";
  mBody.innerHTML="";
  const name=fieldText("Name", existing?.name || "");
  const cost=fieldNum("Cost (coins)", existing?.cost ?? 20, 1, 999);
  // type select
  const typeWrap = document.createElement("label"); typeWrap.textContent="Type";
  typeWrap.style.color="var(--muted)"; typeWrap.style.display="grid"; typeWrap.style.gap="6px";
  const sel = document.createElement("select"); sel.style.cssText="background:#0F1630;border:1px solid var(--border);color:var(--text);border-radius:10px;padding:12px;font-size:16px";
  sel.innerHTML = `<option value="">Generic reward</option><option value="powerHour">Power Hour (+50% / 60m)</option><option value="streakRepair">Streak Repair</option>`;
  sel.value = existing?.type || "";
  typeWrap.appendChild(sel);

  mBody.appendChild(name.wrap); mBody.appendChild(cost.wrap); mBody.appendChild(typeWrap);
  ok.onclick = async ()=>{
    const n=name.input.value.trim(); if(!n){ toast("Name required"); return; }
    const item = existing || { id:uuid(), active:true };
    item.name=n; item.cost=clamp(parseInt(cost.input.value||"20",10),1,999); item.type = sel.value || undefined;
    if(!existing) state.shop.push(item);
    await saveState(state); closeModal(); renderShopAdmin();
  };
  cancel.onclick=closeModal; close.onclick=closeModal; modal.classList.remove("hidden");
  function closeModal(){ modal.classList.add("hidden"); }
}

/* ---------- Boss manage (templates kept) ---------- */
function renderBossManage(){
  const wrap=$("#manageBoss"); wrap.innerHTML="";
  if (!state.weeklyBoss.goals || state.weeklyBoss.goals.length===0){
    const d=document.createElement("div"); d.className="placeholder"; d.textContent="Use a template above to quickly create a weekly boss."; wrap.appendChild(d); return;
  }
  for(const g of state.weeklyBoss.goals){
    const row=document.createElement("div"); row.className="tile";
    const meta=document.createElement("div"); meta.className="meta";
    const t=document.createElement("div"); t.className="title"; t.textContent=g.label;
    const s=document.createElement("div"); s.className="sub"; s.textContent=`Target: ${g.target} • Linked tasks: ${g.linkedTaskIds?.length||0}`;
    meta.appendChild(t); meta.appendChild(s);
    row.appendChild(meta); wrap.appendChild(row);
  }
}
async function applyBossTemplate(kind){
  const byName=new Map(); for(const t of state.library) byName.set(t.name.toLowerCase(), t.id);
  let goals=[];
  if (kind==="momentum"){
    goals=[
      { id:uuid(), label:"Talk to 10 people", target:10, tally:0, linkedTaskIds: byName.has("talk to someone")?[byName.get("talk to someone")]:[] },
      { id:uuid(), label:"Focused work 90 min", target:2, tally:0, linkedTaskIds: byName.has("45-min study")?[byName.get("45-min study")]:[] },
      { id:uuid(), label:"Workouts x3", target:3, tally:0, linkedTaskIds: byName.has("full workout")?[byName.get("full workout")]:[] }
    ];
  } else {
    goals=[
      { id:uuid(), label:"Meaningful chats x10", target:10, tally:0, linkedTaskIds: byName.has("talk to someone")?[byName.get("talk to someone")]:[] },
      { id:uuid(), label:"Call family x2", target:2, tally:0, linkedTaskIds: byName.has("call parents")?[byName.get("call parents")]:[] }
    ];
  }
  state.weeklyBoss.weekStartDay = startOfWeekISO(state.today.day||todayStr());
  state.weeklyBoss.goals = goals;
  state.weeklyBoss.completed = false;
  await saveState(state); renderBoss(); renderBossManage(); toast("Boss template applied");
}

/* ---------- Preferences + Data ---------- */
async function onPrefChange(){
  state.settings.dailyGoal = clamp(parseInt($("#inpDailyGoal").value||"60",10), 10, 1000);
  state.settings.pointsPerCoin = clamp(parseInt($("#inpPPC").value||"100",10), 10, 1000);
  state.settings.haptics = !!$("#chkHaptics").checked;
  await saveState(state);
  toast("Saved"); renderHeader(); renderStats(); renderCalendar();
}
async function onExport(){
  const text = await exportJSON();
  const blob = new Blob([text], {type:"application/json"}); const url=URL.createObjectURL(blob);
  const a=document.createElement("a"); a.href=url; a.download=`liferpg-export-${Date.now()}.json`; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 300);
}
async function onImport(e){
  const f=e.target.files[0]; if(!f) return;
  const text=await f.text();
  try{
    const obj=await importJSON(text);
    state=migrateToV4(obj); ensureDayRollover(); renderAll(); toast("Imported");
  }catch{ toast("Import failed"); }
  e.target.value="";
}
async function onWipe(){
  if (!confirm("This will erase all data. Continue?")) return;
  await clearAll(); state=defaultStateV4(); state.today.day=todayStr(); ensureDailyAssignments(); await saveState(state); renderAll(); toast("Wiped");
}

/* =========================
   STATS (legacy + minor upgrades)
========================= */
function renderStats(){
  // Streak numbers already set in header
  $("#streakBig").textContent = fmt(state.streak.current||0);
  $("#bestStreak").textContent = fmt(state.profile.bestStreak||0);
  // completions last 7d
  const last7 = getLastNDays(7);
  let cmp=0; for(const d of last7){ cmp += (state.progress[d]?.tasksDone||0) + (state.progress[d]?.habitsDone||0) + (state.progress[d]?.challengesDone||0); }
  $("#cmpWeek").textContent = fmt(cmp);

  // 30-day points bar chart
  const last30 = getLastNDays(30);
  const vals = last30.map(d=> state.progress[d]?.points || 0);
  const cvs=$("#bar30"); const r=window.devicePixelRatio||1; cvs.style.width="100%"; const w=cvs.clientWidth||600; const h=260;
  cvs.width=Math.floor(w*r); cvs.height=Math.floor(h*r); cvs.getContext("2d").setTransform(r,0,0,r,0,0);
  renderBarChart(cvs, vals);

  // Legacy 90-day heatmap
  renderCalendarHeatmap($("#heatmap"), state.progress);
}
function getLastNDays(n){
  const arr=[]; const base=new Date(); base.setHours(0,0,0,0);
  for(let i=n-1;i>=0;i--){ const d=new Date(base); d.setDate(base.getDate()-i); arr.push(isoDay(d)); }
  return arr;
}

/* =========================
   CALENDAR (month view)
========================= */
let calendarCursor = new Date(); // current month
function changeCalendarMonth(delta){
  calendarCursor.setMonth(calendarCursor.getMonth()+delta);
  renderCalendar();
}
function renderCalendar(){
  const head=$("#monthHead"); const grid=$("#monthGrid"); if(!grid) return;
  const y = calendarCursor.getFullYear(); const m = calendarCursor.getMonth(); // 0..11
  $("#calTitle").textContent = new Date(y, m, 1).toLocaleString(undefined,{month:"long", year:"numeric"});

  // Build days: start Monday
  const first = new Date(y, m, 1); const firstW = (first.getDay()||7); // 1..7
  const start = new Date(first); start.setDate(1 - (firstW-1));
  const cells = [];
  for(let i=0;i<42;i++){ const d=new Date(start); d.setDate(start.getDate()+i); cells.push(d); }

  grid.innerHTML="";
  for(const d of cells){
    const ds = isoDay(d);
    const day = document.createElement("div"); day.className="cal-day"; if (d.getMonth()!==m) day.classList.add("out");
    if (ds===state.today.day) day.classList.add("today");

    const date = document.createElement("div"); date.className="date"; date.textContent = String(d.getDate());
    const ring = document.createElement("div"); ring.className="habit-ring";
    const allDone = areAllHabitsDoneForDay(ds);
    if(allDone) ring.classList.add("done");

    const dotsWrap = document.createElement("div"); dotsWrap.className="task-dots";
    const due = state.todos.filter(t=>t.dueDay===ds).length;
    const done = state.todos.filter(t=>t.dueDay===ds && t.done).length;
    for(let i=0;i<Math.min(due,6);i++){ const dot=document.createElement("div"); dot.className="task-dot"+(i<done?" done":""); dotsWrap.appendChild(dot); }

    const pts = document.createElement("div"); pts.className="pts-small"; pts.textContent = state.progress[ds]?.points || "";

    day.appendChild(date); day.appendChild(ring); day.appendChild(dotsWrap); day.appendChild(pts);
    grid.appendChild(day);
  }
}

/* =========================
   View switching (icons tabs)
========================= */
function switchView(id){
  const tabs=$$(".tabbar .tab"); const views=$$(".view");
  tabs.forEach(b=>{ const target=b.getAttribute("data-target"); b.classList.toggle("active", target===id); b.setAttribute("aria-selected", target===id?"true":"false"); });
  views.forEach(v=> v.classList.toggle("active", v.id===id));
  if (id==="statsView") renderStats();
  if (id==="calendarView") renderCalendar();
}

/* =========================
   Form helpers
========================= */
function fieldText(label, val=""){
  const wrap=document.createElement("label"); wrap.textContent=label; wrap.style.display="grid"; wrap.style.gap="6px"; wrap.style.color="var(--muted)";
  const input=document.createElement("input"); input.type="text"; input.value=val; styleInput(input);
  wrap.appendChild(input); return {wrap,input};
}
function fieldNum(label, val=0, min=0, max=999, allowEmpty=false){
  const wrap=document.createElement("label"); wrap.textContent=label; wrap.style.display="grid"; wrap.style.gap="6px"; wrap.style.color="var(--muted)";
  const input=document.createElement("input"); input.type="number"; if(allowEmpty && val==="") input.value=""; else input.value=String(val);
  input.min=String(min); input.max=String(max); styleInput(input);
  wrap.appendChild(input); return {wrap,input};
}
function fieldDate(label, val){
  const wrap=document.createElement("label"); wrap.textContent=label; wrap.style.display="grid"; wrap.style.gap="6px"; wrap.style.color="var(--muted)";
  const input=document.createElement("input"); input.type="date"; input.value=val; styleInput(input);
  wrap.appendChild(input); return {wrap,input};
}
function fieldTime(label, val){
  const wrap=document.createElement("label"); wrap.textContent=label; wrap.style.display="grid"; wrap.style.gap="6px"; wrap.style.color="var(--muted)";
  const input=document.createElement("input"); input.type="time"; if(val) input.value=val; styleInput(input);
  wrap.appendChild(input); return {wrap,input};
}
function styleInput(input){ input.style.background="#0F1630"; input.style.border="1px solid var(--border)"; input.style.color="var(--text)"; input.style.borderRadius="10px"; input.style.padding="12px 12px"; input.style.fontSize="16px"; }

/* =========================
   Done.
========================= */
