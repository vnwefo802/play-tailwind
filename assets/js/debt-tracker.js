// ===== Debt Tracker =====
// All money is stored as whole pence to avoid rounding errors.
// Data is saved in this browser only (localStorage).

(function (root) {
  const STORAGE_KEY = "debtTracker.v1";

  const PAYS_PER_YEAR = {
    weekly: 52,
    fortnightly: 26,
    fourWeekly: 13,
    monthly: 12,
  };

  const PAY_INTERVAL_DAYS = { weekly: 7, fortnightly: 14, fourWeekly: 28 };

  const MAX_MONTHS = 600;

  // ===== Calculations (no DOM) =====

  function toPence(value) {
    const n = parseFloat(String(value).replace(/[£,\s]/g, ""));
    return Number.isFinite(n) ? Math.round(n * 100) : NaN;
  }

  function sum(list, pick) {
    return list.reduce((total, item) => total + pick(item), 0);
  }

  function paidOn(state, debtId) {
    return sum(
      state.payments.filter((p) => p.debtId === debtId),
      (p) => p.amount
    );
  }

  function remainingOn(state, debt) {
    return Math.max(debt.amount - paidOn(state, debt.id), 0);
  }

  function toMonthly(amount, frequency) {
    return Math.round((amount * PAYS_PER_YEAR[frequency]) / 12);
  }

  function perPayday(monthlyAmount, frequency) {
    return Math.round((monthlyAmount * 12) / PAYS_PER_YEAR[frequency]);
  }

  // "smallest": smallest balance first. "due": earliest pay-off deadline
  // first (debts with no deadline go last).
  function orderDebts(debts, strategy) {
    return debts.slice().sort((a, b) => {
      if (strategy === "due" && (a.deadline || "") !== (b.deadline || "")) {
        if (!a.deadline) return 1;
        if (!b.deadline) return -1;
        return a.deadline < b.deadline ? -1 : 1;
      }
      return a.balance - b.balance;
    });
  }

  // Money goes to the top debt in the order until it's cleared, then the next.
  function allocate(debts, budget, strategy) {
    const ordered = orderDebts(
      debts.filter((d) => d.balance > 0),
      strategy
    );
    const result = {};
    let left = budget;

    ordered.forEach((d) => {
      const pay = Math.min(d.balance, left);
      result[d.id] = pay;
      left -= pay;
    });

    return { allocation: result, unused: left };
  }

  function buildPlan(state) {
    const { pay, essentials, plan } = state;
    const monthlyIncome = pay.amount ? toMonthly(pay.amount, pay.frequency) : 0;
    const essentialsTotal = sum(essentials, (e) => e.amount);
    const leftover = monthlyIncome - essentialsTotal;
    const buffer = Math.round(
      (Math.max(leftover, 0) * plan.bufferPercent) / 100
    );
    const debtBudget = Math.max(leftover - buffer, 0);

    const debts = state.debts.map((d) => ({
      id: d.id,
      name: d.name,
      deadline: d.deadline || "",
      balance: remainingOn(state, d),
    }));

    const { allocation, unused } = allocate(debts, debtBudget, plan.strategy);

    return {
      monthlyIncome,
      essentialsTotal,
      leftover,
      buffer,
      debtBudget,
      allocation,
      unused,
      order: orderDebts(
        debts.filter((d) => d.balance > 0),
        plan.strategy
      ).map((d) => d.id),
      forecast: forecast(debts, debtBudget, plan.strategy),
    };
  }

  // Month-by-month simulation of the plan (no interest).
  function forecast(debts, budget, strategy) {
    let balances = debts
      .filter((d) => d.balance > 0)
      .map((d) => Object.assign({}, d));
    const payoffMonth = {};

    if (balances.length === 0) {
      return { months: 0, payoffMonth, possible: true };
    }
    if (budget <= 0) {
      return { months: null, payoffMonth, possible: false };
    }

    for (let month = 1; month <= MAX_MONTHS; month++) {
      const { allocation } = allocate(balances, budget, strategy);
      balances.forEach((d) => {
        d.balance -= allocation[d.id] || 0;
        if (d.balance <= 0 && !payoffMonth[d.id]) payoffMonth[d.id] = month;
      });
      balances = balances.filter((d) => d.balance > 0);

      if (balances.length === 0) {
        return { months: month, payoffMonth, possible: true };
      }
    }
    return { months: null, payoffMonth, possible: false };
  }

  function addMonths(date, months) {
    return new Date(date.getFullYear(), date.getMonth() + months, 1);
  }

  function startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  function parseDate(iso) {
    if (!iso) return null;
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d);
  }

  function daysBetween(from, to) {
    return Math.round((startOfDay(to) - startOfDay(from)) / 86400000);
  }

  // Roll a past payday forward to the next one on or after today.
  function nextPayday(iso, frequency, today) {
    let date = parseDate(iso);
    if (!date) return null;
    today = startOfDay(today);
    let guard = 0;
    while (date < today && guard++ < 1000) {
      date =
        frequency === "monthly"
          ? new Date(date.getFullYear(), date.getMonth() + 1, date.getDate())
          : new Date(
              date.getFullYear(),
              date.getMonth(),
              date.getDate() + PAY_INTERVAL_DAYS[frequency]
            );
    }
    return date;
  }

  // Progress towards an optional weekly amount and pay-off deadline, assuming
  // the weekly payments start a week from today.
  function weeklyStatus(remaining, weekly, deadline, today) {
    if (remaining <= 0 || (!weekly && !deadline)) return null;
    const days = deadline ? daysBetween(today, parseDate(deadline)) : null;
    if (days !== null && days < 0) return { kind: "late" };
    const weeksToFinish = weekly ? Math.ceil(remaining / weekly) : null;
    const finish = weekly
      ? new Date(
          today.getFullYear(),
          today.getMonth(),
          today.getDate() + weeksToFinish * 7
        )
      : null;
    if (days === null) return { kind: "estimate", finish };
    const weeksAvailable = Math.max(Math.floor(days / 7), 1);
    const needed = Math.ceil(remaining / weeksAvailable);
    if (!weekly) return { kind: "needed", needed };
    return weeksToFinish <= weeksAvailable
      ? { kind: "onTrack", finish }
      : { kind: "behind", needed };
  }

  function toIso(date) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
      date.getDate()
    )}`;
  }

  function addDays(iso, days) {
    const d = parseDate(iso);
    return toIso(new Date(d.getFullYear(), d.getMonth(), d.getDate() + days));
  }

  // "2026-11" -> every Friday in that month as ISO dates.
  function fridaysInMonth(month) {
    const [y, m] = month.split("-").map(Number);
    const days = [];
    for (let d = new Date(y, m - 1, 1); d.getMonth() === m - 1; ) {
      if (d.getDay() === 5) days.push(toIso(d));
      d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    }
    return days;
  }

  // A Friday payment belongs to the Monday-Sunday week around that Friday.
  // Each planned Friday is "paid" once a payment has been logged against it,
  // "missed" once its week is over, "thisWeek" during its week, else "later".
  function fridayPlan(debt, payments, today) {
    const now = toIso(today);
    return Object.keys(debt.schedule || {})
      .sort()
      .map((date) => {
        const paid = payments.some(
          (p) => p.debtId === debt.id && p.forFriday === date
        );
        let status = "later";
        if (paid) status = "paid";
        else if (now > addDays(date, 2)) status = "missed";
        else if (now >= addDays(date, -4)) status = "thisWeek";
        return { date, amount: debt.schedule[date], status };
      });
  }

  // The planned Friday a new payment should count towards: the earliest
  // unpaid one whose week has started by the payment date.
  function fridayForPayment(debt, payments, paymentDate) {
    const due = fridayPlan(debt, payments, parseDate(paymentDate)).find(
      (f) => f.status === "missed" || f.status === "thisWeek"
    );
    return due ? { date: due.date, missed: due.status === "missed" } : null;
  }

  const calc = {
    toPence,
    paidOn,
    remainingOn,
    toMonthly,
    perPayday,
    orderDebts,
    allocate,
    buildPlan,
    forecast,
    nextPayday,
    weeklyStatus,
    fridaysInMonth,
    fridayPlan,
    fridayForPayment,
    daysBetween,
    parseDate,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = calc;
    return;
  }

  // ===== State =====

  function emptyState() {
    return {
      version: 1,
      pay: { amount: 0, frequency: "monthly", nextPayDate: "" },
      essentials: [],
      debts: [],
      payments: [],
      plan: { strategy: "smallest", bufferPercent: 10 },
    };
  }

  function loadState() {
    try {
      const raw = root.localStorage.getItem(STORAGE_KEY);
      if (!raw) return emptyState();
      const loaded = Object.assign(emptyState(), JSON.parse(raw));
      if (!["smallest", "due"].includes(loaded.plan.strategy)) {
        loaded.plan.strategy = "smallest";
      }
      return loaded;
    } catch (e) {
      return emptyState();
    }
  }

  let storageWorks = true;

  function saveState() {
    try {
      root.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      storageWorks = true;
    } catch (e) {
      storageWorks = false;
    }
  }

  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  let state = loadState();

  // ===== Formatting =====

  const money = new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
  });

  function fmt(pence) {
    return money.format(pence / 100);
  }

  function fmtDate(date) {
    return date.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  }

  function fmtMonth(date) {
    return date.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  }

  function esc(text) {
    return String(text == null ? "" : text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function todayIso() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  const $ = (id) => document.getElementById(id);

  function flash(message, isError) {
    const el = $("flash");
    el.textContent = message;
    el.className =
      "fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg px-6 py-3 text-sm font-medium text-white shadow-lg " +
      (isError ? "bg-red-600" : "bg-secondary");
    clearTimeout(flash.timer);
    flash.timer = setTimeout(() => el.classList.add("hidden"), 3000);
  }

  // ===== Rendering =====

  function render() {
    renderSummary();
    renderDebts();
    renderPaymentForm();
    renderPayments();
    renderDueDates();
    renderPayForm();
    renderEssentials();
    renderPlan();
    $("storage-warning").classList.toggle("hidden", storageWorks);
  }

  function renderSummary() {
    const total = sum(state.debts, (d) => d.amount);
    const paid = sum(state.debts, (d) => paidOn(state, d.id));
    const left = sum(state.debts, (d) => remainingOn(state, d));
    const cleared = state.debts.filter(
      (d) => remainingOn(state, d) === 0
    ).length;
    const pct = total ? Math.round((paid / total) * 100) : 0;

    $("sum-total").textContent = fmt(total);
    $("sum-paid").textContent = fmt(paid);
    $("sum-left").textContent = fmt(left);
    $("sum-cleared").textContent = `${cleared} of ${state.debts.length}`;
    $("sum-bar").style.width = pct + "%";
    $("sum-pct").textContent = `${pct}% paid off`;
  }

  function renderDebts() {
    const list = $("debt-list");
    if (state.debts.length === 0) {
      list.innerHTML = `<p class="rounded-lg border border-dashed border-gray-300 p-6 text-center text-body-color">No debts yet. Add who you owe above.</p>`;
      return;
    }

    list.innerHTML = state.debts
      .map((d) => {
        const paid = paidOn(state, d.id);
        const left = remainingOn(state, d);
        const pct = d.amount
          ? Math.min(Math.round((paid / d.amount) * 100), 100)
          : 0;
        const done = left === 0;
        const details = [
          d.weekly ? `${fmt(d.weekly)}/week` : "",
          d.deadline ? `pay off by ${fmtDate(parseDate(d.deadline))}` : "",
        ]
          .filter(Boolean)
          .join(" · ");

        return `
        <div class="rounded-lg border ${
          done
            ? "border-secondary bg-secondary bg-opacity-5"
            : "border-gray-200 bg-white"
        } p-5">
          <div class="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h4 class="text-lg font-semibold text-dark">${esc(d.name)} ${
          done
            ? '<span class="ml-2 rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-white">Paid off</span>'
            : ""
        }</h4>
              ${
                details
                  ? `<p class="text-sm text-body-color">${esc(details)}</p>`
                  : ""
              }
              ${renderWeeklyStatus(d, left)}
              ${done ? "" : renderNextFriday(d)}
              ${
                d.notes
                  ? `<p class="mt-1 text-sm italic text-body-color">${esc(
                      d.notes
                    )}</p>`
                  : ""
              }
            </div>
            <div class="text-right">
              <p class="text-xl font-bold ${
                done ? "text-secondary" : "text-dark"
              }">${fmt(left)}</p>
              <p class="text-xs text-body-color">left of ${fmt(d.amount)}</p>
            </div>
          </div>
          <div class="mt-3 h-2 w-full overflow-hidden rounded-full bg-gray-200">
            <div class="h-full rounded-full bg-secondary" style="width:${pct}%"></div>
          </div>
          <div class="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm">
            <span class="text-body-color">${fmt(paid)} paid (${pct}%)</span>
            <span class="flex gap-3">
              ${
                done
                  ? ""
                  : `<button data-action="pay" data-id="${d.id}" class="font-medium text-primary hover:underline">Make payment</button>`
              }
              <button data-action="edit-debt" data-id="${
                d.id
              }" class="font-medium text-body-color hover:text-dark hover:underline">Edit</button>
              <button data-action="delete-debt" data-id="${
                d.id
              }" class="font-medium text-red-600 hover:underline">Delete</button>
            </span>
          </div>
        </div>`;
      })
      .join("");
  }

  function renderWeeklyStatus(d, left) {
    const status = weeklyStatus(left, d.weekly, d.deadline, new Date());
    if (!status) return "";
    const by = d.deadline ? fmtDate(parseDate(d.deadline)) : "";
    const lines = {
      late: ["text-red-600", "The pay-off deadline has passed"],
      onTrack: [
        "text-secondary",
        `On track: paid off around ${status.finish && fmtDate(status.finish)}`,
      ],
      behind: [
        "text-yellow-700",
        `Behind: pay ${fmt(status.needed)}/week to finish by ${by}`,
      ],
      estimate: [
        "text-body-color",
        `Paid off around ${
          status.finish && fmtDate(status.finish)
        } at this rate`,
      ],
      needed: [
        "text-body-color",
        `${fmt(status.needed)}/week would finish it by ${by}`,
      ],
    };
    const [colour, text] = lines[status.kind];
    return `<p class="mt-1 text-sm font-medium ${colour}">${esc(text)}</p>`;
  }

  function renderNextFriday(d) {
    const next = fridayPlan(d, state.payments, new Date()).find(
      (f) => f.status !== "paid"
    );
    if (!next) return "";
    const when = fmtFriday(next.date);
    const [colour, text] =
      next.status === "missed"
        ? [
            "text-red-600",
            `Missed Friday payment: ${fmt(next.amount)} on ${when}`,
          ]
        : next.date === todayIso()
        ? ["text-primary", `Payday today: pay ${fmt(next.amount)}`]
        : [
            "text-primary",
            `Next Friday payment: ${fmt(next.amount)} on ${when}`,
          ];
    return `<p class="mt-1 text-sm font-medium ${colour}">${esc(text)}</p>`;
  }

  function fmtFriday(iso) {
    return parseDate(iso).toLocaleDateString("en-GB", {
      weekday: "short",
      day: "numeric",
      month: "short",
    });
  }

  // What to pay now: a missed or this week's Friday amount, else the weekly
  // amount, never more than is left.
  function suggestedAmount(debt) {
    const left = remainingOn(state, debt);
    const friday = fridayPlan(debt, state.payments, new Date()).find(
      (f) => f.status === "missed" || f.status === "thisWeek"
    );
    const amount = friday ? friday.amount : debt.weekly;
    return amount ? Math.min(amount, left) : 0;
  }

  function weeklyPlaceholder() {
    const debt = state.debts.find((d) => d.id === $("payment-debt").value);
    const amount = debt ? suggestedAmount(debt) : 0;
    $("payment-amount").placeholder = amount
      ? (amount / 100).toFixed(2)
      : "0.00";
  }

  function renderPaymentForm() {
    const select = $("payment-debt");
    const current = select.value;
    const open = state.debts.filter((d) => remainingOn(state, d) > 0);
    select.innerHTML = open.length
      ? open
          .map(
            (d) =>
              `<option value="${d.id}">${esc(d.name)} (${fmt(
                remainingOn(state, d)
              )} left)</option>`
          )
          .join("")
      : `<option value="">No debts to pay</option>`;
    if (open.some((d) => d.id === current)) select.value = current;
    $("payment-submit").disabled = open.length === 0;
    weeklyPlaceholder();
    if (!$("payment-date").value) $("payment-date").value = todayIso();
  }

  function paymentLabel(p) {
    if (p.forFriday) {
      return p.missed
        ? "Paid off overdue"
        : `Friday payment ${fmtFriday(p.forFriday)}`;
    }
    // Payments logged before the Friday plan existed.
    if (p.clearedDueDate) {
      return p.clearedDueDate < p.date
        ? "Paid off overdue"
        : "Paid on due date";
    }
    return "";
  }

  function renderPayments() {
    const list = $("payment-list");
    const names = Object.fromEntries(state.debts.map((d) => [d.id, d.name]));
    const payments = state.payments
      .slice()
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

    if (payments.length === 0) {
      list.innerHTML = `<tr><td colspan="4" class="py-4 text-center text-body-color">No payments logged yet.</td></tr>`;
      return;
    }

    list.innerHTML = payments
      .map(
        (p) => `
        <tr class="border-t border-gray-100">
          <td class="py-2 pr-3 text-body-color">${fmtDate(
            parseDate(p.date)
          )}</td>
          <td class="py-2 pr-3 text-dark">${esc(
            names[p.debtId] || "Deleted debt"
          )}${
          paymentLabel(p)
            ? ` <span class="ml-1 whitespace-nowrap rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-white">${paymentLabel(
                p
              )}</span>`
            : ""
        }${
          p.note
            ? `<span class="block text-xs text-body-color">${esc(
                p.note
              )}</span>`
            : ""
        }</td>
          <td class="py-2 pr-3 text-right font-medium text-dark">${fmt(
            p.amount
          )}</td>
          <td class="py-2 text-right"><button data-action="delete-payment" data-id="${
            p.id
          }" class="text-xs font-medium text-red-600 hover:underline">Undo</button></td>
        </tr>`
      )
      .join("");
  }

  function renderDueDates() {
    const list = $("due-list");
    const today = new Date();
    const items = [];
    const pill = (classes, text) =>
      `<span class="whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${classes}">${text}</span>`;

    state.debts.forEach((debt) => {
      const left = remainingOn(state, debt);
      if (left === 0) return;
      const plan = fridayPlan(debt, state.payments, today);
      const upcoming = plan.find(
        (f) => f.status === "thisWeek" || f.status === "later"
      );
      plan
        .filter((f) => f.status === "missed" || f === upcoming)
        .forEach((f) => {
          const days = daysBetween(today, parseDate(f.date));
          if (f.status === "later" && days > 14) return;
          let badge = pill("bg-gray-100 text-body-color", `in ${days} days`);
          if (f.status === "missed")
            badge = pill("bg-red-600 text-white", "Missed");
          else if (days === 0)
            badge = pill("bg-secondary text-white", "Payday today");
          else if (f.status === "thisWeek")
            badge = pill(
              "bg-warning text-dark",
              days < 0 ? "This week" : "This Friday"
            );
          items.push({
            days,
            html: `<span><span class="font-medium text-dark">${esc(
              debt.name
            )}</span> <span class="text-body-color">· pay ${fmt(
              Math.min(f.amount, left)
            )} · ${fmtFriday(f.date)}</span></span>${badge}`,
          });
        });

      if (debt.deadline) {
        const days = daysBetween(today, parseDate(debt.deadline));
        if (days > 30) return;
        const badge =
          days < 0
            ? pill("bg-red-600 text-white", "Deadline passed")
            : pill(
                days <= 14
                  ? "bg-warning text-dark"
                  : "bg-gray-100 text-body-color",
                days === 0 ? "Deadline today" : `in ${days} days`
              );
        items.push({
          days,
          html: `<span><span class="font-medium text-dark">${esc(
            debt.name
          )}</span> <span class="text-body-color">· ${fmt(
            left
          )} left · pay off by ${fmtDate(
            parseDate(debt.deadline)
          )}</span></span>${badge}`,
        });
      }
    });

    if (items.length === 0) {
      list.innerHTML = `<li class="text-body-color">Nothing coming up. Add a Friday payment plan or a pay-off deadline to a debt.</li>`;
      return;
    }

    list.innerHTML = items
      .sort((a, b) => a.days - b.days)
      .map(
        (item) => `
        <li class="flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 py-2 first:border-t-0">
          ${item.html}
        </li>`
      )
      .join("");
  }

  function renderPayForm() {
    const { pay } = state;
    if (document.activeElement !== $("pay-amount")) {
      $("pay-amount").value = pay.amount ? (pay.amount / 100).toFixed(2) : "";
    }
    $("pay-frequency").value = pay.frequency;
    $("pay-next").value = pay.nextPayDate;

    const next = nextPayday(pay.nextPayDate, pay.frequency, new Date());
    $("pay-next-info").textContent = next
      ? `Next payday: ${fmtDate(next)} (${
          daysBetween(new Date(), next) === 0
            ? "today"
            : "in " + daysBetween(new Date(), next) + " days"
        })`
      : "";
  }

  function renderEssentials() {
    const list = $("essential-list");
    if (state.essentials.length === 0) {
      list.innerHTML = `<li class="text-body-color">Nothing added yet, e.g. rent, bills, food, travel.</li>`;
    } else {
      list.innerHTML = state.essentials
        .map(
          (e) => `
          <li class="flex items-center justify-between border-t border-gray-100 py-2 first:border-t-0">
            <span class="text-dark">${esc(e.name)}</span>
            <span class="flex items-center gap-3">
              <span class="font-medium text-dark">${fmt(e.amount)}</span>
              <button data-action="delete-essential" data-id="${
                e.id
              }" class="text-xs font-medium text-red-600 hover:underline">Remove</button>
            </span>
          </li>`
        )
        .join("");
    }
    $("essential-total").textContent = fmt(
      sum(state.essentials, (e) => e.amount)
    );
  }

  function renderPlan() {
    const out = $("plan-output");
    $("plan-strategy").value = state.plan.strategy;
    $("plan-buffer").value = state.plan.bufferPercent;

    if (!state.pay.amount) {
      out.innerHTML = `<p class="text-body-color">Enter your take-home pay above to see a plan.</p>`;
      return;
    }

    const plan = buildPlan(state);
    const freq = state.pay.frequency;
    // Month 1 of the plan is the month of the next payday.
    const firstPay =
      nextPayday(state.pay.nextPayDate, freq, new Date()) || new Date();
    const planMonth = (n) => fmtMonth(addMonths(firstPay, n - 1));
    const showPerPay = freq !== "monthly";
    const names = Object.fromEntries(state.debts.map((d) => [d.id, d.name]));
    const balances = Object.fromEntries(
      state.debts.map((d) => [d.id, remainingOn(state, d)])
    );

    const row = (label, value, strong, colour) => `
      <div class="flex justify-between py-1 ${
        strong ? "border-t border-gray-200 pt-2 font-semibold" : ""
      }">
        <span class="${
          strong ? "text-dark" : "text-body-color"
        }">${label}</span>
        <span class="${colour || "text-dark"}">${value}</span>
      </div>`;

    let html = `
      <div class="mb-6 rounded-lg bg-gray-50 p-4 text-sm">
        ${row("Take-home pay (per month)", fmt(plan.monthlyIncome))}
        ${row("Essentials", "− " + fmt(plan.essentialsTotal))}
        ${row(
          "Left after essentials",
          fmt(plan.leftover),
          true,
          plan.leftover < 0 ? "text-red-600" : "text-dark"
        )}
        ${row(
          `Savings buffer (${state.plan.bufferPercent}%)`,
          "− " + fmt(plan.buffer)
        )}
        ${row(
          "Available for debts",
          fmt(plan.debtBudget),
          true,
          "text-primary"
        )}
      </div>`;

    if (plan.leftover < 0) {
      html += `<p class="mb-4 rounded-lg bg-red-50 p-4 text-sm text-red-700">Your essentials cost ${fmt(
        -plan.leftover
      )} more than you take home each month. Check the essentials list, or speak to a free debt adviser (see the tip below).</p>`;
    }

    if (plan.order.length === 0) {
      html += `<p class="text-body-color">${
        state.debts.length
          ? "All debts are paid off. Well done!"
          : "Add a debt to see how to split your money."
      }</p>`;
      out.innerHTML = html;
      return;
    }

    html += `
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="text-left text-body-color">
              <th class="pb-2 pr-3 font-medium">#</th>
              <th class="pb-2 pr-3 font-medium">Debt</th>
              <th class="pb-2 pr-3 text-right font-medium">Left</th>
              <th class="pb-2 pr-3 text-right font-medium">Pay / month</th>
              ${
                showPerPay
                  ? `<th class="pb-2 pr-3 text-right font-medium">Pay / payday</th>`
                  : ""
              }
              <th class="pb-2 text-right font-medium">Cleared by</th>
            </tr>
          </thead>
          <tbody>
            ${plan.order
              .map((id, i) => {
                const month = plan.forecast.payoffMonth[id];
                const amount = plan.allocation[id] || 0;
                return `
                <tr class="border-t border-gray-100">
                  <td class="py-2 pr-3 text-body-color">${i + 1}</td>
                  <td class="py-2 pr-3 font-medium text-dark">${esc(
                    names[id]
                  )}</td>
                  <td class="py-2 pr-3 text-right text-body-color">${fmt(
                    balances[id]
                  )}</td>
                  <td class="py-2 pr-3 text-right font-semibold text-primary">${fmt(
                    amount
                  )}</td>
                  ${
                    showPerPay
                      ? `<td class="py-2 pr-3 text-right text-dark">${fmt(
                          perPayday(amount, freq)
                        )}</td>`
                      : ""
                  }
                  <td class="py-2 text-right text-body-color">${
                    month ? planMonth(month) : "—"
                  }</td>
                </tr>`;
              })
              .join("")}
          </tbody>
        </table>
      </div>`;

    const f = plan.forecast;
    if (f.possible && f.months) {
      html += `
        <div class="mt-6 rounded-lg bg-primary bg-opacity-5 p-4">
          <p class="text-sm text-body-color">At this rate you'll be debt-free by</p>
          <p class="text-2xl font-bold text-primary">${planMonth(f.months)}</p>
          <p class="text-sm text-body-color">${f.months} month${
        f.months === 1 ? "" : "s"
      }</p>
        </div>`;
    } else if (!f.possible) {
      html += `<p class="mt-6 rounded-lg bg-red-50 p-4 text-sm text-red-700">At this budget the debts won't be cleared, because there's nothing left for them after essentials and savings. Try a smaller savings buffer or fewer essentials, or get free advice.</p>`;
    }

    if (plan.unused > 0) {
      html += `<p class="mt-4 text-sm text-body-color">${fmt(
        plan.unused
      )} a month is spare after paying everything off. Add it to your savings.</p>`;
    }

    out.innerHTML = html;
  }

  // ===== Actions =====

  // The Friday plan being edited in the debt form, as { isoDate: pence }.
  let formSchedule = {};

  function monthOptions() {
    const now = new Date();
    const months = new Set();
    for (let i = 0; i < 12; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
      months.add(toIso(d).slice(0, 7));
    }
    Object.keys(formSchedule).forEach((date) => months.add(date.slice(0, 7)));
    return [...months].sort();
  }

  function renderScheduleForm(month) {
    const select = $("sched-month");
    select.innerHTML = monthOptions()
      .map(
        (m) =>
          `<option value="${m}">${parseDate(m + "-01").toLocaleDateString(
            "en-GB",
            { month: "long", year: "numeric" }
          )}</option>`
      )
      .join("");
    select.value = month || todayIso().slice(0, 7);
    renderFridays();
  }

  function renderFridays() {
    const month = $("sched-month").value;
    const fridays = fridaysInMonth(month);
    $("sched-fridays").innerHTML = fridays
      .map(
        (date) => `
        <label class="flex items-center justify-between gap-3">
          <span class="text-sm ${
            fridayIsPast(date) ? "text-body-color" : "text-dark"
          }">${fmtFriday(date)}${fridayIsPast(date) ? " (past)" : ""}</span>
          <input data-friday="${date}" type="number" min="0" step="0.01" inputmode="decimal"
            value="${
              formSchedule[date] ? (formSchedule[date] / 100).toFixed(2) : ""
            }"
            placeholder="0.00"
            class="w-32 rounded-lg border border-gray-200 px-3 py-1.5 text-right text-dark outline-none focus:border-primary" />
        </label>`
      )
      .join("");
    const total = fridays.reduce((t, d) => t + (formSchedule[d] || 0), 0);
    $("sched-total").textContent = `${fridays.length} Fridays · ${fmt(
      total
    )} planned this month`;
  }

  function fridayIsPast(date) {
    return addDays(date, 2) < todayIso();
  }

  $("sched-month").addEventListener("change", renderFridays);

  $("sched-fridays").addEventListener("input", (e) => {
    const date = e.target.dataset.friday;
    if (!date) return;
    const amount = toPence(e.target.value);
    if (amount > 0) formSchedule[date] = amount;
    else delete formSchedule[date];
    const fridays = fridaysInMonth($("sched-month").value);
    const total = fridays.reduce((t, d) => t + (formSchedule[d] || 0), 0);
    $("sched-total").textContent = `${fridays.length} Fridays · ${fmt(
      total
    )} planned this month`;
  });

  $("sched-fill").addEventListener("click", () => {
    const weekly = toPence($("debt-weekly").value);
    if (!(weekly > 0)) {
      flash("Enter a weekly payment above first.", true);
      return;
    }
    // Only this week's Friday onwards; earlier ones are already over.
    fridaysInMonth($("sched-month").value)
      .filter((date) => !fridayIsPast(date))
      .forEach((date) => {
        formSchedule[date] = weekly;
      });
    renderFridays();
  });

  $("sched-clear").addEventListener("click", () => {
    fridaysInMonth($("sched-month").value).forEach((date) => {
      delete formSchedule[date];
    });
    renderFridays();
  });

  function resetDebtForm() {
    $("debt-form").reset();
    $("debt-id").value = "";
    formSchedule = {};
    $("debt-advanced").open = false;
    renderScheduleForm();
    $("debt-submit").textContent = "Add debt";
    $("debt-cancel").classList.add("hidden");
  }

  $("debt-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const id = $("debt-id").value;
    const amount = toPence($("debt-amount").value);
    const name = $("debt-name").value.trim();
    if (!name || !(amount > 0)) {
      flash("Enter who you owe and an amount above £0.", true);
      return;
    }
    const weekly = toPence($("debt-weekly").value);
    const fields = {
      name,
      amount,
      weekly: weekly > 0 ? weekly : 0,
      deadline: $("debt-deadline").value,
      schedule: Object.assign({}, formSchedule),
      notes: $("debt-notes").value.trim(),
    };

    if (id) {
      const debt = state.debts.find((d) => d.id === id);
      if (amount < paidOn(state, id)) {
        flash(
          `You've already paid ${fmt(
            paidOn(state, id)
          )} on this. The amount can't be lower than that.`,
          true
        );
        return;
      }
      Object.assign(debt, fields);
      flash("Debt updated.");
    } else {
      state.debts.push(
        Object.assign({ id: newId(), createdAt: todayIso() }, fields)
      );
      flash(`Added ${name}.`);
    }
    saveState();
    resetDebtForm();
    render();
  });

  $("debt-cancel").addEventListener("click", resetDebtForm);

  $("payment-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const debt = state.debts.find((d) => d.id === $("payment-debt").value);
    const amount = toPence($("payment-amount").value);
    if (!debt) return;
    if (!(amount > 0)) {
      flash("Enter a payment amount above £0.", true);
      return;
    }
    const left = remainingOn(state, debt);
    if (amount > left) {
      flash(
        `Only ${fmt(left)} is left on ${debt.name}. Enter up to that.`,
        true
      );
      return;
    }
    const payment = {
      id: newId(),
      debtId: debt.id,
      amount,
      date: $("payment-date").value || todayIso(),
      note: $("payment-note").value.trim(),
    };
    // Count the payment towards a missed or this week's planned Friday, so it
    // drops off "Coming up". Undoing the payment brings it back.
    const friday = fridayForPayment(debt, state.payments, payment.date);
    if (friday) {
      payment.forFriday = friday.date;
      payment.missed = friday.missed;
    }
    state.payments.push(payment);
    saveState();
    $("payment-amount").value = "";
    $("payment-note").value = "";
    const nowLeft = remainingOn(state, debt);
    flash(
      nowLeft === 0
        ? `${debt.name} is paid off!`
        : `Paid ${fmt(amount)}${
            friday && friday.missed
              ? " and cleared the missed Friday payment"
              : friday
              ? ` for ${fmtFriday(friday.date)}`
              : ""
          }. ${fmt(nowLeft)} left on ${debt.name}.`
    );
    render();
  });

  $("payment-debt").addEventListener("change", weeklyPlaceholder);

  $("pay-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const amount = toPence($("pay-amount").value);
    state.pay = {
      amount: amount > 0 ? amount : 0,
      frequency: $("pay-frequency").value,
      nextPayDate: $("pay-next").value,
    };
    saveState();
    flash("Pay saved.");
    render();
  });

  $("essential-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("essential-name").value.trim();
    const amount = toPence($("essential-amount").value);
    if (!name || !(amount > 0)) {
      flash("Enter a name and a monthly amount above £0.", true);
      return;
    }
    state.essentials.push({ id: newId(), name, amount });
    saveState();
    $("essential-form").reset();
    $("essential-name").focus();
    render();
  });

  $("plan-strategy").addEventListener("change", (e) => {
    state.plan.strategy = e.target.value;
    saveState();
    render();
  });

  $("plan-buffer").addEventListener("change", (e) => {
    const value = Math.round(parseFloat(e.target.value));
    state.plan.bufferPercent = Number.isFinite(value)
      ? Math.min(Math.max(value, 0), 100)
      : 0;
    saveState();
    render();
  });

  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const id = btn.dataset.id;

    switch (btn.dataset.action) {
      case "pay": {
        const d = state.debts.find((x) => x.id === id);
        $("payment-debt").value = id;
        weeklyPlaceholder();
        if (suggestedAmount(d)) {
          $("payment-amount").value = (suggestedAmount(d) / 100).toFixed(2);
        }
        $("payments").scrollIntoView({ behavior: "smooth" });
        $("payment-amount").focus({ preventScroll: true });
        break;
      }
      case "edit-debt": {
        const d = state.debts.find((x) => x.id === id);
        $("debt-id").value = d.id;
        $("debt-name").value = d.name;
        $("debt-amount").value = (d.amount / 100).toFixed(2);
        $("debt-weekly").value = d.weekly ? (d.weekly / 100).toFixed(2) : "";
        $("debt-deadline").value = d.deadline || "";
        formSchedule = Object.assign({}, d.schedule || {});
        const upcoming = Object.keys(formSchedule)
          .sort()
          .find((date) => date >= todayIso());
        renderScheduleForm(upcoming && upcoming.slice(0, 7));
        $("debt-advanced").open = Object.keys(formSchedule).length > 0;
        $("debt-notes").value = d.notes || "";
        $("debt-submit").textContent = "Save changes";
        $("debt-cancel").classList.remove("hidden");
        $("debts").scrollIntoView({ behavior: "smooth" });
        break;
      }
      case "delete-debt": {
        const d = state.debts.find((x) => x.id === id);
        if (!confirm(`Delete ${d.name} and all its payments?`)) return;
        state.debts = state.debts.filter((x) => x.id !== id);
        state.payments = state.payments.filter((p) => p.debtId !== id);
        if ($("debt-id").value === id) resetDebtForm();
        saveState();
        render();
        break;
      }
      case "delete-payment": {
        if (!confirm("Undo this payment?")) return;
        state.payments = state.payments.filter((p) => p.id !== id);
        saveState();
        render();
        break;
      }
      case "delete-essential": {
        state.essentials = state.essentials.filter((x) => x.id !== id);
        saveState();
        render();
        break;
      }
    }
  });

  // ===== Backup =====

  $("export-btn").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `debt-tracker-backup-${todayIso()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $("import-file").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!Array.isArray(data.debts) || !Array.isArray(data.payments)) {
          throw new Error("bad file");
        }
        if (!confirm("Replace everything in the tracker with this backup?"))
          return;
        state = Object.assign(emptyState(), data);
        saveState();
        render();
        flash("Backup restored.");
      } catch (err) {
        flash("That file isn't a debt tracker backup.", true);
      } finally {
        e.target.value = "";
      }
    };
    reader.readAsText(file);
  });

  $("reset-btn").addEventListener("click", () => {
    if (
      !confirm(
        "Delete ALL debts, payments and budget settings? This can't be undone."
      )
    )
      return;
    state = emptyState();
    saveState();
    resetDebtForm();
    render();
    flash("Tracker cleared.");
  });

  renderScheduleForm();
  render();
})(typeof window !== "undefined" ? window : globalThis);
