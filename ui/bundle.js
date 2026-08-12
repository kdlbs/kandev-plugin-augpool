const PLUGIN_ID = "kandev-augpool";
const STATS_PATH = "/webhooks/stats";
const ACTION_PATH = "/webhooks/action";
const SESSION_SERIES_COLORS = [
  "var(--chart-5)",
  "var(--chart-1)",
  "var(--chart-3)",
  "var(--chart-2)",
  "var(--chart-4)",
];
const MAX_SESSION_SERIES = SESSION_SERIES_COLORS.length;

let activeController = null;

function createDashboardController(host, options = {}) {
  const copy = options.copy || copyCredentialBlob;
  const listeners = new Set();
  let generation = 0;
  let destroyed = false;
  let state = Object.freeze({
    phase: "idle",
    data: null,
    error: null,
    refreshing: false,
    pendingAction: null,
    copyState: null,
    copiedEmail: null,
  });

  function publish(patch) {
    if (destroyed) return;
    state = Object.freeze({ ...state, ...patch });
    for (const listener of listeners) listener(state);
  }

  async function parseResponse(response) {
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`Augpool returned an invalid response (${response.status})`);
    }
    if (!response.ok) {
      throw new Error(payload?.error || `Augpool request failed (${response.status})`);
    }
    return payload;
  }

  async function fetchDashboard(path, refreshing) {
    const requestGeneration = ++generation;
    publish({
      phase: state.data ? "ready" : "loading",
      error: null,
      refreshing,
    });
    try {
      const payload = await parseResponse(await host.api.fetch(path));
      if (requestGeneration !== generation || destroyed) return;
      publish({ phase: "ready", data: payload, error: null, refreshing: false });
    } catch (error) {
      if (requestGeneration !== generation || destroyed) return;
      publish({
        phase: state.data ? "ready" : "error",
        error: error instanceof Error ? error.message : String(error),
        refreshing: false,
      });
    }
  }

  async function mutate(payload) {
    if (state.pendingAction) return false;
    const requestGeneration = ++generation;
    const pendingAction = `${payload.action}:${payload.email || "pool"}`;
    publish({
      pendingAction,
      error: null,
      refreshing: false,
      copyState: null,
      copiedEmail: null,
    });
    try {
      const response = await host.api.fetch(ACTION_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const next = await parseResponse(response);
      if (requestGeneration !== generation || destroyed) return false;
      publish({
        phase: "ready",
        data: next,
        error: null,
        refreshing: false,
        pendingAction: null,
      });
      return true;
    } catch (error) {
      if (requestGeneration !== generation || destroyed) return false;
      publish({
        phase: state.data ? "ready" : "error",
        error: error instanceof Error ? error.message : String(error),
        refreshing: false,
        pendingAction: null,
      });
      return false;
    }
  }

  async function exportAccount(email) {
    if (state.pendingAction) return;
    const requestGeneration = ++generation;
    publish({
      pendingAction: `export:${email}`,
      error: null,
      refreshing: false,
      copyState: "copying",
      copiedEmail: null,
    });
    let blob = "";
    try {
      const response = await host.api.fetch(ACTION_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "export", email }),
      });
      const payload = await parseResponse(response);
      blob = typeof payload?.blob === "string" ? payload.blob : "";
      if (!blob) throw new Error("Augpool export returned no credential");
      payload.blob = "";
      await copy(blob);
      blob = "";
      if (requestGeneration !== generation || destroyed) return;
      publish({ pendingAction: null, copyState: "copied", copiedEmail: email, error: null });
    } catch (error) {
      blob = "";
      if (requestGeneration !== generation || destroyed) return;
      publish({
        pendingAction: null,
        copyState: "failed",
        copiedEmail: null,
        error:
          error instanceof Error
            ? `${error.message}. Run augpool export EMAIL in a trusted terminal instead.`
            : "Could not copy export. Use a trusted terminal instead.",
      });
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    load: () => fetchDashboard(STATS_PATH, false),
    refresh: () => fetchDashboard(`${STATS_PATH}?refresh=1`, true),
    mutate,
    exportAccount,
    clearCopyState() {
      publish({ copyState: null, copiedEmail: null });
    },
    destroy() {
      destroyed = true;
      generation += 1;
      listeners.clear();
      state = Object.freeze({
        phase: "idle",
        data: null,
        error: null,
        refreshing: false,
        pendingAction: null,
        copyState: null,
        copiedEmail: null,
      });
    },
  };
}

function useDashboardState(React, controller) {
  const [state, setState] = React.useState(controller.getState());
  React.useEffect(() => controller.subscribe(setState), [controller]);
  return state;
}

function useControllerLoadOnMount(React, controller) {
  React.useEffect(() => {
    if (controller.getState().phase !== "loading") controller.load();
  }, [controller]);
}

async function copyCredentialBlob(blob, environment = globalThis) {
  if (environment.navigator?.clipboard?.writeText) {
    try {
      await environment.navigator.clipboard.writeText(blob);
      return;
    } catch {
      // Clipboard may be blocked on insecure remote HTTP; use the temporary fallback.
    }
  }
  const document = environment.document;
  if (!document?.body || typeof document.execCommand !== "function") {
    throw new Error("Clipboard access is unavailable");
  }
  const textarea = document.createElement("textarea");
  textarea.value = blob;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.inset = "-9999px auto auto -9999px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  try {
    textarea.select();
    if (!document.execCommand("copy")) throw new Error("Clipboard copy was rejected");
  } finally {
    textarea.value = "";
    document.body.removeChild(textarea);
  }
}

function deriveSummary(snapshot, usage) {
  const accounts = snapshot?.accounts || [];
  const enabledAccounts = accounts.filter((account) => account.enabled);
  return {
    totalCredits: Number.isFinite(usage?.totals?.credits_consumed)
      ? usage.totals.credits_consumed
      : null,
    enabled: enabledAccounts.length,
    total: accounts.length,
    available: enabledAccounts.filter((account) => !account.in_cooldown).length,
    routingMode: snapshot?.mode === "locked" ? "Locked" : "Auto",
  };
}

function deriveSessionChart(history, accounts = []) {
  const labels = new Map(
    accounts.map((account) => [account.email, account.label || account.email]),
  );
  const rawDays = Array.isArray(history?.by_day) ? history.by_day : [];
  const peak = Math.max(0, ...rawDays.map((day) => Number(day.sessions) || 0));
  const totals = new Map();
  let unattributedTotal = 0;
  for (const day of rawDays) {
    const sessions = Math.max(0, Number(day.sessions) || 0);
    let attributed = 0;
    for (const [email, rawCount] of Object.entries(day.accounts || {})) {
      const count = Math.max(0, Number(rawCount) || 0);
      if (count === 0) continue;
      totals.set(email, (totals.get(email) || 0) + count);
      attributed += count;
    }
    unattributedTotal += Math.max(0, sessions - attributed);
  }
  const ranked = [...totals.entries()]
    .map(([email, total]) => ({ email, label: labels.get(email) || email, total }))
    .sort((left, right) =>
      right.total - left.total ||
      left.label.localeCompare(right.label) ||
      left.email.localeCompare(right.email),
    );
  const needsOther = ranked.length > MAX_SESSION_SERIES || unattributedTotal > 0;
  const namedCount = needsOther ? MAX_SESSION_SERIES - 1 : ranked.length;
  const named = ranked.slice(0, namedCount);
  const overflow = ranked.slice(namedCount);
  const series = named.map((account, index) => ({
    id: account.email,
    email: account.email,
    label: account.label,
    total: account.total,
    color: SESSION_SERIES_COLORS[index],
  }));
  if (needsOther) {
    series.push({
      id: "__other__",
      email: null,
      label: "Other",
      total: overflow.reduce((total, account) => total + account.total, unattributedTotal),
      color: SESSION_SERIES_COLORS[series.length],
    });
  }
  const namedEmails = new Set(named.map((account) => account.email));
  const days = rawDays.map((day) => {
    const sessions = Math.max(0, Number(day.sessions) || 0);
    const entries = Object.entries(day.accounts || {})
      .filter(([, count]) => Number(count) > 0)
      .map(([email, count]) => [email, Number(count)]);
    const attributed = entries.reduce((total, [, count]) => total + count, 0);
    const otherSessions = entries.reduce(
      (total, [email, count]) => total + (namedEmails.has(email) ? 0 : count),
      Math.max(0, sessions - attributed),
    );
    const counts = new Map(entries);
    if (needsOther) counts.set("__other__", otherSessions);
    const segments = series
      .map((account) => ({
        id: account.id,
        label: account.label,
        sessions: counts.get(account.id) || 0,
        color: account.color,
      }))
      .filter((segment) => segment.sessions > 0);
    const breakdown = entries
      .sort((left, right) => right[1] - left[1])
      .map(([email, count]) => `${labels.get(email) || email} ${count}`)
      .join(", ");
    const noun = sessions === 1 ? "session" : "sessions";
    return {
      date: day.date,
      sessions,
      segments,
      heightPercent: sessions > 0 && peak > 0 ? Math.max(8, (sessions / peak) * 100) : 0,
      label: `${day.date}: ${sessions} ${noun}${breakdown ? `. ${breakdown}` : ""}`,
    };
  });
  return {
    days,
    peak,
    series,
    trackedSessions: Number(history?.tracked_sessions) || 0,
    timezone: history?.timezone || "UTC",
    startDate: history?.start_date || null,
    endDate: history?.end_date || null,
  };
}

function deriveCreditBalance(snapshot, usage) {
  const totalCredits = Number.isFinite(usage?.totals?.credits_consumed)
    ? usage.totals.credits_consumed
    : null;
  const enabledAccounts = (usage?.accounts || []).filter((account) => account.enabled);
  const accounts = enabledAccounts.filter(
    (account) =>
      Number.isFinite(account.credits_consumed) &&
      account.credits_consumed >= 0,
  );
  const totalWeight = enabledAccounts.reduce(
    (total, account) => total + (Number.isFinite(account.weight) && account.weight > 0 ? account.weight : 0),
    0,
  );
  const showTargets = snapshot?.mode === "auto" && totalWeight > 0;
  return {
    totalCredits,
    rows: accounts.map((account) => ({
      email: account.email,
      label: account.label || account.email,
      credits: account.credits_consumed,
      share: Number.isFinite(account.credit_share)
        ? Math.min(1, Math.max(0, account.credit_share))
        : totalCredits > 0
          ? account.credits_consumed / totalCredits
          : 0,
      targetShare: showTargets ? account.weight / totalWeight : null,
    })),
  };
}

function removeConfirmationMatches(value, email) {
  return value === email;
}

function formatNumber(value, maximumFractionDigits = 1) {
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(undefined, { maximumFractionDigits }).format(value);
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(undefined, {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatTimestamp(value) {
  if (!Number.isFinite(value)) return "Never";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value * 1000));
}

function formatCacheAge(usage) {
  if (!Number.isFinite(usage?.age_seconds)) return "No cache";
  if (usage.age_seconds < 60) return `${usage.age_seconds}s old`;
  if (usage.age_seconds < 3600) return `${Math.floor(usage.age_seconds / 60)}m old`;
  return `${Math.floor(usage.age_seconds / 3600)}h old`;
}

function statusBadges(h, ui, account) {
  const { Badge } = ui;
  const badges = [];
  if (account.locked) badges.push(h(Badge, { key: "locked" }, "Locked"));
  if (!account.enabled) badges.push(h(Badge, { key: "disabled", variant: "secondary" }, "Disabled"));
  if (account.in_cooldown) badges.push(h(Badge, { key: "cooldown", variant: "destructive" }, "Cooldown"));
  if (account.source) badges.push(h(Badge, { key: "source", variant: "outline" }, account.source));
  return h("div", { className: "kandev-augpool__badges" }, ...badges);
}

function SummaryCards({ host, snapshot, usage }) {
  const h = host.jsx;
  const { Card, CardContent } = host.ui;
  const summary = deriveSummary(snapshot, usage);
  const cards = [
    ["Month-to-date credits", formatNumber(summary.totalCredits, 0)],
    ["Enabled accounts", `${summary.enabled} / ${summary.total}`],
    ["Available now", String(summary.available)],
    ["Routing mode", summary.routingMode],
    ["Usage cache", formatCacheAge(snapshot.usage)],
  ];
  return h(
    "section",
    { className: "kandev-augpool__summary", "aria-label": "Augpool summary" },
    ...cards.map(([label, value]) =>
      h(
        Card,
        { key: label, className: "kandev-augpool__summary-card" },
        h(
          CardContent,
          { className: "kandev-augpool__summary-content" },
          h("span", { className: "kandev-augpool__eyebrow" }, label),
          h("strong", { className: "kandev-augpool__metric", title: value }, value),
        ),
      ),
    ),
  );
}

function UsageOverview({ host, snapshot, usage }) {
  const h = host.jsx;
  const { Card, CardContent } = host.ui;
  const sessions = deriveSessionChart(usage?.session_history, snapshot?.accounts);
  const credits = deriveCreditBalance(snapshot, usage);
  const historyLabel = `${sessions.days.length || 30} days · ${formatNumber(sessions.trackedSessions, 0)} tracked`;
  const dateLabel = sessions.startDate && sessions.endDate
    ? `${sessions.startDate} to ${sessions.endDate}`
    : "Latest 30 days";
  const sessionLegend = sessions.trackedSessions > 0 && sessions.series.length
    ? h(
        "ul",
        {
          className: "kandev-augpool__session-legend",
          "aria-label": "Session totals by account",
        },
        ...sessions.series.map((series) => {
          const noun = series.total === 1 ? "session" : "sessions";
          return h(
            "li",
            {
              key: series.id,
              "aria-label": `${series.label}: ${formatNumber(series.total, 0)} ${noun}`,
              title: series.email || "Additional accounts",
            },
            h("span", {
              className: "kandev-augpool__session-swatch",
              style: { "--session-color": series.color },
              "aria-hidden": "true",
            }),
            h("span", { className: "kandev-augpool__session-series-label" }, series.label),
            h("strong", null, formatNumber(series.total, 0)),
          );
        }),
      )
    : null;
  const sessionBody = sessions.trackedSessions > 0 && sessions.days.length
    ? h(
        "ol",
        {
          className: "kandev-augpool__session-bars",
          "aria-label": "Daily local sessions, last 30 days UTC",
        },
        ...sessions.days.map((day, index) =>
          h(
            "li",
            { key: day.date, "aria-label": day.label, title: day.label },
            h(
              "span",
              { className: "kandev-augpool__session-track", "aria-hidden": "true" },
              h("span", {
                className: "kandev-augpool__session-bar",
                style: { height: `${day.heightPercent}%` },
              },
              ...day.segments.map((segment) =>
                h("span", {
                  key: segment.id,
                  className: "kandev-augpool__session-segment",
                  style: {
                    "--session-color": segment.color,
                    flexGrow: segment.sessions,
                  },
                }),
              )),
            ),
            h(
              "span",
              {
                className: `kandev-augpool__day-label${index === sessions.days.length - 1 ? " kandev-augpool__day-label--end" : ""}`,
                "aria-hidden": "true",
              },
              index === 0 || index === sessions.days.length - 1 ? day.date.slice(5) : "",
            ),
          ),
        ),
      )
    : h("p", { className: "kandev-augpool__graph-empty" }, "No dated sessions yet. Tracking starts after Augpool upgrade.");
  const creditBody = credits.rows.length
    ? h(
        "ul",
        { className: "kandev-augpool__credit-bars", "aria-label": "Current-month credits by account" },
        ...credits.rows.map((row) =>
          h(
            "li",
            { key: row.email },
            h(
              "div",
              { className: "kandev-augpool__credit-label" },
              h("span", { title: row.email }, row.label),
              h("strong", null, `${formatNumber(row.credits, 0)} · ${formatPercent(row.share)}`),
            ),
            h(
              "div",
              { className: "kandev-augpool__credit-track", "aria-hidden": "true" },
              h("span", {
                className: "kandev-augpool__credit-fill",
                style: { width: `${row.share * 100}%` },
              }),
              Number.isFinite(row.targetShare)
                ? h("span", {
                    className: "kandev-augpool__credit-target",
                    style: { left: `${row.targetShare * 100}%` },
                  })
                : null,
            ),
          ),
        ),
      )
    : h("p", { className: "kandev-augpool__graph-empty" }, "Credit data is unavailable.");

  return h(
    "section",
    { className: "kandev-augpool__graphs", "aria-label": "Augpool usage graphs" },
    h(
      Card,
      { className: "kandev-augpool__graph-card kandev-augpool__graph-card--sessions" },
      h(
        CardContent,
        { className: "kandev-augpool__graph-content" },
        h("div", { className: "kandev-augpool__graph-heading" },
          h("div", null, h("h3", null, "Sessions over time"), h("p", null, "Local account selections")),
          h("span", null, historyLabel),
        ),
        sessionLegend,
        sessionBody,
        h("p", { className: "kandev-augpool__graph-footnote" }, `${dateLabel} · ${sessions.timezone}`),
      ),
    ),
    h(
      Card,
      { className: "kandev-augpool__graph-card" },
      h(
        CardContent,
        { className: "kandev-augpool__graph-content" },
        h("div", { className: "kandev-augpool__graph-heading" },
          h("div", null, h("h3", null, "Credit balance"), h("p", null, "Current UTC month")),
          h("span", null, formatNumber(credits.totalCredits, 0)),
        ),
        creditBody,
        snapshot?.mode === "auto" && credits.rows.length
          ? h("p", { className: "kandev-augpool__graph-footnote" }, "Markers show configured weight share.")
          : h("p", { className: "kandev-augpool__graph-footnote" }, "Lower weighted usage ranks first."),
      ),
    ),
  );
}

function AccountActions({ host, controller, state, account, onEdit, onRemove }) {
  const h = host.jsx;
  const { Button } = host.ui;
  const disabled = Boolean(state.pendingAction) || !state.data?.management_enabled;
  return h(
    "div",
    { className: "kandev-augpool__actions", "aria-label": `Actions for ${account.email}` },
    h(
      Button,
      {
        type: "button",
        variant: account.locked ? "secondary" : "outline",
        size: "sm",
        disabled: disabled || account.locked || !account.enabled || account.in_cooldown,
        title: "Lock future Augment launches to this account; running processes do not switch",
        onClick: () => controller.mutate({ action: "lock", email: account.email }),
      },
      account.locked ? "Locked" : "Lock",
    ),
    h(
      Button,
      { type: "button", variant: "ghost", size: "sm", disabled, onClick: () => onEdit(account) },
      "Edit",
    ),
    h(
      Button,
      {
        type: "button",
        variant: "ghost",
        size: "sm",
        disabled,
        onClick: () => controller.exportAccount(account.email),
      },
      state.pendingAction === `export:${account.email}`
        ? "Copying…"
        : state.copyState === "copied" && state.copiedEmail === account.email
          ? "Copied"
          : "Export",
    ),
    h(
      Button,
      {
        type: "button",
        variant: "ghost",
        size: "sm",
        className: "kandev-augpool__danger-link",
        disabled,
        onClick: () => onRemove(account),
      },
      "Remove",
    ),
  );
}

function AccountsTable({ host, controller, state, accounts, onEdit, onRemove }) {
  const h = host.jsx;
  const ui = host.ui;
  const { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Card, CardContent } = ui;
  const actionProps = (account) => ({ host, controller, state, account, onEdit, onRemove });
  const columns = [
    { label: "Account" },
    { label: "Credits", alignEnd: true },
    { label: "Weight", alignEnd: true },
    { label: "Score", alignEnd: true },
    { label: "Local uses", alignEnd: true },
    { label: "Last selected" },
    { label: "Actions", alignEnd: true },
  ];

  const desktop = h(
    "div",
    { className: "kandev-augpool__table-wrap" },
    h(
      Table,
      null,
      h(
        TableHeader,
        null,
        h(
          TableRow,
          null,
          ...columns.map(
            (column) => h(
              TableHead,
              {
                key: column.label,
                className: column.alignEnd ? "kandev-augpool__align-end" : undefined,
              },
              column.label,
            ),
          ),
        ),
      ),
      h(
        TableBody,
        null,
        ...accounts.map((account) =>
          h(
            TableRow,
            { key: account.email },
            h(
              TableCell,
              null,
              h("div", { className: "kandev-augpool__identity" },
                h("strong", null, account.label || account.email),
                h("span", null, account.email),
                statusBadges(h, ui, account),
              ),
            ),
            h(TableCell, { className: "kandev-augpool__number" }, formatNumber(account.source === "analytics" ? account.credits_consumed : null, 0)),
            h(TableCell, { className: "kandev-augpool__number" }, formatNumber(account.weight, 2)),
            h(TableCell, { className: "kandev-augpool__number" }, formatNumber(account.score, 1)),
            h(TableCell, { className: "kandev-augpool__number" }, formatNumber(account.local_uses, 0)),
            h(TableCell, { className: "kandev-augpool__date" }, formatTimestamp(account.last_selected_at)),
            h(TableCell, null, h(AccountActions, actionProps(account))),
          ),
        ),
      ),
    ),
  );

  const mobile = h(
    "div",
    { className: "kandev-augpool__account-cards" },
    ...accounts.map((account) =>
      h(
        Card,
        { key: account.email },
        h(
          CardContent,
          { className: "kandev-augpool__account-card" },
          h("div", { className: "kandev-augpool__identity" },
            h("strong", null, account.label || account.email),
            h("span", null, account.email),
            statusBadges(h, ui, account),
          ),
          h("dl", { className: "kandev-augpool__facts" },
            h("div", null, h("dt", null, "Credits"), h("dd", null, formatNumber(account.source === "analytics" ? account.credits_consumed : null, 0))),
            h("div", null, h("dt", null, "Weight"), h("dd", null, formatNumber(account.weight, 2))),
            h("div", null, h("dt", null, "Score"), h("dd", null, formatNumber(account.score, 1))),
            h("div", null, h("dt", null, "Local uses"), h("dd", null, formatNumber(account.local_uses, 0))),
          ),
          h(AccountActions, actionProps(account)),
        ),
      ),
    ),
  );
  return h("section", { "aria-label": "Augpool accounts" }, desktop, mobile);
}

function ImportAccountDialog({ host, controller, open, onOpenChange }) {
  const h = host.jsx;
  const React = host.React;
  const {
    Button,
    Checkbox,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Label,
  } = host.ui;
  const [blob, setBlob] = React.useState("");
  const [force, setForce] = React.useState(false);

  async function submit(event) {
    event.preventDefault();
    const credential = blob;
    try {
      const ok = await controller.mutate({ action: "import", blob: credential, force });
      if (ok) onOpenChange(false);
    } finally {
      setBlob("");
    }
  }

  return h(
    Dialog,
    { open, onOpenChange: (next) => { if (!next) setBlob(""); onOpenChange(next); } },
    h(
      DialogContent,
      null,
      h(DialogHeader, null,
        h(DialogTitle, null, "Import Augpool account"),
        h(DialogDescription, null, "Paste an Augpool share blob. It is a full credential and is sent to the local CLI only."),
      ),
      h("form", { onSubmit: submit, className: "kandev-augpool__dialog-form" },
        h(Label, { htmlFor: "augpool-import-blob" }, "Share blob"),
        h(Input, {
          id: "augpool-import-blob",
          type: "password",
          autoComplete: "off",
          value: blob,
          onChange: (event) => setBlob(event.target.value.trim()),
          placeholder: "eyJ…",
          required: true,
        }),
        h("label", { className: "kandev-augpool__checkbox-row" },
          h(Checkbox, {
            checked: force,
            style: { minWidth: 0, minHeight: 0 },
            onCheckedChange: (value) => setForce(value === true),
          }),
          h("span", null, "Replace an existing account with the same email"),
        ),
        h(DialogFooter, null,
          h(Button, { className: "kandev-augpool__dialog-action", type: "button", variant: "outline", onClick: () => onOpenChange(false) }, "Cancel"),
          h(Button, { className: "kandev-augpool__dialog-action", type: "submit", disabled: !blob }, "Import account"),
        ),
      ),
    ),
  );
}

function EditAccountDialog({ host, controller, account, onClose }) {
  const h = host.jsx;
  const React = host.React;
  const {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Label,
    Switch,
  } = host.ui;
  const [enabled, setEnabled] = React.useState(account?.enabled ?? true);
  const [weight, setWeight] = React.useState(String(account?.weight ?? 1));

  React.useEffect(() => {
    if (account) {
      setEnabled(account.enabled);
      setWeight(String(account.weight));
    }
  }, [account]);

  async function submit(event) {
    event.preventDefault();
    if (!account) return;
    let ok = true;
    if (enabled !== account.enabled) {
      ok = await controller.mutate({ action: enabled ? "enable" : "disable", email: account.email });
    }
    const numericWeight = Number(weight);
    if (ok && numericWeight !== account.weight) {
      ok = await controller.mutate({ action: "weight", email: account.email, weight: numericWeight });
    }
    if (ok) onClose();
  }

  const numericWeight = Number(weight);
  const validWeight = Number.isFinite(numericWeight) && numericWeight > 0;
  return h(
    Dialog,
    { open: Boolean(account), onOpenChange: (next) => { if (!next) onClose(); } },
    h(
      DialogContent,
      null,
      h(DialogHeader, null,
        h(DialogTitle, null, "Edit account"),
        h(DialogDescription, null, account?.email || "Account settings"),
      ),
      h("form", { onSubmit: submit, className: "kandev-augpool__dialog-form" },
        h("div", { className: "kandev-augpool__switch-row" },
          h("div", null, h(Label, { htmlFor: "augpool-enabled" }, "Enabled"), h("p", null, "Disabled accounts are excluded from routing.")),
          h(Switch, {
            id: "augpool-enabled",
            checked: enabled,
            style: { minWidth: 0, minHeight: 0 },
            onCheckedChange: setEnabled,
          }),
        ),
        h(Label, { htmlFor: "augpool-weight" }, "Relative capacity"),
        h(Input, {
          id: "augpool-weight",
          "aria-describedby": "augpool-weight-hint",
          type: "number",
          min: "0.01",
          step: "0.01",
          value: weight,
          onChange: (event) => setWeight(event.target.value),
          required: true,
        }),
        h("p", { id: "augpool-weight-hint", className: "kandev-augpool__hint" }, "A value of 2 lets this account carry roughly twice the usage of an account set to 1."),
        account?.locked && !enabled
          ? h("p", { className: "kandev-augpool__warning" }, "Switch to auto mode before disabling the locked account.")
          : null,
        h(DialogFooter, null,
          h(Button, { className: "kandev-augpool__dialog-action", type: "button", variant: "outline", onClick: onClose }, "Cancel"),
          h(Button, { className: "kandev-augpool__dialog-action", type: "submit", disabled: !validWeight }, "Save changes"),
        ),
      ),
    ),
  );
}

function RemoveAccountDialog({ host, controller, account, onClose }) {
  const h = host.jsx;
  const React = host.React;
  const {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Label,
  } = host.ui;
  const [confirmation, setConfirmation] = React.useState("");
  React.useEffect(() => setConfirmation(""), [account]);

  async function submit(event) {
    event.preventDefault();
    if (!account || !removeConfirmationMatches(confirmation, account.email)) return;
    const ok = await controller.mutate({ action: "remove", email: account.email });
    setConfirmation("");
    if (ok) onClose();
  }

  return h(
    Dialog,
    { open: Boolean(account), onOpenChange: (next) => { if (!next) onClose(); } },
    h(
      DialogContent,
      null,
      h(DialogHeader, null,
        h(DialogTitle, null, "Remove account"),
        h(DialogDescription, null, "This removes the account and its Augpool credential file from this host."),
      ),
      h("form", { onSubmit: submit, className: "kandev-augpool__dialog-form" },
        h(Label, { htmlFor: "augpool-remove-confirm" }, `Type ${account?.email || "the full email"} to confirm`),
        h(Input, {
          id: "augpool-remove-confirm",
          value: confirmation,
          onChange: (event) => setConfirmation(event.target.value),
          autoComplete: "off",
        }),
        h(DialogFooter, null,
          h(Button, { className: "kandev-augpool__dialog-action", type: "button", variant: "outline", onClick: onClose }, "Cancel"),
          h(Button, {
            className: "kandev-augpool__dialog-action",
            type: "submit",
            variant: "destructive",
            disabled: !account || !removeConfirmationMatches(confirmation, account.email),
          }, "Remove account"),
        ),
      ),
    ),
  );
}

function LoadingDashboard({ host }) {
  const h = host.jsx;
  const { Card, CardContent, Skeleton } = host.ui;
  return h(
    "div",
    { className: "kandev-augpool__loading", "aria-label": "Loading Augpool stats" },
    ...Array.from({ length: 5 }, (_, index) =>
      h(Card, { key: index }, h(CardContent, { className: "kandev-augpool__summary-content" }, h(Skeleton, { className: "h-4 w-24" }), h(Skeleton, { className: "h-7 w-32" }))),
    ),
  );
}

function AugpoolPage({ host, controller }) {
  const h = host.jsx;
  const React = host.React;
  const { Alert, AlertDescription, AlertTitle, Button, Card, CardContent } = host.ui;
  const state = useDashboardState(React, controller);
  const [importOpen, setImportOpen] = React.useState(false);
  const [editAccount, setEditAccount] = React.useState(null);
  const [removeAccount, setRemoveAccount] = React.useState(null);
  useControllerLoadOnMount(React, controller);

  const data = state.data;
  const snapshot = data?.snapshot;
  if (!data && state.phase === "loading") {
    return h("main", { className: "kandev-augpool" }, h(LoadingDashboard, { host }));
  }
  if (!data && state.phase === "error") {
    return h(
      "main",
      { className: "kandev-augpool" },
      h(Alert, { variant: "destructive" },
        h(AlertTitle, null, "Augpool is unavailable"),
        h(AlertDescription, null, state.error, " Check the executable path, Kandev process PATH, and optional Augpool home in plugin settings."),
      ),
      h(Button, { type: "button", variant: "outline", onClick: () => controller.load() }, "Try again"),
    );
  }
  if (!snapshot) return null;

  return h(
    "main",
    { className: "kandev-augpool" },
    h("section", { className: "kandev-augpool__intro" },
      h("div", null,
        h("h2", null, "Account pool"),
        h("p", null, "Usage, routing weight, cooldowns, and the mode used for future Augment launches."),
      ),
      h("div", { className: "kandev-augpool__primary-actions" },
        h(Button, {
          type: "button",
          variant: "outline",
          disabled: state.refreshing || Boolean(state.pendingAction),
          onClick: () => controller.refresh(),
        }, state.refreshing ? "Refreshing…" : "Refresh usage"),
        snapshot.mode === "locked"
          ? h(Button, {
              type: "button",
              variant: "outline",
              disabled: !data.management_enabled || Boolean(state.pendingAction),
              onClick: () => controller.mutate({ action: "auto" }),
            }, "Use auto")
          : null,
        h(Button, {
          type: "button",
          disabled: !data.management_enabled || Boolean(state.pendingAction),
          onClick: () => setImportOpen(true),
        }, "Import account"),
      ),
    ),
    !data.management_enabled
      ? h(Alert, null,
          h(AlertTitle, null, "Account controls are off"),
          h(AlertDescription, null, "Enable management in plugin settings only on a trusted single-user Kandev host."),
        )
      : null,
    state.error
      ? h(Alert, { variant: "destructive" }, h(AlertTitle, null, "Last request failed"), h(AlertDescription, null, state.error))
      : null,
    snapshot.usage.errors?.length
      ? h(Alert, null,
          h(AlertTitle, null, snapshot.usage.stale ? "Showing stale usage" : "Analytics completed with warnings"),
          h(AlertDescription, null, snapshot.usage.errors.join(" · ")),
        )
      : null,
    h(SummaryCards, { host, snapshot, usage: data.usage }),
    h(UsageOverview, { host, snapshot, usage: data.usage }),
    snapshot.accounts.length
      ? h(AccountsTable, {
          host,
          controller,
          state,
          accounts: snapshot.accounts,
          onEdit: setEditAccount,
          onRemove: setRemoveAccount,
        })
      : h(Card, null,
          h(CardContent, { className: "kandev-augpool__empty" },
            h("h3", null, "No Augpool accounts yet"),
            h("p", null, "Import a share blob here, or run augpool import from a trusted terminal."),
            h(Button, { type: "button", disabled: !data.management_enabled, onClick: () => setImportOpen(true) }, "Import first account"),
          ),
        ),
    h("p", { className: "kandev-augpool__cache-note" },
      `${snapshot.usage.start_date || "Unknown"}–${snapshot.usage.end_date || "unknown"} · ${formatCacheAge(snapshot.usage)} · TTL ${snapshot.usage.ttl_seconds}s`,
    ),
    h(ImportAccountDialog, { host, controller, open: importOpen, onOpenChange: setImportOpen }),
    h(EditAccountDialog, { host, controller, account: editAccount, onClose: () => setEditAccount(null) }),
    h(RemoveAccountDialog, { host, controller, account: removeAccount, onClose: () => setRemoveAccount(null) }),
  );
}

function PluginSettingsHealth({ host, controller }) {
  const h = host.jsx;
  const React = host.React;
  const { Alert, AlertDescription, AlertTitle, Badge, Button } = host.ui;
  const state = useDashboardState(React, controller);
  useControllerLoadOnMount(React, controller);
  if (!state.data) {
    return h(Alert, { variant: state.error ? "destructive" : undefined },
      h(AlertTitle, null, state.error ? "Augpool CLI unavailable" : "Checking Augpool CLI…"),
      h(AlertDescription, null, state.error || "Resolving the executable and stats schema."),
    );
  }
  const cli = state.data.cli;
  return h(
    "div",
    { className: "kandev-augpool__settings-health" },
    h("div", null,
      h("strong", null, cli.version),
      h("p", null, cli.executable),
      h("p", null, cli.home || "Default AUGPOOL_HOME"),
    ),
    h(Badge, { variant: state.data.management_enabled ? "default" : "secondary" }, state.data.management_enabled ? "Management on" : "Read-only"),
    h(Button, { type: "button", variant: "outline", size: "sm", onClick: () => controller.load() }, "Check again"),
  );
}

function makeTopbarActions(host, controller) {
  return function AugpoolTopbarActions() {
    const h = host.jsx;
    const state = useDashboardState(host.React, controller);
    return h(
      host.ui.Button,
      {
        type: "button",
        variant: "outline",
        size: "sm",
        disabled: state.refreshing || Boolean(state.pendingAction),
        onClick: () => controller.refresh(),
      },
      state.refreshing ? "Refreshing…" : "Refresh",
    );
  };
}

window.registerKandevPlugin(PLUGIN_ID, {
  initialize(registry, host) {
    activeController = createDashboardController(host);
    const controller = activeController;
    registry.registerNavItem({
      id: "augpool",
      label: "Augpool",
      path: "/augpool",
      icon: "chart",
      section: "integrations",
    });
    registry.registerRoute(
      "/augpool",
      function AugpoolRoute() {
        return host.jsx(AugpoolPage, { host, controller });
      },
      {
        topbar: {
          subtitle: "Account usage and routing health",
          actions: makeTopbarActions(host, controller),
        },
      },
    );
    registry.registerComponent("plugin-settings", function AugpoolSettingsSlot() {
      return host.jsx(PluginSettingsHealth, { host, controller });
    });
  },
  destroy() {
    activeController?.destroy();
    activeController = null;
  },
});
