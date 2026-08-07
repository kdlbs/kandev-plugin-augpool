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
      createDashboardController,
      copyCredentialBlob,
      deriveSummary,
      removeConfirmationMatches,
    };`,
    context,
    { filename: "bundle.js" },
  );
  return { registration, hooks: context.__augpoolTest };
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

function dashboard(active = "alice@example.com") {
  return {
    cli: { executable: "/usr/bin/augpool", version: "augpool 0.2.0", home: "" },
    management_enabled: true,
    snapshot: {
      schema_version: 1,
      generated_at: "2026-08-06T18:00:00Z",
      home: "/home/test/.augpool",
      active_email: active,
      strategy: "least_used",
      usage: {
        fetched_at: 1_770_000_000,
        age_seconds: 10,
        ttl_seconds: 300,
        stale: false,
        start_date: "2026-07-08",
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
          active: active === "alice@example.com",
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
          enabled: false,
          weight: 2,
          active: active === "bob@example.com",
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
  assert.equal(controller.getState().data.snapshot.active_email, "bob@example.com");
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

  assert.equal(controller.getState().data.snapshot.active_email, "bob@example.com");
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
  assert.equal(controller.getState().data.snapshot.active_email, "bob@example.com");
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
  await controller.mutate({ action: "select", email: "bob@example.com" });
  assert.equal(controller.getState().refreshing, false);
  resolveRefresh(response(dashboard("alice@example.com")));
  await refreshing;
  assert.equal(controller.getState().data.snapshot.active_email, "bob@example.com");
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
  const summary = hooks.deriveSummary(dashboard().snapshot);
  assert.deepEqual(JSON.parse(JSON.stringify(summary)), {
    totalCredits: 40,
    enabled: 1,
    total: 2,
    available: 1,
    activeEmail: "alice@example.com",
  });
  assert.equal(hooks.removeConfirmationMatches("alice@example.com", "alice@example.com"), true);
  assert.equal(hooks.removeConfirmationMatches("Alice@example.com", "alice@example.com"), false);
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
