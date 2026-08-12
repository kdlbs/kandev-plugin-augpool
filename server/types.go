package main

// StatsSnapshot mirrors Augpool's schema_version=2 credential-free report.
type StatsSnapshot struct {
	SchemaVersion int             `json:"schema_version"`
	GeneratedAt   string          `json:"generated_at"`
	Home          string          `json:"home"`
	Mode          string          `json:"mode"`
	LockedEmail   *string         `json:"locked_email"`
	Strategy      string          `json:"strategy"`
	Usage         UsageSnapshot   `json:"usage"`
	Accounts      []AccountRecord `json:"accounts"`
}

type UsageSnapshot struct {
	FetchedAt        *float64 `json:"fetched_at"`
	AgeSeconds       *int64   `json:"age_seconds"`
	TTLSeconds       int64    `json:"ttl_seconds"`
	Stale            bool     `json:"stale"`
	StartDate        *string  `json:"start_date"`
	EndDate          *string  `json:"end_date"`
	RefreshAttempted bool     `json:"refresh_attempted"`
	RefreshSucceeded bool     `json:"refresh_succeeded"`
	Errors           []string `json:"errors"`
	FetchesOK        int      `json:"fetches_ok"`
	TenantsQueried   int      `json:"tenants_queried"`
}

type AccountRecord struct {
	Email           string   `json:"email"`
	Label           string   `json:"label"`
	Enabled         bool     `json:"enabled"`
	Weight          float64  `json:"weight"`
	Locked          bool     `json:"locked"`
	CreditsConsumed *float64 `json:"credits_consumed"`
	Score           *float64 `json:"score"`
	LocalUses       *int     `json:"local_uses"`
	Source          *string  `json:"source"`
	LastSelectedAt  *float64 `json:"last_selected_at"`
	InCooldown      bool     `json:"in_cooldown"`
	CooldownUntil   *float64 `json:"cooldown_until"`
}

// UsageReport mirrors Augpool's credential-free usage --json report. Fields
// not needed by the dashboard, including account notes, are intentionally not
// represented so they cannot be relayed to the browser.
type UsageReport struct {
	Totals         UsageTotals          `json:"totals"`
	SessionHistory SessionHistory       `json:"session_history"`
	Accounts       []UsageAccountRecord `json:"accounts"`
}

type UsageTotals struct {
	CreditsConsumed *float64 `json:"credits_consumed"`
}

type SessionHistory struct {
	Timezone        string       `json:"timezone"`
	StartDate       string       `json:"start_date"`
	EndDate         string       `json:"end_date"`
	TrackedSessions int          `json:"tracked_sessions"`
	ByDay           []SessionDay `json:"by_day"`
}

type SessionDay struct {
	Date     string         `json:"date"`
	Sessions int            `json:"sessions"`
	Accounts map[string]int `json:"accounts"`
}

type UsageAccountRecord struct {
	Email           string   `json:"email"`
	Label           string   `json:"label"`
	Enabled         bool     `json:"enabled"`
	Weight          float64  `json:"weight"`
	CreditsConsumed *float64 `json:"credits_consumed"`
	CreditShare     *float64 `json:"credit_share"`
}

type CLIStatus struct {
	Executable string `json:"executable"`
	Version    string `json:"version"`
	Home       string `json:"home"`
}
