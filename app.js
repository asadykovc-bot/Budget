const STORAGE_KEY = "budgetPwaStateV1";
const EXPORT_APP = "budget-pwa";
const EXPORT_VERSION = 1;
const DAY = 86400000;

const defaultState = () => ({
  budget: 200,
  spent: 0,
  reserve: 0,
  weekStart: getThisMonday(),
  expenses: [],
  debt: {
    left: 0,
    weeksLeft: 0,
    weeklyPayment: 0
  },
  debtEvents: [],
  lastWeekSummary: null
});

let state = defaultState();

const $ = (id) => document.getElementById(id);

function getThisMonday(date = new Date()) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function todayISO() {
  return new Date().toLocaleDateString("en-CA");
}

function normalizeMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function fmt(value) {
  const n = normalizeMoney(value);
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function activeDebt() {
  if (!state.debt || state.debt.left <= 0 || state.debt.weeksLeft <= 0) {
    return { left: 0, weeksLeft: 0, weeklyPayment: 0 };
  }
  const weeklyPayment = normalizeMoney(state.debt.left / state.debt.weeksLeft);
  return {
    left: normalizeMoney(state.debt.left),
    weeksLeft: Math.max(0, Math.floor(state.debt.weeksLeft)),
    weeklyPayment
  };
}

function effectiveBudget() {
  return normalizeMoney(state.budget - activeDebt().weeklyPayment);
}

function netRemaining() {
  return normalizeMoney(effectiveBudget() - state.spent);
}

function load() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    try {
      state = migrateState(JSON.parse(saved));
    } catch {
      state = defaultState();
    }
  }
  checkWeekReset();
  save();
  bindEvents();
  render();
  registerServiceWorker();
}

function migrateState(input) {
  const next = { ...defaultState(), ...(input || {}) };
  next.budget = normalizeMoney(next.budget);
  next.spent = normalizeMoney(next.spent);
  next.reserve = normalizeMoney(next.reserve);
  next.weekStart = Number(next.weekStart) || getThisMonday();
  next.expenses = Array.isArray(next.expenses) ? next.expenses : [];
  next.debtEvents = Array.isArray(next.debtEvents) ? next.debtEvents : [];
  next.debt = {
    left: normalizeMoney(next.debt?.left),
    weeksLeft: Math.max(0, Math.floor(Number(next.debt?.weeksLeft) || 0)),
    weeklyPayment: normalizeMoney(next.debt?.weeklyPayment)
  };
  return next;
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function checkWeekReset() {
  const monday = getThisMonday();
  if (state.weekStart >= monday) return;

  const previousEffectiveBudget = effectiveBudget();
  const leftover = normalizeMoney(previousEffectiveBudget - state.spent);
  const debtBefore = activeDebt();
  let debtPaid = 0;

  if (leftover > 0) {
    state.reserve = normalizeMoney(state.reserve + leftover);
  }

  if (debtBefore.left > 0) {
    debtPaid = Math.min(debtBefore.left, debtBefore.weeklyPayment);
    const left = normalizeMoney(debtBefore.left - debtPaid);
    const weeksLeft = Math.max(0, debtBefore.weeksLeft - 1);
    state.debt = left > 0 && weeksLeft > 0
      ? { left, weeksLeft, weeklyPayment: normalizeMoney(left / weeksLeft) }
      : { left: 0, weeksLeft: 0, weeklyPayment: 0 };
  }

  state.lastWeekSummary = {
    spent: normalizeMoney(state.spent),
    budget: previousEffectiveBudget,
    savedToReserve: leftover > 0 ? leftover : 0,
    overspent: leftover < 0 ? Math.abs(leftover) : 0,
    debtPaid
  };

  state.weekStart = monday;
  state.spent = 0;
  state.expenses = state.expenses.filter((expense) => expense.weekStart === monday);
}

function bindEvents() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  });

  $("addExpenseBtn").addEventListener("click", addExpense);
  $("expenseAmount").addEventListener("keydown", submitOnEnter(addExpense));
  $("expenseDesc").addEventListener("keydown", submitOnEnter(addExpense));

  $("planAmount").addEventListener("input", renderPlanPreview);
  $("planWeeks").addEventListener("input", renderPlanPreview);
  $("confirmPlanBtn").addEventListener("click", confirmPlan);

  $("payAmount").addEventListener("input", renderPaymentPreview);
  $("maxPayBtn").addEventListener("click", fillMaxPayment);
  $("confirmPayBtn").addEventListener("click", confirmPayment);

  $("saveBudgetBtn").addEventListener("click", saveBudget);
  $("saveReserveBtn").addEventListener("click", saveReserve);
  $("setupDebtBtn").addEventListener("click", setupDebt);
  $("exportBtn").addEventListener("click", exportData);
  $("importFile").addEventListener("change", importData);
  $("resetWeekBtn").addEventListener("click", resetWeek);
  $("resetAllBtn").addEventListener("click", resetAll);

  window.addEventListener("focus", () => {
    checkWeekReset();
    save();
    render();
  });
}

function submitOnEnter(action) {
  return (event) => {
    if (event.key === "Enter") action();
  };
}

function switchTab(name) {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === name);
  });
  document.querySelectorAll(".panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `panel-${name}`);
  });
  renderPlanPreview();
  renderPaymentPreview();
}

function addExpense() {
  const amount = normalizeMoney($("expenseAmount").value);
  const desc = $("expenseDesc").value.trim() || "Expense";
  if (amount <= 0) return;

  const remainingBefore = netRemaining();
  const reserveUsed = Math.max(0, amount - Math.max(0, remainingBefore));
  if (reserveUsed > 0) {
    state.reserve = normalizeMoney(state.reserve - reserveUsed);
  }

  state.spent = normalizeMoney(state.spent + amount);
  state.expenses.unshift({
    id: Date.now(),
    amount,
    desc,
    date: todayISO(),
    reserveUsed,
    weekStart: state.weekStart
  });

  $("expenseAmount").value = "";
  $("expenseDesc").value = "";
  save();
  render();
}

function deleteExpense(id) {
  const expense = state.expenses.find((item) => item.id === id);
  if (!expense) return;
  state.spent = normalizeMoney(Math.max(0, state.spent - expense.amount));
  if (expense.reserveUsed > 0) {
    state.reserve = normalizeMoney(state.reserve + expense.reserveUsed);
  }
  state.expenses = state.expenses.filter((item) => item.id !== id);
  save();
  render();
}

function planValues() {
  const newMoney = normalizeMoney($("planAmount").value);
  const weeks = Math.floor(Number($("planWeeks").value) || 0);
  const current = activeDebt();
  const resultingDebt = normalizeMoney(current.left + Math.max(0, newMoney));
  return { newMoney, weeks, current, resultingDebt };
}

function renderPlanPreview() {
  const { newMoney, weeks, resultingDebt } = planValues();
  const valid = resultingDebt > 0 && weeks > 0 && newMoney >= 0;
  $("planPreview").hidden = !valid;
  $("confirmPlanBtn").disabled = !valid;
  if (!valid) return;

  const weekly = normalizeMoney(resultingDebt / weeks);
  const available = normalizeMoney(state.budget - weekly);
  $("previewDebt").textContent = fmt(resultingDebt);
  $("previewWeekly").textContent = `-${fmt(weekly)}/wk`;
  $("previewAvailable").textContent = fmt(available);
  $("previewAvailable").style.color = colorForMoney(available);
}

function confirmPlan() {
  const { newMoney, weeks, current, resultingDebt } = planValues();
  if (resultingDebt <= 0 || weeks <= 0 || newMoney < 0) return;

  const weeklyPayment = normalizeMoney(resultingDebt / weeks);
  state.debt = { left: resultingDebt, weeksLeft: weeks, weeklyPayment };
  state.debtEvents.unshift({
    id: Date.now(),
    type: newMoney > 0 ? "new-credit" : "refinance",
    amount: newMoney,
    previousDebt: current.left,
    resultingDebt,
    weeks,
    weeklyPayment,
    desc: $("planDesc").value.trim(),
    date: todayISO()
  });

  $("planAmount").value = "";
  $("planWeeks").value = "";
  $("planDesc").value = "";
  save();
  render();
}

function fillMaxPayment() {
  const debt = activeDebt();
  const max = Math.min(Math.max(0, state.reserve), debt.left);
  $("payAmount").value = max ? max.toFixed(2) : "";
  renderPaymentPreview();
}

function paymentValues() {
  const amount = normalizeMoney($("payAmount").value);
  const debt = activeDebt();
  const validAmount = Math.min(Math.max(0, amount), debt.left);
  const newDebt = normalizeMoney(debt.left - validAmount);
  const weeks = newDebt > 0 ? debt.weeksLeft : 0;
  const weekly = newDebt > 0 && weeks > 0 ? normalizeMoney(newDebt / weeks) : 0;
  return { amount, validAmount, debt, newDebt, weeks, weekly };
}

function renderPaymentPreview() {
  const { amount, validAmount, debt, newDebt, weekly } = paymentValues();
  const valid = debt.left > 0 && amount > 0 && validAmount <= state.reserve;
  $("payPreview").hidden = !valid;
  $("confirmPayBtn").disabled = !valid;
  if (!valid) return;

  $("payDebt").textContent = fmt(newDebt);
  $("payWeekly").textContent = `-${fmt(weekly)}/wk`;
  $("payReserve").textContent = fmt(state.reserve - validAmount);
}

function confirmPayment() {
  const { validAmount, debt, newDebt, weeks, weekly } = paymentValues();
  if (debt.left <= 0 || validAmount <= 0 || validAmount > state.reserve) return;

  state.reserve = normalizeMoney(state.reserve - validAmount);
  state.debt = newDebt > 0
    ? { left: newDebt, weeksLeft: weeks, weeklyPayment: weekly }
    : { left: 0, weeksLeft: 0, weeklyPayment: 0 };
  state.debtEvents.unshift({
    id: Date.now(),
    type: "reserve-payment",
    amount: validAmount,
    previousDebt: debt.left,
    resultingDebt: newDebt,
    weeks,
    weeklyPayment: weekly,
    date: todayISO()
  });

  $("payAmount").value = "";
  save();
  render();
}

function saveBudget() {
  const value = normalizeMoney($("budgetSetting").value);
  if (value <= 0) return;
  state.budget = value;
  save();
  render();
}

function saveReserve() {
  state.reserve = normalizeMoney($("reserveSetting").value);
  save();
  render();
}

function setupDebt() {
  const left = normalizeMoney($("setupDebt").value);
  const weeksLeft = Math.floor(Number($("setupWeeks").value) || 0);
  if (left < 0 || weeksLeft < 0) return;

  const weeklyPayment = left > 0 && weeksLeft > 0 ? normalizeMoney(left / weeksLeft) : 0;
  state.debt = left > 0 && weeksLeft > 0
    ? { left, weeksLeft, weeklyPayment }
    : { left: 0, weeksLeft: 0, weeklyPayment: 0 };
  state.debtEvents.unshift({
    id: Date.now(),
    type: "setup",
    amount: left,
    previousDebt: 0,
    resultingDebt: left,
    weeks: weeksLeft,
    weeklyPayment,
    date: todayISO()
  });
  $("setupDebt").value = "";
  $("setupWeeks").value = "";
  save();
  render();
}

function resetWeek() {
  if (!confirm("Reset current week? Expenses for this week will be removed.")) return;
  state.spent = 0;
  state.expenses = state.expenses.filter((expense) => expense.weekStart !== state.weekStart);
  save();
  render();
}

function resetAll() {
  if (!confirm("Reset everything? This cannot be undone.")) return;
  state = defaultState();
  save();
  render();
}

function exportData() {
  const payload = {
    app: EXPORT_APP,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    state
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `budget-backup-${todayISO()}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  setNote("Export created.");
}

function importData(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const payload = JSON.parse(String(reader.result));
      if (payload.app !== EXPORT_APP || !payload.state) {
        throw new Error("Wrong backup file.");
      }
      if (!confirm("Import data? Current data on this device will be replaced.")) return;
      state = migrateState(payload.state);
      checkWeekReset();
      save();
      render();
      setNote("Import complete.");
    } catch (error) {
      setNote(error.message || "Import failed.");
    } finally {
      event.target.value = "";
    }
  };
  reader.readAsText(file);
}

function setNote(text) {
  $("backupNote").textContent = text;
}

function colorForMoney(value) {
  if (value < 0) return "var(--red)";
  if (value < 50) return "var(--yellow)";
  return "var(--green)";
}

function render() {
  checkWeekReset();
  const debt = activeDebt();
  const budget = effectiveBudget();
  const remaining = netRemaining();
  const spentPct = budget > 0 ? Math.min(100, Math.max(0, (state.spent / budget) * 100)) : 100;
  const leftPct = Math.max(0, 100 - spentPct);
  const weekStart = new Date(state.weekStart);
  const weekEnd = new Date(state.weekStart + 6 * DAY);

  $("weekLabel").textContent = `${formatShortDate(weekStart)} - ${formatShortDate(weekEnd)}`;
  $("weekDates").textContent = `Week of ${formatShortDate(weekStart)}`;
  $("remainingDisplay").textContent = fmt(remaining);
  $("remainingDisplay").style.color = colorForMoney(remaining);
  $("spentDisplay").textContent = `spent ${fmt(state.spent)} of ${fmt(budget)}`;
  $("progressFill").style.width = `${leftPct}%`;
  $("progressFill").style.background = leftPct > 50 ? "var(--green)" : leftPct > 20 ? "var(--yellow)" : "var(--red)";
  $("progressLeft").textContent = `${fmt(Math.max(0, remaining))} left`;
  $("progressBudget").textContent = `of ${fmt(budget)}`;
  $("debtWeeklyDisplay").textContent = `-${fmt(debt.weeklyPayment)}/wk`;
  $("reserveDisplay").textContent = fmt(state.reserve);
  $("reserveDisplay").style.color = colorForMoney(state.reserve);

  $("alertReserve").hidden = !(remaining <= 0 && state.reserve >= 0);
  $("alertNegative").hidden = !(state.reserve < 0);
  $("minusBanner").hidden = !(state.reserve < 0);

  renderWeekSummary();
  renderExpenses();
  renderDebt(debt);
  renderDebtEvents();
  renderSettings();
  renderPlanPreview();
  renderPaymentPreview();
}

function formatShortDate(date) {
  return date.toLocaleDateString("en-CA", { month: "short", day: "numeric" });
}

function renderWeekSummary() {
  const summary = state.lastWeekSummary;
  $("weekSummary").hidden = !summary;
  if (!summary) return;

  const parts = [`spent ${fmt(summary.spent)} of ${fmt(summary.budget)}`];
  if (summary.savedToReserve > 0) parts.push(`saved ${fmt(summary.savedToReserve)} to reserve`);
  if (summary.overspent > 0) parts.push(`overspent by ${fmt(summary.overspent)}`);
  if (summary.debtPaid > 0) parts.push(`paid ${fmt(summary.debtPaid)} debt`);
  $("weekSummaryText").textContent = `Last week: ${parts.join(", ")}.`;
}

function renderExpenses() {
  const expenses = state.expenses.filter((expense) => expense.weekStart === state.weekStart);
  const container = $("historyContainer");
  if (!expenses.length) {
    container.innerHTML = `<div class="empty-state">No expenses this week</div>`;
    return;
  }

  container.innerHTML = expenses.map((expense) => `
    <div class="list-item">
      <div>
        <div class="item-title">${escapeHTML(expense.desc)}</div>
        <div class="item-meta">${expense.date}${expense.reserveUsed > 0 ? ` / reserve ${fmt(expense.reserveUsed)}` : ""}</div>
      </div>
      <div class="item-actions">
        <span class="item-amount ${expense.reserveUsed > 0 ? "yellow" : ""}">-${fmt(expense.amount)}</span>
        <button class="delete-btn" type="button" aria-label="Delete expense" data-expense-id="${expense.id}">x</button>
      </div>
    </div>
  `).join("");

  container.querySelectorAll("[data-expense-id]").forEach((button) => {
    button.addEventListener("click", () => deleteExpense(Number(button.dataset.expenseId)));
  });
}

function renderDebt(debt) {
  $("debtLeftDisplay").textContent = fmt(debt.left);
  $("debtTermDisplay").textContent = debt.left > 0
    ? `${debt.weeksLeft} weeks left`
    : "No active debt";
  $("debtPaymentDisplay").textContent = `-${fmt(debt.weeklyPayment)}/wk`;
  $("afterDebtDisplay").textContent = fmt(effectiveBudget());
  $("afterDebtDisplay").style.color = colorForMoney(effectiveBudget());
}

function renderDebtEvents() {
  const container = $("debtEventsContainer");
  if (!state.debtEvents.length) {
    container.innerHTML = `<div class="empty-state">No credit events yet</div>`;
    return;
  }

  container.innerHTML = state.debtEvents.map((event) => {
    const title = eventTitle(event);
    const amountClass = event.type === "reserve-payment" ? "green" : "yellow";
    return `
      <div class="list-item">
        <div>
          <div class="item-title">${escapeHTML(title)}</div>
          <div class="item-meta">${event.date} / debt ${fmt(event.resultingDebt)} / ${event.weeks} weeks / -${fmt(event.weeklyPayment)}/wk</div>
        </div>
        <span class="item-amount ${amountClass}">${event.type === "reserve-payment" ? "-" : "+"}${fmt(event.amount)}</span>
      </div>
    `;
  }).join("");
}

function eventTitle(event) {
  if (event.type === "new-credit") return event.desc || "New credit";
  if (event.type === "refinance") return event.desc || "Refinance";
  if (event.type === "reserve-payment") return "Paid from reserve";
  if (event.type === "setup") return "Initial debt setup";
  return "Credit event";
}

function renderSettings() {
  $("budgetSetting").value = state.budget;
  $("reserveSetting").value = state.reserve;
}

function escapeHTML(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("./service-worker.js?v=4").catch(() => {});
}

setInterval(() => {
  checkWeekReset();
  save();
  render();
}, 60000);

load();
