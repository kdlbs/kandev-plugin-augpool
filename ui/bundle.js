const PLUGIN_ID = "kandev-augpool";
const STATS_PATH = "/webhooks/stats";
const ACTION_PATH = "/webhooks/action";

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

function deriveSummary(snapshot) {
  const accounts = snapshot?.accounts || [];
  const enabledAccounts = accounts.filter((account) => account.enabled);
  return {
    totalCredits: enabledAccounts.reduce(
      (total, account) => total + (Number.isFinite(account.credits_consumed) ? account.credits_consumed : 0),
      0,
    ),
    enabled: enabledAccounts.length,
    total: accounts.length,
    available: enabledAccounts.filter((account) => !account.in_cooldown).length,
    activeEmail: snapshot?.active_email || null,
  };
}

function removeConfirmationMatches(value, email) {
  return value === email;
}

function formatNumber(value, maximumFractionDigits = 1) {
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(undefined, { maximumFractionDigits }).format(value);
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
  if (account.active) badges.push(h(Badge, { key: "active" }, "Active"));
  if (!account.enabled) badges.push(h(Badge, { key: "disabled", variant: "secondary" }, "Disabled"));
  if (account.in_cooldown) badges.push(h(Badge, { key: "cooldown", variant: "destructive" }, "Cooldown"));
  if (account.source) badges.push(h(Badge, { key: "source", variant: "outline" }, account.source));
  return h("div", { className: "kandev-augpool__badges" }, ...badges);
}

function SummaryCards({ host, snapshot }) {
  const h = host.jsx;
  const { Card, CardContent } = host.ui;
  const summary = deriveSummary(snapshot);
  const cards = [
    ["30-day credits", formatNumber(summary.totalCredits, 0)],
    ["Enabled accounts", `${summary.enabled} / ${summary.total}`],
    ["Available now", String(summary.available)],
    ["Active account", summary.activeEmail || "None"],
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
        variant: account.active ? "secondary" : "outline",
        size: "sm",
        disabled: disabled || account.active || !account.enabled || account.in_cooldown,
        title: "Select for future Augment launches; running processes do not switch",
        onClick: () => controller.mutate({ action: "select", email: account.email }),
      },
      account.active ? "Selected" : "Select",
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
          ...["Account", "Credits", "Weight", "Score", "Local uses", "Last selected", "Actions"].map(
            (label) => h(TableHead, { key: label }, label),
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
            h(TableCell, { className: "kandev-augpool__number" }, formatNumber(account.credits_consumed, 0)),
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
            h("div", null, h("dt", null, "Credits"), h("dd", null, formatNumber(account.credits_consumed, 0))),
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
          h(Checkbox, { checked: force, onCheckedChange: (value) => setForce(value === true) }),
          h("span", null, "Replace an existing account with the same email"),
        ),
        h(DialogFooter, null,
          h(Button, { type: "button", variant: "outline", onClick: () => onOpenChange(false) }, "Cancel"),
          h(Button, { type: "submit", disabled: !blob }, "Import account"),
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
          h(Switch, { id: "augpool-enabled", checked: enabled, onCheckedChange: setEnabled }),
        ),
        h(Label, { htmlFor: "augpool-weight" }, "Routing weight"),
        h(Input, {
          id: "augpool-weight",
          type: "number",
          min: "0.01",
          step: "0.01",
          value: weight,
          onChange: (event) => setWeight(event.target.value),
          required: true,
        }),
        h("p", { className: "kandev-augpool__hint" }, "Higher weight lowers the account's weighted usage score."),
        account?.active && !enabled
          ? h("p", { className: "kandev-augpool__warning" }, "Disabling this account also clears it as active.")
          : null,
        h(DialogFooter, null,
          h(Button, { type: "button", variant: "outline", onClick: onClose }, "Cancel"),
          h(Button, { type: "submit", disabled: !validWeight }, "Save changes"),
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
          h(Button, { type: "button", variant: "outline", onClick: onClose }, "Cancel"),
          h(Button, {
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
  React.useEffect(() => {
    if (controller.getState().phase === "idle") controller.load();
  }, [controller]);

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
        h("p", null, "Usage, routing weight, cooldowns, and the active credential for future Augment launches."),
      ),
      h("div", { className: "kandev-augpool__primary-actions" },
        h(Button, {
          type: "button",
          variant: "outline",
          disabled: state.refreshing || Boolean(state.pendingAction),
          onClick: () => controller.refresh(),
        }, state.refreshing ? "Refreshing…" : "Refresh usage"),
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
    h(SummaryCards, { host, snapshot }),
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
  React.useEffect(() => {
    if (controller.getState().phase === "idle") controller.load();
  }, [controller]);
  if (!state.data) {
    return h(Alert, { variant: state.error ? "destructive" : undefined },
      h(AlertTitle, null, state.error ? "Augpool CLI unavailable" : "Checking Augpool CLI…"),
      h(AlertDescription, null, state.error || "Resolving the executable and stats schema."),
    );
  }
  const cli = state.data.cli;
  return h(
    "div",
    { className: "kandev-augpool kandev-augpool__settings-health" },
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
      section: "main",
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
