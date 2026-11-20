const DAYS_SHORT = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
const MONTH_NAMES = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];
const STORAGE_KEY = "schichtplanung.v3";

const SHIFT_PRESETS = {
  frueh: { start: "06:00", end: "14:00", label: "Früh" },
  spaet: { start: "14:00", end: "22:00", label: "Spät" },
  nacht: { start: "22:00", end: "06:00", label: "Nacht" },
};

const DEFAULT_DRIVER = {
  brutto: 2500,
  hourlyRate: 15,
  shiftLength: 8,
  defaultShift: "frueh",
  workdays: [1, 2, 3, 4, 5], // 0=Sun … 6=Sat (JS native)
  includeHolidays: false,
  applyBonuses: true,
};

const state = loadState();
let appMode = "schicht"; // "schicht" | "stunden"
let viewMode = "week";
let anchor = new Date();
let editingShift = null;
let editingDriver = null;

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      for (const d of s.drivers) {
        if (!Array.isArray(d.workdays)) {
          d.workdays = d.includeWeekends ? [0, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5];
        }
        if (d.applyBonuses === undefined) d.applyBonuses = true;
      }
      return s;
    }
  } catch {}
  // migrate from old v2 key if present
  try {
    const old = localStorage.getItem("schichtplanung.v2");
    if (old) {
      const s = JSON.parse(old);
      for (const d of s.drivers) {
        d.workdays = d.includeWeekends ? [0, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5];
        delete d.includeWeekends;
      }
      return s;
    }
  } catch {}
  return {
    drivers: [
      { id: "d1", name: "Max Müller", ...DEFAULT_DRIVER },
      { id: "d2", name: "Anna Schmidt", ...DEFAULT_DRIVER, defaultShift: "spaet" },
      { id: "d3", name: "Tom Weber", ...DEFAULT_DRIVER, defaultShift: "nacht" },
    ],
    shifts: {},
  };
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

// ---------- Date helpers ----------

function startOfWeek(d) {
  const date = new Date(d);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  date.setHours(0, 0, 0, 0);
  return date;
}

function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function endOfMonth(d) { return new Date(d.getFullYear(), d.getMonth() + 1, 0); }

function dateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function formatDate(d) {
  return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
}

function dowShort(d) { return DAYS_SHORT[(d.getDay() + 6) % 7]; }

// ---------- Holidays ----------

function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

const holidayCache = {};

function holidaysFor(year) {
  if (holidayCache[year]) return holidayCache[year];
  const easter = easterSunday(year);
  const map = {};
  const add = (d, name) => (map[dateKey(d)] = name);
  add(new Date(year, 0, 1), "Neujahr");
  add(addDays(easter, -2), "Karfreitag");
  add(addDays(easter, 1), "Ostermontag");
  add(new Date(year, 4, 1), "Tag der Arbeit");
  add(addDays(easter, 39), "Christi Himmelfahrt");
  add(addDays(easter, 50), "Pfingstmontag");
  add(new Date(year, 9, 3), "Tag der Deutschen Einheit");
  add(new Date(year, 11, 25), "1. Weihnachtstag");
  add(new Date(year, 11, 26), "2. Weihnachtstag");
  holidayCache[year] = map;
  return map;
}

function holidayName(d) { return holidaysFor(d.getFullYear())[dateKey(d)] || null; }
function isWeekend(d) { const dow = d.getDay(); return dow === 0 || dow === 6; }

// 150% days per §3b Abs. 3 Nr. 2 EStG
// - 1. Mai
// - 25., 26. Dezember
// - 24. Dezember ab 14:00 (requires minuteOfDay check — handled separately)
function is150FullDay(d) {
  const m = d.getMonth(), day = d.getDate();
  if (m === 4 && day === 1) return true;          // 1. Mai
  if (m === 11 && (day === 25 || day === 26)) return true;
  return false;
}

function is150After14_24Dec(d, minuteOfDay) {
  return d.getMonth() === 11 && d.getDate() === 24 && minuteOfDay >= 14 * 60;
}

function parseKey(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function timeToMin(t) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

// ---------- Time + break helpers ----------

function hoursBetween(start, end) {
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  let mins = (eh * 60 + em) - (sh * 60 + sm);
  if (mins <= 0) mins += 24 * 60;
  return mins / 60;
}

function addMinutes(timeStr, mins) {
  const [h, m] = timeStr.split(":").map(Number);
  const total = ((h * 60 + m + mins) % (24 * 60) + 24 * 60) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

// ArbZG §4: >6h → 30 min, >9h → 45 min
function breakMinutes(windowHours) {
  if (windowHours > 9) return 45;
  if (windowHours > 6) return 30;
  return 0;
}

function shiftBreakdown(start, end) {
  const windowH = hoursBetween(start, end);
  const bm = breakMinutes(windowH);
  if (bm === 0) {
    return { windowH, breakMin: 0, workH: windowH, segments: [[start, end]] };
  }
  const workMin = windowH * 60 - bm;
  const halfWork = workMin / 2;
  const breakStart = addMinutes(start, Math.round(halfWork));
  const breakEnd = addMinutes(breakStart, bm);
  return {
    windowH,
    breakMin: bm,
    workH: workMin / 60,
    segments: [[start, breakStart], [breakEnd, end]],
    breakRange: [breakStart, breakEnd],
  };
}

function fmtHours(h) { return h.toLocaleString("de-DE", { maximumFractionDigits: 1 }); }
function fmtEuro(n) { return n.toLocaleString("de-DE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }); }

function shiftTypeFromTimes(start, end) {
  for (const [k, v] of Object.entries(SHIFT_PRESETS)) {
    if (v.start === start && v.end === end) return k;
  }
  return "custom";
}

// ---------- Zuschlag computation ----------
// §3b EStG rates:
//   Nachtarbeit 20–06 Uhr: 25%
//   Nachtarbeit 0–04 Uhr, wenn Schicht vor 0 Uhr begann: 40%
//   Sonntag (0 So – 04 Mo): 50%
//   Feiertag (0 Fei – 04 Folgetag): 125%
//   Besondere Feiertage (1.5., 25./26.12., 24.12. ab 14 Uhr): 150%
// Nacht kumuliert mit So/Feiertag. So und Feiertag kumulieren NICHT.

function computeShiftWage(shift, dateStr, driver) {
  const rate = driver.hourlyRate || 0;
  const bd = shiftBreakdown(shift.start, shift.end);
  const baseHours = bd.workH;
  const baseWage = baseHours * rate;

  const empty = {
    baseHours, baseWage, bonusWage: 0, totalWage: baseWage,
    categories: { night25: 0, night40: 0, sunday: 0, holiday125: 0, holiday150: 0 },
  };

  if (!driver.applyBonuses || rate === 0) return empty;

  const date = parseKey(dateStr);
  const shiftStartMin = timeToMin(shift.start);
  const shiftEndMin = timeToMin(shift.end);
  const crossesMidnight = shiftEndMin <= shiftStartMin;

  const counters = { night25: 0, night40: 0, sunday: 0, holiday125: 0, holiday150: 0 };

  for (const [segStart, segEnd] of bd.segments) {
    let s = timeToMin(segStart);
    let e = timeToMin(segEnd);
    if (s < shiftStartMin) s += 1440;
    if (e <= s) e += 1440;

    for (let m = s; m < e; m++) {
      const dayOffset = Math.floor(m / 1440);
      const minOfDay = m % 1440;
      const minuteDate = addDays(date, dayOffset);
      const hour = Math.floor(minOfDay / 60);
      const prevDate = addDays(minuteDate, -1);

      // --- Base category (one of: 150, 125, 50, 0) ---
      const todayHol = holidayName(minuteDate);
      const prevHol = holidayName(prevDate);
      const today150Full = is150FullDay(minuteDate);
      const today150_24 = is150After14_24Dec(minuteDate, minOfDay);
      const prev150Full = is150FullDay(prevDate);
      const prev150_24 = prevDate.getMonth() === 11 && prevDate.getDate() === 24; // 24.12 after 14 → overnight 0-4 covered

      // §3b: Sonn-/Feiertagszuschlag läuft bis 4 Uhr des Folgetags,
      // nur wenn die Schicht vor 0 Uhr begann (= crossesMidnight).
      const extendsPrev = hour < 4 && crossesMidnight;
      let base = 0;
      if (today150Full || today150_24) base = 1.5;
      else if (extendsPrev && prevHol && (prev150Full || prev150_24)) base = 1.5;
      else if (todayHol) base = 1.25;
      else if (extendsPrev && prevHol) base = 1.25;
      else if (minuteDate.getDay() === 0) base = 0.5;
      else if (extendsPrev && prevDate.getDay() === 0) base = 0.5;

      // --- Night category (kumulativ) ---
      let night = 0;
      if (hour >= 20 || hour < 6) {
        if (hour < 4 && crossesMidnight) night = 0.4;
        else night = 0.25;
      }

      // Categorize: each minute picks ONE base and ONE night bucket (for display counts).
      // Wage is computed from both.
      if (base === 1.5) counters.holiday150++;
      else if (base === 1.25) counters.holiday125++;
      else if (base === 0.5) counters.sunday++;

      if (night === 0.4) counters.night40++;
      else if (night === 0.25) counters.night25++;

      // sum into bonusWage incrementally (base + night rates)
      // we aggregate later from counters
    }
  }

  const bonusWage =
    (counters.night25 / 60) * rate * 0.25 +
    (counters.night40 / 60) * rate * 0.40 +
    (counters.sunday / 60) * rate * 0.50 +
    (counters.holiday125 / 60) * rate * 1.25 +
    (counters.holiday150 / 60) * rate * 1.50;

  return {
    baseHours, baseWage, bonusWage, totalWage: baseWage + bonusWage, categories: counters,
  };
}

function computeMonthlyWages(driverId, dateInMonth) {
  const driver = state.drivers.find((d) => d.id === driverId);
  if (!driver) return null;
  const first = startOfMonth(dateInMonth);
  const monthPrefix = `${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, "0")}`;
  const totals = {
    shiftCount: 0, baseHours: 0, baseWage: 0, bonusWage: 0, totalWage: 0,
    categories: { night25: 0, night40: 0, sunday: 0, holiday125: 0, holiday150: 0 },
  };
  for (const [k, shift] of Object.entries(state.shifts)) {
    if (!k.startsWith(driver.id + ":" + monthPrefix)) continue;
    const dateStr = k.split(":")[1];
    const w = computeShiftWage(shift, dateStr, driver);
    totals.shiftCount++;
    totals.baseHours += w.baseHours;
    totals.baseWage += w.baseWage;
    totals.bonusWage += w.bonusWage;
    totals.totalWage += w.totalWage;
    for (const key of Object.keys(totals.categories)) totals.categories[key] += w.categories[key] || 0;
  }
  return totals;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- Rendering ----------

function periodLabel() {
  if (viewMode === "week") {
    const ws = startOfWeek(anchor);
    const end = addDays(ws, 6);
    return `${formatDate(ws)} – ${formatDate(end)} ${end.getFullYear()}`;
  }
  return `${MONTH_NAMES[anchor.getMonth()]} ${anchor.getFullYear()}`;
}

function daysForView() {
  if (viewMode === "week") {
    const ws = startOfWeek(anchor);
    return Array.from({ length: 7 }, (_, i) => addDays(ws, i));
  }
  const first = startOfMonth(anchor);
  const last = endOfMonth(anchor);
  return Array.from({ length: last.getDate() }, (_, i) => addDays(first, i));
}

function renderShiftContent(shift, dateStr, driver) {
  const type = shift.type || shiftTypeFromTimes(shift.start, shift.end);
  const label = SHIFT_PRESETS[type]?.label || "Custom";
  const bd = shiftBreakdown(shift.start, shift.end);
  let hoursHtml;
  if (bd.breakMin === 0) {
    hoursHtml = `<span class="hours">${shift.start}–${shift.end}</span>`;
  } else {
    const [s1, e1] = bd.segments[0];
    const [s2, e2] = bd.segments[1];
    hoursHtml = `<span class="hours">${s1}–${e1}<span class="pause-mid"> · ${bd.breakMin}' · </span>${s2}–${e2}</span>`;
  }
  const wage = computeShiftWage(shift, dateStr, driver);
  const bonusText = wage.bonusWage > 0
    ? ` · <span class="bonus">+ ${fmtEuro2(wage.bonusWage)}</span>`
    : "";
  const note = shift.note ? `<span class="note">${escapeHtml(shift.note)}</span>` : "";
  return { type, html: `${hoursHtml}<span class="label">${label} · ${fmtHours(bd.workH)} h${bonusText}</span>${note}` };
}

function fmtEuro2(n) {
  return n.toLocaleString("de-DE", { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function render() {
  document.getElementById("periodLabel").textContent = periodLabel();
  document.getElementById("printPeriodLabel").textContent = periodLabel();
  document.getElementById("viewWeek").classList.toggle("active", viewMode === "week");
  document.getElementById("viewMonth").classList.toggle("active", viewMode === "month");

  const table = document.getElementById("schedule");
  table.classList.toggle("month", viewMode === "month");

  renderGrid({
    headerElem: document.getElementById("headerRow"),
    bodyElem: document.getElementById("scheduleBody"),
    days: daysForView(),
    onDriverClick: (id) => openDriverDialog(id),
    onCellClick: (id, key) => openShiftDialog(id, key),
  });
}

function renderGrid({ headerElem, bodyElem, days, onDriverClick, onCellClick, driverMeta }) {
  headerElem.innerHTML = '<th class="date-col">Datum</th>';
  for (const driver of state.drivers) {
    const th = document.createElement("th");
    th.className = "driver-cell";
    const totals = computeMonthlyWages(driver.id, anchor);
    const meta = driverMeta
      ? driverMeta(driver, totals)
      : `Ziel: ${fmtEuro(driver.brutto || 0)} · Arbeit: ${fmtHours(totals.baseHours)} h`;
    th.innerHTML = `<span class="name">${escapeHtml(driver.name)}</span><span class="meta">${meta}</span>`;
    th.addEventListener("click", () => onDriverClick(driver.id));
    headerElem.appendChild(th);
  }

  bodyElem.innerHTML = "";
  for (const d of days) {
    const key = dateKey(d);
    const tr = document.createElement("tr");
    if (holidayName(d)) tr.classList.add("holiday-row");
    else if (isWeekend(d)) tr.classList.add("weekend-row");

    const dateCell = document.createElement("td");
    dateCell.className = "date-cell";
    if (holidayName(d)) dateCell.classList.add("holiday");
    else if (isWeekend(d)) dateCell.classList.add("weekend");
    const hname = holidayName(d);
    dateCell.innerHTML = `<span class="dow">${dowShort(d)}</span><span class="date">${formatDate(d)}</span>${hname ? `<span class="hname" title="${escapeHtml(hname)}">${escapeHtml(hname)}</span>` : ""}`;
    tr.appendChild(dateCell);

    for (const driver of state.drivers) {
      const cell = document.createElement("td");
      cell.className = "shift-cell";
      if (holidayName(d)) cell.classList.add("holiday");
      else if (isWeekend(d)) cell.classList.add("weekend");
      if (onCellClick) cell.addEventListener("click", () => onCellClick(driver.id, key));

      const shift = state.shifts[`${driver.id}:${key}`];
      if (shift) {
        const { type, html } = renderShiftContent(shift, key, driver);
        const el = document.createElement("div");
        el.className = `shift ${type}`;
        el.innerHTML = html;
        cell.appendChild(el);
      }

      tr.appendChild(cell);
    }

    bodyElem.appendChild(tr);
  }
}

// ---------- Shift dialog ----------

function openShiftDialog(driverId, key) {
  editingShift = { driverId, dateKey: key };
  const existing = state.shifts[`${driverId}:${key}`];
  const driver = state.drivers.find((d) => d.id === driverId);
  const type = existing?.type || driver.defaultShift || "frueh";
  document.getElementById("shiftType").value = type;
  if (existing) {
    document.getElementById("shiftStart").value = existing.start;
    document.getElementById("shiftEnd").value = existing.end;
  } else {
    applyPresetToDialog(type, driver.shiftLength);
  }
  const note = document.getElementById("shiftNote");
  note.value = existing?.note || "";
  autoGrow(note);
  document.getElementById("deleteShift").style.visibility = existing ? "visible" : "hidden";
  document.getElementById("dialogTitle").textContent = `${driver.name} · ${formatDate(parseKey(key))}`;
  document.getElementById("shiftDialog").showModal();
}

function applyPresetToDialog(type, shiftLength) {
  if (type === "custom") return;
  const preset = SHIFT_PRESETS[type];
  if (!preset) return;
  document.getElementById("shiftStart").value = preset.start;
  const [sh, sm] = preset.start.split(":").map(Number);
  const totalMin = sh * 60 + sm + (shiftLength || 8) * 60;
  const eh = Math.floor(totalMin / 60) % 24;
  const em = totalMin % 60;
  document.getElementById("shiftEnd").value = `${String(eh).padStart(2, "0")}:${String(em).padStart(2, "0")}`;
}

document.getElementById("shiftType").addEventListener("change", (e) => {
  if (!editingShift) return;
  const driver = state.drivers.find((d) => d.id === editingShift.driverId);
  applyPresetToDialog(e.target.value, driver.shiftLength);
});

document.getElementById("shiftNote").addEventListener("input", (e) => autoGrow(e.target));

document.getElementById("saveShift").addEventListener("click", () => {
  if (!editingShift) return;
  const start = document.getElementById("shiftStart").value;
  const end = document.getElementById("shiftEnd").value;
  const note = document.getElementById("shiftNote").value.trim();
  const type = document.getElementById("shiftType").value;
  if (!start || !end) return;
  state.shifts[`${editingShift.driverId}:${editingShift.dateKey}`] = { start, end, note, type };
  saveState();
  render();
  document.getElementById("shiftDialog").close();
});

document.getElementById("deleteShift").addEventListener("click", () => {
  if (!editingShift) return;
  delete state.shifts[`${editingShift.driverId}:${editingShift.dateKey}`];
  saveState();
  render();
  document.getElementById("shiftDialog").close();
});

document.getElementById("cancelShift").addEventListener("click", () => {
  document.getElementById("shiftDialog").close();
});

// ---------- Driver dialog ----------

function getWorkdaysFromUI() {
  const boxes = document.querySelectorAll("#driverWorkdays input[type=checkbox]");
  const out = [];
  boxes.forEach((b) => { if (b.checked) out.push(Number(b.dataset.day)); });
  return out.sort();
}

function setWorkdaysUI(workdays) {
  const set = new Set(workdays);
  document.querySelectorAll("#driverWorkdays input[type=checkbox]").forEach((b) => {
    b.checked = set.has(Number(b.dataset.day));
  });
}

function openDriverDialog(driverId) {
  editingDriver = driverId;
  const driver = driverId === "new"
    ? { id: null, name: "", ...DEFAULT_DRIVER }
    : state.drivers.find((d) => d.id === driverId);

  document.getElementById("driverDialogTitle").textContent = driverId === "new" ? "Neuer Fahrer" : driver.name;
  document.getElementById("driverName").value = driver.name;
  document.getElementById("driverBrutto").value = driver.brutto;
  document.getElementById("driverRate").value = driver.hourlyRate;
  document.getElementById("driverShiftLen").value = driver.shiftLength;
  document.getElementById("driverDefaultShift").value = driver.defaultShift;
  setWorkdaysUI(driver.workdays || DEFAULT_DRIVER.workdays);
  document.getElementById("driverHolidays").checked = driver.includeHolidays;
  document.getElementById("driverApplyBonuses").checked = driver.applyBonuses !== false;
  document.getElementById("deleteDriver").style.visibility = driverId === "new" ? "hidden" : "visible";
  document.getElementById("generatePlan").style.visibility = driverId === "new" ? "hidden" : "visible";

  updateDriverComputed();
  document.getElementById("driverDialog").showModal();
}

function updateDriverComputed() {
  const target = Number(document.getElementById("driverBrutto").value) || 0;
  const rate = Number(document.getElementById("driverRate").value) || 0;
  const shiftLen = Number(document.getElementById("driverShiftLen").value) || 0;

  const tempDriver = {
    id: editingDriver || "preview",
    name: document.getElementById("driverName").value || "",
    brutto: target,
    hourlyRate: rate,
    shiftLength: shiftLen,
    defaultShift: document.getElementById("driverDefaultShift").value,
    workdays: getWorkdaysFromUI(),
    includeHolidays: document.getElementById("driverHolidays").checked,
    applyBonuses: document.getElementById("driverApplyBonuses").checked,
  };

  const plan = target > 0 && rate > 0 && shiftLen > 0
    ? planForDriver(tempDriver, anchor)
    : [];
  const totals = simulateTotals(tempDriver, plan);
  const c = totals.categories;

  const rows = [
    `<div><b>Ziel-Gesamtlohn</b> <span class="val">${fmtEuro(target)}</span></div>`,
    `<div><b>Standard-Schicht</b> <span class="val">${SHIFT_PRESETS[tempDriver.defaultShift]?.label || "Custom"} · ${fmtHours(shiftLen)} h Fenster</span></div>`,
    `<div><b>Geplante Schichten (${MONTH_NAMES[anchor.getMonth()]})</b> <span class="val">${totals.shiftCount} ×</span></div>`,
    `<div><b>Arbeitszeit gesamt</b> <span class="val">${fmtHours(totals.baseHours)} h</span></div>`,
  ];
  if (c.night25 > 0) rows.push(`<div>· Nacht 25 % <span class="val">${fmtHours(c.night25 / 60)} h</span></div>`);
  if (c.night40 > 0) rows.push(`<div>· Nacht 40 % <span class="val">${fmtHours(c.night40 / 60)} h</span></div>`);
  if (c.sunday > 0) rows.push(`<div>· Sonntag 50 % <span class="val">${fmtHours(c.sunday / 60)} h</span></div>`);
  if (c.holiday125 > 0) rows.push(`<div>· Feiertag 125 % <span class="val">${fmtHours(c.holiday125 / 60)} h</span></div>`);
  if (c.holiday150 > 0) rows.push(`<div>· Feiertag 150 % <span class="val">${fmtHours(c.holiday150 / 60)} h</span></div>`);
  rows.push(`<div><b>Grundlohn</b> <span class="val">${fmtEuro2(totals.baseWage)}</span></div>`);
  rows.push(`<div><b>Zuschläge</b> <span class="val">${fmtEuro2(totals.bonusWage)}</span></div>`);
  const diff = totals.totalWage - target;
  const diffStr = `${diff >= 0 ? "+" : ""}${fmtEuro2(diff)}`;
  rows.push(`<div><b>= Prognose Gesamtlohn</b> <span class="val">${fmtEuro2(totals.totalWage)} <small style="opacity:.6">(${diffStr})</small></span></div>`);

  document.getElementById("driverComputed").innerHTML = rows.join("");

  const actualBox = document.getElementById("driverMonthActual");
  if (editingDriver && editingDriver !== "new") {
    const totals = computeMonthlyWages(editingDriver, anchor);
    if (totals && totals.shiftCount > 0) {
      const c = totals.categories;
      const rows = [
        `<div><b>${MONTH_NAMES[anchor.getMonth()]} ${anchor.getFullYear()}</b> <span class="val">${totals.shiftCount} Schichten</span></div>`,
        `<div><b>Arbeitsstunden</b> <span class="val">${fmtHours(totals.baseHours)} h</span></div>`,
        `<div><b>Grundlohn</b> <span class="val">${fmtEuro(totals.baseWage)}</span></div>`,
      ];
      if (c.night25 > 0) rows.push(`<div><b>Nacht 25 % (20–06 Uhr)</b> <span class="val">${fmtHours(c.night25 / 60)} h</span></div>`);
      if (c.night40 > 0) rows.push(`<div><b>Nacht 40 % (0–04 Uhr)</b> <span class="val">${fmtHours(c.night40 / 60)} h</span></div>`);
      if (c.sunday > 0) rows.push(`<div><b>Sonntag 50 %</b> <span class="val">${fmtHours(c.sunday / 60)} h</span></div>`);
      if (c.holiday125 > 0) rows.push(`<div><b>Feiertag 125 %</b> <span class="val">${fmtHours(c.holiday125 / 60)} h</span></div>`);
      if (c.holiday150 > 0) rows.push(`<div><b>Feiertag 150 %</b> <span class="val">${fmtHours(c.holiday150 / 60)} h</span></div>`);
      rows.push(`<div><b>Zuschläge gesamt</b> <span class="val">${fmtEuro2(totals.bonusWage)}</span></div>`);
      rows.push(`<div><b>= Gesamtlohn</b> <span class="val">${fmtEuro2(totals.totalWage)}</span></div>`);
      actualBox.innerHTML = rows.join("");
      actualBox.style.display = "";
      return;
    }
  }
  actualBox.style.display = "none";
}

["driverBrutto", "driverRate", "driverShiftLen"].forEach((id) => {
  document.getElementById(id).addEventListener("input", updateDriverComputed);
});
["driverDefaultShift", "driverHolidays", "driverApplyBonuses"].forEach((id) => {
  document.getElementById(id).addEventListener("change", updateDriverComputed);
});
document.getElementById("driverWorkdays").addEventListener("change", updateDriverComputed);

function driverPayloadFromDialog() {
  return {
    name: document.getElementById("driverName").value.trim(),
    brutto: Number(document.getElementById("driverBrutto").value) || 0,
    hourlyRate: Number(document.getElementById("driverRate").value) || 0,
    shiftLength: Number(document.getElementById("driverShiftLen").value) || 8,
    defaultShift: document.getElementById("driverDefaultShift").value,
    workdays: getWorkdaysFromUI(),
    includeHolidays: document.getElementById("driverHolidays").checked,
    applyBonuses: document.getElementById("driverApplyBonuses").checked,
  };
}

document.getElementById("saveDriver").addEventListener("click", () => {
  const payload = driverPayloadFromDialog();
  if (!payload.name) return;

  if (editingDriver === "new") {
    state.drivers.push({ id: "d" + Date.now(), ...payload });
  } else {
    const d = state.drivers.find((x) => x.id === editingDriver);
    Object.assign(d, payload);
  }
  saveState();
  render();
  document.getElementById("driverDialog").close();
});

document.getElementById("deleteDriver").addEventListener("click", () => {
  if (editingDriver === "new" || !editingDriver) return;
  const d = state.drivers.find((x) => x.id === editingDriver);
  if (!confirm(`"${d.name}" entfernen?`)) return;
  state.drivers = state.drivers.filter((x) => x.id !== editingDriver);
  for (const k of Object.keys(state.shifts)) {
    if (k.startsWith(editingDriver + ":")) delete state.shifts[k];
  }
  saveState();
  render();
  document.getElementById("driverDialog").close();
});

document.getElementById("cancelDriver").addEventListener("click", () => {
  document.getElementById("driverDialog").close();
});

document.getElementById("generatePlan").addEventListener("click", () => {
  if (editingDriver === "new" || !editingDriver) return;
  const payload = driverPayloadFromDialog();
  if (!payload.name) return;
  const d = state.drivers.find((x) => x.id === editingDriver);
  Object.assign(d, payload);
  saveState();
  generatePlanForDriver(d, anchor);
  viewMode = "month";
  render();
  document.getElementById("driverDialog").close();
});

// ---------- Plan generation ----------

function workHoursFromWindow(w) {
  return w - breakMinutes(w) / 60;
}

function endTimeFromStart(startStr, windowH) {
  const [sh, sm] = startStr.split(":").map(Number);
  const endMin = Math.round(sh * 60 + sm + windowH * 60);
  const eh = Math.floor(endMin / 60) % 24;
  const em = endMin % 60;
  return `${String(eh).padStart(2, "0")}:${String(em).padStart(2, "0")}`;
}

function availableDaysForDriver(driver, dateInMonth) {
  const first = startOfMonth(dateInMonth);
  const last = endOfMonth(dateInMonth);
  const workdaySet = new Set(driver.workdays || []);
  const out = [];
  for (let day = 1; day <= last.getDate(); day++) {
    const d = new Date(first.getFullYear(), first.getMonth(), day);
    const hol = holidayName(d);
    if (!workdaySet.has(d.getDay())) continue;
    if (hol && !driver.includeHolidays) continue;
    out.push(d);
  }
  return out;
}

// Pure function: returns array of { day, windowLen } to hit driver.brutto (Gesamtlohn).
function planForDriver(driver, dateInMonth) {
  const target = driver.brutto;
  const rate = driver.hourlyRate;
  const requestedWindow = Math.round((driver.shiftLength || 8) * 2) / 2;
  if (target <= 0 || rate <= 0 || requestedWindow <= 0) return [];

  const available = availableDaysForDriver(driver, dateInMonth);
  if (available.length === 0) return [];

  const preset = SHIFT_PRESETS[driver.defaultShift] || SHIFT_PRESETS.frueh;

  const wageForDay = (day, windowLen) => {
    const end = endTimeFromStart(preset.start, windowLen);
    const shift = { start: preset.start, end, type: driver.defaultShift };
    return computeShiftWage(shift, dateKey(day), driver).totalWage;
  };

  const sumAtWindow = (windowLen) => {
    let s = 0;
    for (const d of available) s += wageForDay(d, windowLen);
    return s;
  };

  const totalAtRequested = sumAtWindow(requestedWindow);

  if (totalAtRequested >= target) {
    // Mode A: pick N days at requestedWindow, then mix one length ±0.5h to close the gap.
    const avgWage = totalAtRequested / available.length;
    const n = Math.max(1, Math.round(target / avgWage));
    const picks = Array.from({ length: n }, (_, i) =>
      Math.floor(i * available.length / n + available.length / (2 * n))
    );
    const pickedDays = picks.map((i) => available[i]);
    const sumPicked = (wl) => pickedDays.reduce((s, d) => s + wageForDay(d, wl), 0);
    const sumRw = sumPicked(requestedWindow);
    const gap = target - sumRw;

    if (gap > 0 && requestedWindow + 0.5 <= 24) {
      const wagePerUp = (sumPicked(requestedWindow + 0.5) - sumRw) / n;
      const up = wagePerUp > 0 ? Math.max(0, Math.min(n, Math.round(gap / wagePerUp))) : 0;
      const longSet = new Set();
      for (let i = 0; i < up; i++) longSet.add(Math.floor(i * n / up + n / (2 * up)));
      return pickedDays.map((d, i) => ({ day: d, windowLen: longSet.has(i) ? requestedWindow + 0.5 : requestedWindow }));
    }
    if (gap < 0 && requestedWindow - 0.5 >= 0.5) {
      const wagePerDown = (sumRw - sumPicked(requestedWindow - 0.5)) / n;
      const down = wagePerDown > 0 ? Math.max(0, Math.min(n, Math.round(-gap / wagePerDown))) : 0;
      const shortSet = new Set();
      for (let i = 0; i < down; i++) shortSet.add(Math.floor(i * n / down + n / (2 * down)));
      return pickedDays.map((d, i) => ({ day: d, windowLen: shortSet.has(i) ? requestedWindow - 0.5 : requestedWindow }));
    }
    return pickedDays.map((d) => ({ day: d, windowLen: requestedWindow }));
  }

  // Mode B: all days get a shift. Mix two 0.5h-grid lengths to hit target €.
  const n = available.length;
  let base = 0.5;
  while (base + 0.5 <= 24 && sumAtWindow(base + 0.5) <= target) base += 0.5;
  const totalAtBase = sumAtWindow(base);
  const canUp = base + 0.5 <= 24;
  const totalAtNext = canUp ? sumAtWindow(base + 0.5) : totalAtBase;
  const deltaPerShift = (totalAtNext - totalAtBase) / n;
  const deficit = Math.max(0, target - totalAtBase);
  const upgrades = (canUp && deltaPerShift > 0)
    ? Math.max(0, Math.min(n, Math.round(deficit / deltaPerShift)))
    : 0;

  const longSet = new Set();
  if (upgrades > 0) {
    for (let i = 0; i < upgrades; i++) {
      longSet.add(Math.floor(i * n / upgrades + n / (2 * upgrades)));
    }
  }
  return available.map((day, i) => ({
    day,
    windowLen: longSet.has(i) ? base + 0.5 : base,
  }));
}

function simulateTotals(driver, plan) {
  const preset = SHIFT_PRESETS[driver.defaultShift] || SHIFT_PRESETS.frueh;
  const totals = {
    shiftCount: plan.length, baseHours: 0, baseWage: 0, bonusWage: 0, totalWage: 0,
    categories: { night25: 0, night40: 0, sunday: 0, holiday125: 0, holiday150: 0 },
  };
  for (const p of plan) {
    const end = endTimeFromStart(preset.start, p.windowLen);
    const shift = { start: preset.start, end, type: driver.defaultShift };
    const w = computeShiftWage(shift, dateKey(p.day), driver);
    totals.baseHours += w.baseHours;
    totals.baseWage += w.baseWage;
    totals.bonusWage += w.bonusWage;
    totals.totalWage += w.totalWage;
    for (const k of Object.keys(totals.categories)) totals.categories[k] += w.categories[k] || 0;
  }
  return totals;
}

function generatePlanForDriver(driver, dateInMonth) {
  const first = startOfMonth(dateInMonth);
  const monthPrefix = `${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, "0")}`;
  for (const k of Object.keys(state.shifts)) {
    if (k.startsWith(driver.id + ":" + monthPrefix)) delete state.shifts[k];
  }
  const plan = planForDriver(driver, dateInMonth);
  const preset = SHIFT_PRESETS[driver.defaultShift] || SHIFT_PRESETS.frueh;
  for (const p of plan) {
    const end = endTimeFromStart(preset.start, p.windowLen);
    state.shifts[`${driver.id}:${dateKey(p.day)}`] = {
      start: preset.start, end, note: "", type: driver.defaultShift,
    };
  }
  saveState();
}

function generatePlanForAll() {
  if (!confirm(`Plan für alle ${state.drivers.length} Fahrer im ${MONTH_NAMES[anchor.getMonth()]} ${anchor.getFullYear()} generieren? Bestehende Schichten werden überschrieben.`)) {
    return;
  }
  for (const d of state.drivers) generatePlanForDriver(d, anchor);
  viewMode = "month";
  render();
}

// ---------- Nav & misc ----------

function autoGrow(el) {
  el.style.height = "auto";
  el.style.height = el.scrollHeight + "px";
}

document.getElementById("prevPeriod").addEventListener("click", () => {
  anchor = viewMode === "week" ? addDays(anchor, -7) : new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1);
  render();
});

document.getElementById("nextPeriod").addEventListener("click", () => {
  anchor = viewMode === "week" ? addDays(anchor, 7) : new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1);
  render();
});

document.getElementById("viewWeek").addEventListener("click", () => { viewMode = "week"; render(); });
document.getElementById("viewMonth").addEventListener("click", () => { viewMode = "month"; render(); });
document.getElementById("addDriver").addEventListener("click", () => openDriverDialog("new"));
document.getElementById("generateAll").addEventListener("click", generatePlanForAll);
document.getElementById("printBtn").addEventListener("click", () => window.print());
document.getElementById("exportCsv").addEventListener("click", exportCSV);
document.getElementById("exportXls").addEventListener("click", exportExcel);
document.getElementById("stundenzettel").addEventListener("click", () => {
  if (!editingDriver || editingDriver === "new") return;
  openStundenzettel(editingDriver);
});
document.getElementById("importBtn").addEventListener("click", () => {
  document.getElementById("importFile").click();
});
document.getElementById("importFile").addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (file) importFile(file);
  e.target.value = "";
});

// ---------- Mode switching ----------

document.querySelectorAll(".app-tabs button").forEach((btn) => {
  btn.addEventListener("click", () => switchMode(btn.dataset.mode));
});

document.getElementById("stPrev").addEventListener("click", () => {
  anchor = new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1);
  renderStundenView();
});
document.getElementById("stNext").addEventListener("click", () => {
  anchor = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1);
  renderStundenView();
});
document.getElementById("stClear").addEventListener("click", clearStundenMonth);
document.getElementById("stPdfBtn").addEventListener("click", openAllStundenzettel);

// Drag & drop import — active whenever Stundenzettel tab is visible
(() => {
  const overlay = document.getElementById("dropOverlay");
  let depth = 0;
  const canAccept = () => appMode === "stunden";

  window.addEventListener("dragenter", (e) => {
    if (!canAccept()) return;
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    depth++;
    overlay.classList.add("active");
  });

  window.addEventListener("dragover", (e) => {
    if (!canAccept()) return;
    if (!e.dataTransfer) return;
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  });

  window.addEventListener("dragleave", (e) => {
    if (!canAccept()) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) overlay.classList.remove("active");
  });

  window.addEventListener("drop", (e) => {
    if (!canAccept()) return;
    e.preventDefault();
    depth = 0;
    overlay.classList.remove("active");
    const file = e.dataTransfer?.files?.[0];
    if (file) importFile(file);
  });
})();

function switchMode(mode) {
  appMode = mode;
  document.querySelectorAll(".app-tabs button").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === mode);
  });
  document.getElementById("schichtView").hidden = mode !== "schicht";
  document.getElementById("stundenView").hidden = mode !== "stunden";
  if (mode === "schicht") render();
  else renderStundenView();
}

function renderStundenView() {
  document.getElementById("stLabel").textContent = `${MONTH_NAMES[anchor.getMonth()]} ${anchor.getFullYear()}`;

  const first = startOfMonth(anchor);
  const last = endOfMonth(anchor);
  const days = Array.from({ length: last.getDate() }, (_, i) => addDays(first, i));

  renderGrid({
    headerElem: document.getElementById("stundenHeaderRow"),
    bodyElem: document.getElementById("stundenScheduleBody"),
    days,
    onDriverClick: (id) => openStundenzettel(id),
    onCellClick: (id, key) => openShiftDialog(id, key),
    driverMeta: (driver, totals) => {
      const target = driver.brutto || 0;
      const diff = totals.totalWage - target;
      const sign = diff >= 0 ? "+" : "";
      return `Ziel: ${fmtEuro(target)} · Arbeit: ${fmtHours(totals.baseHours)} h · Ist: ${fmtEuro(totals.totalWage)} <span class="meta-diff ${diff < 0 ? "neg" : ""}">(${sign}${fmtEuro(diff)})</span>`;
    },
  });
}

// ---------- Exports ----------

const EXPORT_HEADERS = [
  "Datum", "Wochentag", "Fahrer", "Von", "Bis", "Typ",
  "Pause (min)", "Arbeitsstunden", "Stundenlohn (€)", "Grundlohn (€)",
  "Nacht 25 % (h)", "Nacht 40 % (h)", "Sonntag (h)",
  "Feiertag 125 % (h)", "Feiertag 150 % (h)",
  "Zuschläge (€)", "Gesamt (€)", "Notiz",
];

function formatDateFull(d) {
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  return `${day}.${month}.${d.getFullYear()}`;
}

function de(n, digits = 2) {
  return n.toLocaleString("de-DE", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function buildExportRows() {
  const days = daysForView();
  const rows = [];
  for (const d of days) {
    const key = dateKey(d);
    for (const driver of state.drivers) {
      const shift = state.shifts[`${driver.id}:${key}`];
      if (!shift) continue;
      const w = computeShiftWage(shift, key, driver);
      const bd = shiftBreakdown(shift.start, shift.end);
      const type = shift.type || shiftTypeFromTimes(shift.start, shift.end);
      const typeLabel = SHIFT_PRESETS[type]?.label || "Custom";
      const c = w.categories;
      rows.push([
        formatDateFull(d),
        dowShort(d),
        driver.name,
        shift.start,
        shift.end,
        typeLabel,
        String(bd.breakMin),
        de(bd.workH),
        de(driver.hourlyRate),
        de(w.baseWage),
        de(c.night25 / 60),
        de(c.night40 / 60),
        de(c.sunday / 60),
        de(c.holiday125 / 60),
        de(c.holiday150 / 60),
        de(w.bonusWage),
        de(w.totalWage),
        shift.note || "",
      ]);
    }
  }
  return rows;
}

function periodSlug() {
  if (viewMode === "week") {
    const ws = startOfWeek(anchor);
    return `woche-${dateKey(ws)}`;
  }
  return `${anchor.getFullYear()}-${String(anchor.getMonth() + 1).padStart(2, "0")}`;
}

function downloadBlob(content, mime, filename) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
}

function csvEscape(v) {
  const s = v == null ? "" : String(v);
  if (/[";\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function exportCSV() {
  const rows = buildExportRows();
  if (rows.length === 0) {
    alert("Keine Schichten in diesem Zeitraum.");
    return;
  }
  let csv = "\uFEFF"; // UTF-8 BOM so Excel opens Umlaute correctly
  csv += EXPORT_HEADERS.join(";") + "\r\n";
  for (const r of rows) csv += r.map(csvEscape).join(";") + "\r\n";
  downloadBlob(csv, "text/csv;charset=utf-8", `schichtplan-${periodSlug()}.csv`);
}

function exportExcel() {
  const rows = buildExportRows();
  if (rows.length === 0) {
    alert("Keine Schichten in diesem Zeitraum.");
    return;
  }
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const title = `Schichtplan ${periodLabel()}`;
  const thead = `<tr>${EXPORT_HEADERS.map((h) => `<th>${esc(h)}</th>`).join("")}</tr>`;
  const tbody = rows.map((r) => `<tr>${r.map((v) => `<td>${esc(v)}</td>`).join("")}</tr>`).join("");
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="UTF-8">
<title>${esc(title)}</title>
<xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet><x:Name>Schichtplan</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml>
<style>th { background: #eee; font-weight: bold; } th, td { border: 1px solid #999; padding: 4px 6px; font-family: Arial, sans-serif; font-size: 11px; }</style>
</head>
<body>
<h2>${esc(title)}</h2>
<table>${thead}${tbody}</table>
</body>
</html>`;
  downloadBlob("\uFEFF" + html, "application/vnd.ms-excel;charset=utf-8", `schichtplan-${periodSlug()}.xls`);
}

// ---------- Stundenzettel ----------

function stundenzettelBodyHTML(driver, month) {
  const first = startOfMonth(month);
  const last = endOfMonth(month);
  const entries = [];
  for (let day = 1; day <= last.getDate(); day++) {
    const d = new Date(first.getFullYear(), first.getMonth(), day);
    const key = dateKey(d);
    const shift = state.shifts[`${driver.id}:${key}`];
    if (!shift) continue;
    const bd = shiftBreakdown(shift.start, shift.end);
    const w = computeShiftWage(shift, key, driver);
    entries.push({
      dateStr: formatDateFull(d), dow: dowShort(d),
      start: shift.start, end: shift.end,
      breakMin: bd.breakMin, workH: bd.workH,
      bonusWage: w.bonusWage, totalWage: w.totalWage,
      note: shift.note || "",
    });
  }

  const totalWork = entries.reduce((s, e) => s + e.workH, 0);
  const totalBonus = entries.reduce((s, e) => s + e.bonusWage, 0);
  const totalWage = entries.reduce((s, e) => s + e.totalWage, 0);
  const sollH = driver.hourlyRate > 0 ? driver.brutto / driver.hourlyRate : 0;

  const esc = escapeHtml;
  const rowsHtml = entries.map((e) => `<tr>
    <td>${e.dateStr}</td><td>${e.dow}</td>
    <td class="num">${e.start}</td><td class="num">${e.end}</td>
    <td class="num">${e.breakMin > 0 ? e.breakMin + " min" : "–"}</td>
    <td class="num">${de(e.workH)} h</td>
    <td>${esc(e.note)}</td>
  </tr>`).join("");

  return `<section class="sheet">
    <div class="header">
      <h1>Stundenzettel</h1>
      <div class="sub">${MONTH_NAMES[month.getMonth()]} ${month.getFullYear()}</div>
    </div>
    <div class="info">
      <div><b>Arbeitnehmer:in</b><span>${esc(driver.name)}</span></div>
      <div><b>Stundenlohn</b><span class="val">${fmtEuro2(driver.hourlyRate)}</span></div>
      <div><b>Soll-Stunden</b><span class="val">${de(sollH)} h</span></div>
    </div>
    <table>
      <thead><tr>
        <th>Datum</th><th>Tag</th><th>Beginn</th><th>Ende</th><th>Pause</th><th>Arbeitszeit</th><th>Notiz</th>
      </tr></thead>
      <tbody>${rowsHtml || '<tr><td colspan="7" style="text-align:center;color:#999;padding:20px">Keine Schichten in diesem Monat</td></tr>'}</tbody>
    </table>
    <div class="totals">
      <div class="totals-row"><span>Ist-Stunden</span><span class="val">${de(totalWork)} h</span></div>
      <div class="totals-row"><span>Soll-Stunden</span><span class="val">${de(sollH)} h</span></div>
      <div class="totals-row"><span>Differenz</span><span class="val">${de(totalWork - sollH)} h</span></div>
      <div class="totals-row"><span>Grundlohn</span><span class="val">${fmtEuro2(totalWage - totalBonus)}</span></div>
      <div class="totals-row"><span>Zuschläge §3b EStG</span><span class="val">${fmtEuro2(totalBonus)}</span></div>
      <div class="totals-row big"><span>Gesamtlohn</span><span class="val">${fmtEuro2(totalWage)}</span></div>
    </div>
    <div class="signatures">
      <div class="sig">Datum, Unterschrift Arbeitnehmer:in</div>
      <div class="sig">Datum, Unterschrift Arbeitgeber:in</div>
    </div>
  </section>`;
}

function stundenzettelWindowHTML(title, bodyContent, previewLabel) {
  return `<!DOCTYPE html>
<html lang="de"><head>
  <meta charset="UTF-8">
  <title>${escapeHtml(title)}</title>
  <style>
    @page { size: portrait; margin: 15mm; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; color: #111; font-size: 12px; margin: 0; background: #e5e5e5; }
    .toolbar { position: sticky; top: 0; background: #1f2328; color: white; padding: 12px 20px; display: flex; justify-content: space-between; align-items: center; z-index: 10; box-shadow: 0 2px 8px rgba(0,0,0,0.2); }
    .toolbar .title { font-size: 14px; font-weight: 500; }
    .toolbar .right { display: flex; gap: 8px; }
    .toolbar button { padding: 8px 16px; border: 1px solid #555; background: transparent; color: white; cursor: pointer; font-size: 13px; border-radius: 6px; font-family: inherit; }
    .toolbar button.primary { background: #5b8def; border-color: #5b8def; }
    .toolbar button.primary:hover { background: #4a7adf; }
    .toolbar button:hover { border-color: #888; }
    .preview { max-width: 210mm; margin: 24px auto; }
    .sheet { background: white; padding: 24mm 18mm; box-shadow: 0 2px 16px rgba(0,0,0,0.1); margin-bottom: 20px; }
    .sheet + .sheet { page-break-before: always; }
    .header { border-bottom: 2px solid #333; padding-bottom: 12px; margin-bottom: 20px; }
    .header h1 { margin: 0 0 4px; font-size: 20px; letter-spacing: 0.02em; }
    .header .sub { color: #666; font-size: 13px; }
    .info { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 20px; margin-bottom: 20px; }
    .info b { color: #666; font-weight: 500; display: block; font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 2px; }
    .info span { font-size: 14px; font-weight: 500; }
    .info .val { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    table { width: 100%; border-collapse: collapse; font-size: 11px; font-variant-numeric: tabular-nums; }
    th, td { border: 1px solid #999; padding: 6px 8px; text-align: left; }
    th { background: #f0f0f0; font-weight: 600; }
    td.num { text-align: right; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .totals { margin-top: 16px; padding: 12px 16px; background: #f5f5f5; border: 1px solid #999; }
    .totals-row { display: flex; justify-content: space-between; font-size: 13px; margin-bottom: 4px; }
    .totals-row.big { font-size: 15px; font-weight: 600; border-top: 1px solid #999; padding-top: 6px; margin-top: 6px; }
    .totals-row .val { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .signatures { margin-top: 48px; display: grid; grid-template-columns: 1fr 1fr; gap: 48px; }
    .sig { border-top: 1px solid #333; padding-top: 6px; font-size: 10px; color: #666; }
    @media print {
      body { background: white; }
      .toolbar { display: none; }
      .preview { max-width: none; margin: 0; }
      .sheet { padding: 0; box-shadow: none; margin: 0; }
      th, td { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    }
  </style>
</head><body>
  <div class="toolbar">
    <div class="title">Vorschau · ${escapeHtml(previewLabel)}</div>
    <div class="right">
      <button onclick="window.close()">Schließen</button>
      <button class="primary" onclick="window.print()">Drucken / als PDF speichern</button>
    </div>
  </div>
  <div class="preview">
    ${bodyContent}
  </div>
</body></html>`;
}

function openInWindow(html) {
  const w = window.open("", "_blank", "width=900,height=1200");
  if (!w) { alert("Bitte Pop-ups für diese Seite erlauben."); return; }
  w.document.open();
  w.document.write(html);
  w.document.close();
}

function openStundenzettel(driverId) {
  const driver = state.drivers.find((d) => d.id === driverId);
  if (!driver) return;
  const monthLabel = `${MONTH_NAMES[anchor.getMonth()]} ${anchor.getFullYear()}`;
  const body = stundenzettelBodyHTML(driver, anchor);
  const html = stundenzettelWindowHTML(
    `Stundenzettel – ${driver.name} – ${monthLabel}`,
    body,
    `${driver.name} · ${monthLabel}`
  );
  openInWindow(html);
}

function openAllStundenzettel() {
  if (state.drivers.length === 0) {
    alert("Keine Fahrer:innen vorhanden.");
    return;
  }
  const monthLabel = `${MONTH_NAMES[anchor.getMonth()]} ${anchor.getFullYear()}`;
  const body = state.drivers.map((d) => stundenzettelBodyHTML(d, anchor)).join("\n");
  const html = stundenzettelWindowHTML(
    `Stundenzettel – ${monthLabel}`,
    body,
    `${state.drivers.length} Fahrer:innen · ${monthLabel}`
  );
  openInWindow(html);
}

function clearStundenMonth() {
  const label = `${MONTH_NAMES[anchor.getMonth()]} ${anchor.getFullYear()}`;
  const first = startOfMonth(anchor);
  const monthPrefix = `${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, "0")}`;
  const count = Object.keys(state.shifts).filter((k) => k.includes(":" + monthPrefix)).length;
  if (count === 0) { alert(`Keine Schichten im ${label}.`); return; }
  if (!confirm(`${count} Schichten im ${label} löschen? Fahrer:innen bleiben erhalten.`)) return;
  for (const k of Object.keys(state.shifts)) {
    if (k.includes(":" + monthPrefix)) delete state.shifts[k];
  }
  saveState();
  renderStundenView();
  if (appMode === "schicht") render();
}

// ---------- Import ----------

function parseCSV(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const firstLine = text.split(/\r?\n/)[0] || "";
  const sep = (firstLine.match(/;/g) || []).length >= (firstLine.match(/,/g) || []).length ? ";" : ",";

  const out = [];
  let row = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === sep) { row.push(cur); cur = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(cur); cur = "";
        if (row.some((v) => v !== "")) out.push(row);
        row = [];
      } else cur += c;
    }
  }
  if (cur !== "" || row.length) { row.push(cur); if (row.some((v) => v !== "")) out.push(row); }
  return out;
}

function parseHTMLTable(text) {
  const doc = new DOMParser().parseFromString(text, "text/html");
  const table = doc.querySelector("table");
  if (!table) throw new Error("Keine Tabelle in der Datei gefunden.");
  return Array.from(table.querySelectorAll("tr")).map((tr) =>
    Array.from(tr.querySelectorAll("th,td")).map((td) => td.textContent.trim())
  );
}

function findColumn(headers, candidates) {
  for (const cand of candidates) {
    const idx = headers.findIndex((h) => h.toLowerCase().includes(cand));
    if (idx >= 0) return idx;
  }
  return -1;
}

function parseImportDate(s) {
  s = (s || "").trim();
  let m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = "20" + y;
    return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`;
  return null;
}

function parseImportTime(s) {
  s = (s || "").trim();
  const m = s.match(/^(\d{1,2})[:.]?(\d{0,2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = m[2] ? Number(m[2]) : 0;
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
}

function applyImportRows(rows) {
  if (rows.length < 2) throw new Error("Datei leer oder nur Header.");
  const headers = rows[0].map((h) => (h || "").trim().toLowerCase());
  const col = {
    date: findColumn(headers, ["datum", "date"]),
    driver: findColumn(headers, ["fahrer", "name", "arbeitnehmer"]),
    start: findColumn(headers, ["von", "beginn", "start"]),
    end: findColumn(headers, ["bis", "ende", "end"]),
    type: findColumn(headers, ["typ", "schicht"]),
    note: findColumn(headers, ["notiz", "bemerkung", "note"]),
  };
  if (col.date < 0 || col.driver < 0 || col.start < 0 || col.end < 0) {
    throw new Error("Spalten nicht erkannt. Benötigt: Datum, Fahrer, Von, Bis.");
  }

  let imported = 0, createdDrivers = 0, skipped = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const dateStr = parseImportDate(r[col.date]);
    const name = (r[col.driver] || "").trim();
    const start = parseImportTime(r[col.start]);
    const end = parseImportTime(r[col.end]);
    if (!dateStr || !name || !start || !end) { skipped++; continue; }

    let driver = state.drivers.find((d) => d.name.toLowerCase() === name.toLowerCase());
    if (!driver) {
      driver = { id: "d" + Date.now() + "_" + state.drivers.length, name, ...DEFAULT_DRIVER };
      state.drivers.push(driver);
      createdDrivers++;
    }

    let type;
    if (col.type >= 0 && r[col.type]) {
      const lbl = r[col.type].trim().toLowerCase();
      if (lbl.startsWith("früh") || lbl === "frueh") type = "frueh";
      else if (lbl.startsWith("spät") || lbl === "spaet") type = "spaet";
      else if (lbl.startsWith("nacht")) type = "nacht";
      else type = shiftTypeFromTimes(start, end);
    } else {
      type = shiftTypeFromTimes(start, end);
    }

    const note = col.note >= 0 ? (r[col.note] || "").trim() : "";
    state.shifts[`${driver.id}:${dateStr}`] = { start, end, type, note };
    imported++;
  }

  saveState();
  return { imported, createdDrivers, skipped };
}

async function importFile(file) {
  try {
    const text = await file.text();
    const rows = text.trimStart().startsWith("<") ? parseHTMLTable(text) : parseCSV(text);
    const result = applyImportRows(rows);
    const parts = [`${result.imported} Schichten importiert`];
    if (result.createdDrivers > 0) parts.push(`${result.createdDrivers} neue Fahrer angelegt`);
    if (result.skipped > 0) parts.push(`${result.skipped} Zeilen übersprungen`);
    alert(parts.join(", ") + ".");
    if (appMode === "stunden") renderStundenView();
    else render();
  } catch (err) {
    alert("Import fehlgeschlagen: " + err.message);
  }
}

render();
