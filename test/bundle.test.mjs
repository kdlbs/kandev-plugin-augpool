import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const bundlePath = new URL("../ui/bundle.js", import.meta.url);
const source = await readFile(bundlePath, "utf8");

function loadBundle() {
  let registration;
  const context = vm.createContext({
    AbortController,
    URLSearchParams,
    clearTimeout,
    console,
    setTimeout,
    window: {
      registerKandevPlugin(id, definition) {
        registration = { id, definition };
      },
    },
  });
  vm.runInContext(
    `${source}\n;globalThis.__augpoolTest = {
      AccountsTable,
      AugpoolPage,
      EditAccountDialog,
      ImportAccountDialog,
      PluginSettingsHealth,
      RemoveAccountDialog,
      createDashboardController,
      copyCredentialBlob,
      deriveCreditBalance,
      deriveSessionChart,
      deriveSummary,
      removeConfirmationMatches,
      SummaryCards,
      UsageOverview,
    };`,
    context,
    { filename: "bundle.js" },
  );
  return { registration, hooks: context.__augpoolTest };
}

function findElements(node, type, found = []) {
  if (!node || typeof node !== "object") return found;
  if (node.type === type) found.push(node);
  for (const child of node.children ?? []) findElements(child, type, found);
  return found;
}

function findElementsByClass(node, className, found = []) {
  if (!node || typeof node !== "object") return found;
  if ((node.props?.className || "").split(/\s+/).includes(className)) found.push(node);
  for (const child of node.children ?? []) findElementsByClass(child, className, found);
  return found;
}

function staticComponentHost() {
  return {
    React: {
      useEffect() {},
      useState(initial) {
        return [initial, () => {}];
      },
    },
    ui: {
      Alert: "alert",
      AlertDescription: "alert-description",
      AlertTitle: "alert-title",
      Badge: "badge",
      Button: "button",
      Card: "card",
      CardContent: "card-content",
      Checkbox: "checkbox",
      Dialog: "dialog",
      DialogContent: "dialog-content",
      DialogDescription: "dialog-description",
      DialogFooter: "dialog-footer",
      DialogHeader: "dialog-header",
      DialogTitle: "dialog-title",
      Input: "input",
      Label: "label",
      Switch: "switch",
    },
    jsx(type, props, ...children) {
      return { type, props: props ?? {}, children };
    },
  };
}

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
  };
}

function dashboard(locked = "alice@example.com") {
  return {
    cli: { executable: "/usr/bin/augpool", version: "augpool 0.3.0", home: "" },
    management_enabled: true,
    snapshot: {
      schema_version: 2,
      generated_at: "2026-08-06T18:00:00Z",
      home: "/home/test/.augpool",
      mode: locked ? "locked" : "auto",
      locked_email: locked,
      strategy: "least_used",
      usage: {
        fetched_at: 1_770_000_000,
        age_seconds: 10,
        ttl_seconds: 300,
        stale: false,
        start_date: "2026-08-01",
        end_date: "2026-08-06",
        refresh_attempted: false,
        refresh_succeeded: false,
        errors: [],
        fetches_ok: 1,
        tenants_queried: 1,
      },
      accounts: [
        {
          email: "alice@example.com",
          label: "Alice",
          enabled: true,
          weight: 1,
          locked: locked === "alice@example.com",
          credits_consumed: 40,
          score: 40,
          local_uses: 3,
          source: "analytics",
          last_selected_at: 1_770_000_000,
          in_cooldown: false,
          cooldown_until: null,
        },
        {
          email: "bob@example.com",
          label: "Bob",
          enabled: true,
          weight: 2,
          locked: locked === "bob@example.com",
          credits_consumed: 60,
          score: 30,
          local_uses: 4,
          source: "analytics",
          last_selected_at: 1_770_000_120,
          in_cooldown: false,
          cooldown_until: null,
        },
        {
          email: "charlie@example.com",
          label: "Charlie",
          enabled: false,
          weight: 1,
          locked: false,
          credits_consumed: null,
          score: null,
          local_uses: null,
          source: null,
          last_selected_at: null,
          in_cooldown: false,
          cooldown_until: null,
        },
      ],
    },
    usage: {
      window: {
        start_date: "2026-08-01",
        end_date: "2026-08-06",
        fetched_at: 1_770_000_000,
        age_seconds: 10,
      },
      totals: {
        accounts: 3,
        enabled_accounts: 2,
        credits_consumed: 100,
        local_sessions: 7,
      },
      session_history: {
        timezone: "UTC",
        start_date: "2026-07-08",
        end_date: "2026-08-06",
        tracked_sessions: 7,
        by_day: [
          { date: "2026-08-02", sessions: 0, accounts: {} },
          { date: "2026-08-03", sessions: 1, accounts: { "alice@example.com": 1 } },
          {
            date: "2026-08-04",
            sessions: 4,
            accounts: { "alice@example.com": 2, "bob@example.com": 2 },
          },
          { date: "2026-08-05", sessions: 2, accounts: { "bob@example.com": 2 } },
          { date: "2026-08-06", sessions: 0, accounts: {} },
        ],
      },
      accounts: [
        {
          email: "alice@example.com",
          label: "Alice",
          enabled: true,
          locked: locked === "alice@example.com",
          weight: 1,
          credits_consumed: 40,
          credit_share: 0.4,
        },
        {
          email: "bob@example.com",
          label: "Bob",
          enabled: true,
          locked: locked === "bob@example.com",
          weight: 2,
          credits_consumed: 60,
          credit_share: 0.6,
        },
      ],
      errors: [],
    },
  };
}

test("registers the Augpool nav, native route, and settings health slot", () => {
  const { registration } = loadBundle();
  assert.equal(registration.id, "kandev-augpool");

  const calls = [];
  const registry = {
    registerNavItem(value) {
      calls.push(["nav", value]);
    },
    registerRoute(path, component, options) {
      calls.push(["route", { path, component, options }]);
    },
    registerComponent(slot, component) {
      calls.push(["component", { slot, component }]);
    },
  };
  registration.definition.initialize(registry, {
    React: {},
    jsx() {},
    ui: {},
    api: { fetch: async () => response(dashboard()) },
  });

  assert.deepEqual(
    calls.map(([kind, value]) => [kind, kind === "nav" ? value.path : value.path ?? value.slot]),
    [
      ["nav", "/augpool"],
      ["route", "/augpool"],
      ["component", "plugin-settings"],
    ],
  );
  assert.equal(calls[0][1].icon, "chart");
  assert.equal(calls[0][1].section, "integrations");
  assert.equal(calls[1][1].options.topbar.subtitle, "Account usage and routing health");
});

test("desktop table headings align with numeric values and actions", () => {
  const { hooks } = loadBundle();
  const ui = {
    Badge: "badge",
    Card: "card",
    CardContent: "card-content",
    Table: "table",
    TableBody: "tbody",
    TableCell: "td",
    TableHead: "th",
    TableHeader: "thead",
    TableRow: "tr",
  };
  const host = {
    ui,
    jsx(type, props, ...children) {
      return { type, props: props ?? {}, children };
    },
  };

  const tree = hooks.AccountsTable({
    host,
    controller: {},
    state: {},
    accounts: dashboard().snapshot.accounts,
    onEdit() {},
    onRemove() {},
  });
  const headings = findElements(tree, "th");

  assert.deepEqual(headings.map((heading) => heading.children[0]), [
    "Account",
    "Credits",
    "Weight",
    "Score",
    "Local uses",
    "Last selected",
    "Actions",
  ]);
  for (const index of [1, 2, 3, 4, 6]) {
    assert.match(headings[index].props.className ?? "", /kandev-augpool__align-end/);
  }
  assert.equal(headings[0].props.className, undefined);
  assert.equal(headings[5].props.className, undefined);
});

test("account table does not label local fallback counts as credits", () => {
  const { hooks } = loadBundle();
  const data = dashboard();
  data.snapshot.accounts[0].credits_consumed = 9;
  data.snapshot.accounts[0].source = "local";
  const host = {
    ui: {
      Badge: "badge",
      Card: "card",
      CardContent: "card-content",
      Table: "table",
      TableBody: "tbody",
      TableCell: "td",
      TableHead: "th",
      TableHeader: "thead",
      TableRow: "tr",
    },
    jsx(type, props, ...children) {
      return { type, props: props ?? {}, children };
    },
  };
  const tree = hooks.AccountsTable({
    host,
    controller: {},
    state: {},
    accounts: data.snapshot.accounts,
    onEdit() {},
    onRemove() {},
  });

  const firstAccountRow = findElements(tree, "tr")[1];
  assert.equal(firstAccountRow.children[1].children[0], "—");
});

test("dashboard route revalidates ready controller state when mounted", () => {
  const effects = [];
  const ready = dashboard();
  let loads = 0;
  const controller = {
    getState: () => ({
      phase: "ready",
      data: ready,
      error: null,
      refreshing: false,
      pendingAction: null,
      copyState: null,
      copiedEmail: null,
    }),
    subscribe: () => () => {},
    load() {
      loads += 1;
    },
  };
  const host = {
    React: {
      useEffect(effect) {
        effects.push(effect);
      },
      useState(initial) {
        return [initial, () => {}];
      },
    },
    ui: {
      Alert: "alert",
      AlertDescription: "alert-description",
      AlertTitle: "alert-title",
      Button: "button",
      Card: "card",
      CardContent: "card-content",
    },
    jsx(type, props, ...children) {
      return { type, props: props ?? {}, children };
    },
  };
  const { hooks } = loadBundle();

  hooks.AugpoolPage({ host, controller });
  for (const effect of effects) effect();

  assert.equal(loads, 1);
});

test("dashboard route does not duplicate an active load when mounted", () => {
  const effects = [];
  let loads = 0;
  const controller = {
    getState: () => ({
      phase: "loading",
      data: null,
      error: null,
      refreshing: false,
      pendingAction: null,
      copyState: null,
      copiedEmail: null,
    }),
    subscribe: () => () => {},
    load() {
      loads += 1;
    },
  };
  const host = {
    React: {
      useEffect(effect) {
        effects.push(effect);
      },
      useState(initial) {
        return [initial, () => {}];
      },
    },
    ui: {
      Alert: "alert",
      AlertDescription: "alert-description",
      AlertTitle: "alert-title",
      Button: "button",
      Card: "card",
      CardContent: "card-content",
    },
    jsx(type, props, ...children) {
      return { type, props: props ?? {}, children };
    },
  };
  const { hooks } = loadBundle();

  hooks.AugpoolPage({ host, controller });
  for (const effect of effects) effect();

  assert.equal(loads, 0);
});

test("settings health revalidates ready controller state when mounted", () => {
  const effects = [];
  let loads = 0;
  const controller = {
    getState: () => ({ phase: "ready", data: dashboard(), error: null }),
    subscribe: () => () => {},
    load() {
      loads += 1;
    },
  };
  const host = {
    React: {
      useEffect(effect) {
        effects.push(effect);
      },
      useState(initial) {
        return [initial, () => {}];
      },
    },
    ui: {
      Alert: "alert",
      AlertDescription: "alert-description",
      AlertTitle: "alert-title",
      Badge: "badge",
      Button: "button",
    },
    jsx(type, props, ...children) {
      return { type, props: props ?? {}, children };
    },
  };
  const { hooks } = loadBundle();

  hooks.PluginSettingsHealth({ host, controller });
  for (const effect of effects) effect();

  assert.equal(loads, 1);
});

test("settings health does not inherit the dashboard page shell", () => {
  const controller = {
    getState: () => ({ phase: "ready", data: dashboard(), error: null }),
    subscribe: () => () => {},
    load() {},
  };
  const host = staticComponentHost();
  const { hooks } = loadBundle();

  const tree = hooks.PluginSettingsHealth({ host, controller });

  assert.equal(tree.props.className, "kandev-augpool__settings-health");
});

test("dialog footer buttons opt into action hit-area styling", () => {
  const host = staticComponentHost();
  const controller = { mutate: async () => true };
  const account = dashboard().snapshot.accounts[0];
  const { hooks } = loadBundle();
  const trees = [
    hooks.ImportAccountDialog({ host, controller, open: true, onOpenChange() {} }),
    hooks.EditAccountDialog({ host, controller, account, onClose() {} }),
    hooks.RemoveAccountDialog({ host, controller, account, onClose() {} }),
  ];

  const buttons = trees.flatMap((tree) => findElements(tree, "button"));

  assert.equal(buttons.length, 6);
  for (const button of buttons) {
    assert.match(button.props.className ?? "", /kandev-augpool__dialog-action/);
  }
});

test("native dialog controls override stale broad button sizing", () => {
  const host = staticComponentHost();
  const controller = { mutate: async () => true };
  const account = dashboard().snapshot.accounts[0];
  const { hooks } = loadBundle();
  const importTree = hooks.ImportAccountDialog({
    host,
    controller,
    open: true,
    onOpenChange() {},
  });
  const editTree = hooks.EditAccountDialog({ host, controller, account, onClose() {} });
  const controls = [
    findElements(importTree, "checkbox")[0],
    findElements(editTree, "switch")[0],
  ];

  for (const control of controls) {
    assert.equal(control.props.style?.minWidth, 0);
    assert.equal(control.props.style?.minHeight, 0);
  }
});

test("edit dialog explains relative account capacity in plain language", () => {
  const host = staticComponentHost();
  const { hooks } = loadBundle();
  const tree = hooks.EditAccountDialog({
    host,
    controller: { mutate: async () => true },
    account: dashboard().snapshot.accounts[0],
    onClose() {},
  });

  const capacityLabel = findElements(tree, "label").find(
    (label) => label.props.htmlFor === "augpool-weight",
  );
  const capacityInput = findElements(tree, "input").find(
    (input) => input.props.id === "augpool-weight",
  );
  const capacityHint = findElements(tree, "p").find(
    (paragraph) => paragraph.props.id === "augpool-weight-hint",
  );

  assert.equal(capacityLabel.children[0], "Relative capacity");
  assert.equal(capacityInput.props["aria-describedby"], "augpool-weight-hint");
  assert.equal(
    capacityHint.children[0],
    "A value of 2 lets this account carry roughly twice the usage of an account set to 1.",
  );
});

test("controller loads and force-refreshes while preserving current data", async () => {
  const requests = [];
  let resolveRefresh;
  const refreshResponse = new Promise((resolve) => {
    resolveRefresh = resolve;
  });
  const host = {
    api: {
      fetch(path, init) {
        requests.push({ path, init });
        if (path.includes("refresh=1")) return refreshResponse;
        return Promise.resolve(response(dashboard()));
      },
    },
  };
  const { hooks } = loadBundle();
  const controller = hooks.createDashboardController(host);

  await controller.load();
  assert.equal(controller.getState().phase, "ready");
  const original = controller.getState().data;

  const pending = controller.refresh();
  assert.equal(controller.getState().refreshing, true);
  assert.equal(controller.getState().data, original);
  resolveRefresh(response(dashboard("bob@example.com")));
  await pending;

  assert.equal(requests[0].path, "/webhooks/stats");
  assert.equal(requests[1].path, "/webhooks/stats?refresh=1");
  assert.equal(controller.getState().data.snapshot.locked_email, "bob@example.com");
  assert.equal(controller.getState().refreshing, false);
});

test("controller keeps usable snapshot when refresh fails", async () => {
  let calls = 0;
  const host = {
    api: {
      async fetch() {
        calls += 1;
        if (calls === 1) return response(dashboard());
        return response({ error: "analytics unavailable" }, 502);
      },
    },
  };
  const { hooks } = loadBundle();
  const controller = hooks.createDashboardController(host);
  await controller.load();
  const snapshot = controller.getState().data;

  await controller.refresh();
  assert.equal(controller.getState().data, snapshot);
  assert.equal(controller.getState().error, "analytics unavailable");
  assert.equal(controller.getState().phase, "ready");
});

test("newer request wins when an older load resolves late", async () => {
  const pending = [];
  const host = {
    api: {
      fetch() {
        return new Promise((resolve) => pending.push(resolve));
      },
    },
  };
  const { hooks } = loadBundle();
  const controller = hooks.createDashboardController(host);

  const first = controller.load();
  const second = controller.refresh();
  pending[1](response(dashboard("bob@example.com")));
  await second;
  pending[0](response(dashboard("alice@example.com")));
  await first;

  assert.equal(controller.getState().data.snapshot.locked_email, "bob@example.com");
});

test("mutation posts exact JSON and adopts returned dashboard", async () => {
  const requests = [];
  const host = {
    api: {
      async fetch(path, init) {
        requests.push({ path, init });
        return response(dashboard("bob@example.com"));
      },
    },
  };
  const { hooks } = loadBundle();
  const controller = hooks.createDashboardController(host);

  await controller.mutate({ action: "weight", email: "alice@example.com", weight: 2.5 });
  assert.equal(requests[0].path, "/webhooks/action");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    action: "weight",
    email: "alice@example.com",
    weight: 2.5,
  });
  assert.equal(controller.getState().data.snapshot.locked_email, "bob@example.com");
  assert.equal(controller.getState().pendingAction, null);
});

test("mutation supersedes an in-flight refresh without leaving refresh state stuck", async () => {
  let resolveRefresh;
  const refresh = new Promise((resolve) => {
    resolveRefresh = resolve;
  });
  const host = {
    api: {
      fetch(path) {
        if (path.includes("refresh=1")) return refresh;
        return Promise.resolve(response(dashboard("bob@example.com")));
      },
    },
  };
  const { hooks } = loadBundle();
  const controller = hooks.createDashboardController(host);

  const refreshing = controller.refresh();
  await controller.mutate({ action: "lock", email: "bob@example.com" });
  assert.equal(controller.getState().refreshing, false);
  resolveRefresh(response(dashboard("alice@example.com")));
  await refreshing;
  assert.equal(controller.getState().data.snapshot.locked_email, "bob@example.com");
});

test("export copies exactly once and never stores or returns the blob", async () => {
  const blob = "c3VwZXItc2VjcmV0LWNyZWRlbnRpYWw";
  const payload = { blob };
  const copied = [];
  const host = {
    api: { fetch: async () => response(payload) },
  };
  const { hooks } = loadBundle();
  const controller = hooks.createDashboardController(host, {
    copy: async (value) => copied.push(value),
  });

  const result = await controller.exportAccount("alice@example.com");
  assert.equal(result, undefined);
  assert.deepEqual(copied, [blob]);
  assert.equal(JSON.stringify(controller.getState()).includes(blob), false);
  assert.equal(controller.getState().copyState, "copied");
  assert.equal(controller.getState().copiedEmail, "alice@example.com");
  assert.equal(payload.blob, "");
});

test("summary and destructive confirmation derive exact values", () => {
  const { hooks } = loadBundle();
  const data = dashboard();
  const summary = hooks.deriveSummary(data.snapshot, data.usage);
  assert.deepEqual(JSON.parse(JSON.stringify(summary)), {
    totalCredits: 100,
    enabled: 2,
    total: 3,
    available: 2,
    routingMode: "Locked",
  });
  assert.equal(hooks.removeConfirmationMatches("alice@example.com", "alice@example.com"), true);
  assert.equal(hooks.removeConfirmationMatches("Alice@example.com", "alice@example.com"), false);
});

test("graph derivations use daily sessions and weighted current-month credit balance", () => {
  const { hooks } = loadBundle();
  const data = dashboard(null);

  const sessionChart = hooks.deriveSessionChart(
    data.usage.session_history,
    data.snapshot.accounts,
  );
  assert.equal(sessionChart.peak, 4);
  assert.equal(sessionChart.trackedSessions, 7);
  assert.equal(sessionChart.days[0].heightPercent, 0);
  assert.equal(sessionChart.days[2].heightPercent, 100);
  assert.match(sessionChart.days[2].label, /2026-08-04: 4 sessions/);
  assert.match(sessionChart.days[2].label, /Alice 2/);
  assert.match(sessionChart.days[2].label, /Bob 2/);

  const creditBalance = hooks.deriveCreditBalance(data.snapshot, data.usage);
  assert.equal(creditBalance.totalCredits, 100);
  assert.deepEqual(
    JSON.parse(JSON.stringify(creditBalance.rows)),
    [
      {
        email: "alice@example.com",
        label: "Alice",
        credits: 40,
        share: 0.4,
        targetShare: 1 / 3,
      },
      {
        email: "bob@example.com",
        label: "Bob",
        credits: 60,
        share: 0.6,
        targetShare: 2 / 3,
      },
    ],
  );
  const locked = dashboard();
  assert.equal(hooks.deriveCreditBalance(locked.snapshot, locked.usage).rows[0].targetShare, null);
});

test("session history keeps top accounts distinct and groups overflow into Other", () => {
  const { hooks } = loadBundle();
  const accounts = ["a", "b", "c", "d", "e", "f"].map((name) => ({
    email: `${name}@example.com`,
    label: name.toUpperCase(),
  }));
  const chart = hooks.deriveSessionChart(
    {
      timezone: "UTC",
      tracked_sessions: 21,
      by_day: [
        {
          date: "2026-08-06",
          sessions: 21,
          accounts: {
            "a@example.com": 6,
            "b@example.com": 5,
            "c@example.com": 4,
            "d@example.com": 3,
            "e@example.com": 2,
            "f@example.com": 1,
          },
        },
      ],
    },
    accounts,
  );

  assert.deepEqual(
    JSON.parse(JSON.stringify(chart.series.map((series) => series.label))),
    ["A", "B", "C", "D", "Other"],
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(chart.series.map((series) => series.total))),
    [6, 5, 4, 3, 3],
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(chart.series.map((series) => series.color))),
    [
      "var(--chart-5)",
      "var(--chart-1)",
      "var(--chart-3)",
      "var(--chart-2)",
      "var(--chart-4)",
    ],
  );
  assert.equal(new Set(chart.series.map((series) => series.color)).size, 5);
  assert.deepEqual(
    JSON.parse(JSON.stringify(chart.days[0].segments.map((segment) => segment.sessions))),
    [6, 5, 4, 3, 3],
  );
});

test("credit summaries never present local fallback counts as Analytics credits", () => {
  const { hooks } = loadBundle();
  const data = dashboard(null);
  data.snapshot.accounts[0].credits_consumed = 9;
  data.snapshot.accounts[0].source = "local";
  data.snapshot.accounts[1].credits_consumed = 4;
  data.snapshot.accounts[1].source = "local";
  data.usage.totals.credits_consumed = null;
  for (const account of data.usage.accounts) {
    account.credits_consumed = null;
    account.credit_share = null;
  }

  assert.equal(hooks.deriveSummary(data.snapshot, data.usage).totalCredits, null);
  assert.deepEqual(
    JSON.parse(JSON.stringify(hooks.deriveCreditBalance(data.snapshot, data.usage))),
    { totalCredits: null, rows: [] },
  );
});

test("credit targets keep partially missing accounts in the weight denominator", () => {
  const { hooks } = loadBundle();
  const data = dashboard(null);
  data.usage.accounts[1].credits_consumed = null;
  data.usage.accounts[1].credit_share = null;

  const balance = hooks.deriveCreditBalance(data.snapshot, data.usage);
  assert.equal(balance.rows.length, 1);
  assert.equal(balance.rows[0].targetShare, 1 / 3);
});

test("usage overview renders restrained accessible charts and auto-only weight targets", () => {
  const host = staticComponentHost();
  const { hooks } = loadBundle();
  const locked = dashboard();
  const tree = hooks.UsageOverview({
    host,
    snapshot: locked.snapshot,
    usage: locked.usage,
  });

  assert.deepEqual(
    findElements(tree, "h3").map((heading) => heading.children[0]),
    ["Sessions over time", "Credit balance"],
  );
  const dayList = findElements(tree, "ol")[0];
  assert.equal(dayList.props["aria-label"], "Daily local sessions, last 30 days UTC");
  const days = findElements(dayList, "li");
  assert.equal(days.length, 5);
  assert.match(days[2].props["aria-label"], /2026-08-04: 4 sessions/);
  assert.equal(findElementsByClass(dayList, "kandev-augpool__day-label--end").length, 1);
  const legend = findElementsByClass(tree, "kandev-augpool__session-legend")[0];
  assert.equal(legend.props["aria-label"], "Session totals by account");
  assert.equal(findElements(legend, "li").length, 2);
  assert.equal(findElementsByClass(tree, "kandev-augpool__session-segment").length, 4);
  assert.equal(
    findElementsByClass(tree, "kandev-augpool__credit-target").length,
    0,
  );

  const auto = dashboard(null);
  const autoTree = hooks.UsageOverview({ host, snapshot: auto.snapshot, usage: auto.usage });
  assert.equal(
    findElementsByClass(autoTree, "kandev-augpool__credit-target").length,
    2,
  );
});

test("session graph explains when dated tracking has not started", () => {
  const host = staticComponentHost();
  const { hooks } = loadBundle();
  const data = dashboard();
  data.usage.session_history.tracked_sessions = 0;
  for (const day of data.usage.session_history.by_day) {
    day.sessions = 0;
    day.accounts = {};
  }

  const tree = hooks.UsageOverview({ host, snapshot: data.snapshot, usage: data.usage });
  const empty = findElementsByClass(tree, "kandev-augpool__graph-empty")[0];
  assert.match(empty.children[0], /Tracking starts after Augpool upgrade/);
});

test("summary labels credits accurately and locked mode can return to auto", async () => {
  const host = staticComponentHost();
  const { hooks } = loadBundle();
  const data = dashboard();
  const summary = hooks.SummaryCards({ host, snapshot: data.snapshot, usage: data.usage });
  assert.deepEqual(
    findElementsByClass(summary, "kandev-augpool__eyebrow").map((node) => node.children[0]),
    ["Month-to-date credits", "Enabled accounts", "Available now", "Routing mode", "Usage cache"],
  );

  const mutations = [];
  const controller = {
    getState: () => ({
      phase: "ready",
      data,
      error: null,
      refreshing: false,
      pendingAction: null,
      copyState: null,
      copiedEmail: null,
    }),
    subscribe: () => () => {},
    load() {},
    refresh() {},
    async mutate(payload) {
      mutations.push(payload);
      return true;
    },
  };
  const page = hooks.AugpoolPage({ host, controller });
  const autoButton = findElements(page, "button").find(
    (button) => button.children[0] === "Use auto",
  );
  assert.ok(autoButton);
  await autoButton.props.onClick();
  assert.deepEqual(JSON.parse(JSON.stringify(mutations)), [{ action: "auto" }]);
});

test("clipboard helper uses API then secure temporary textarea fallback", async () => {
  const { hooks } = loadBundle();
  const copied = [];
  await hooks.copyCredentialBlob("token", {
    navigator: { clipboard: { writeText: async (value) => copied.push(value) } },
  });
  assert.deepEqual(copied, ["token"]);

  let appended;
  let removed;
  let selected = false;
  const textarea = {
    value: "",
    style: {},
    setAttribute() {},
    select() {
      selected = true;
    },
  };
  const fallback = {
    navigator: {},
    document: {
      body: {
        appendChild(node) {
          appended = node;
        },
        removeChild(node) {
          removed = node;
        },
      },
      createElement() {
        return textarea;
      },
      execCommand(command) {
        assert.equal(command, "copy");
        return true;
      },
    },
  };
  await hooks.copyCredentialBlob("fallback-token", fallback);
  assert.equal(selected, true);
  assert.equal(appended, textarea);
  assert.equal(removed, textarea);
  assert.equal(textarea.value, "");
});
