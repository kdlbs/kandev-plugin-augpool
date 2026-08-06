package main

// StatsSnapshot mirrors Augpool's schema_version=1 credential-free report.
type StatsSnapshot struct {
	SchemaVersion int             `json:"schema_version"`
	GeneratedAt   string          `json:"generated_at"`
	Home          string          `json:"home"`
	ActiveEmail   *string         `json:"active_email"`
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
	Active          bool     `json:"active"`
	CreditsConsumed *float64 `json:"credits_consumed"`
	Score           *float64 `json:"score"`
	LocalUses       *int     `json:"local_uses"`
	Source          *string  `json:"source"`
	LastSelectedAt  *float64 `json:"last_selected_at"`
	InCooldown      bool     `json:"in_cooldown"`
	CooldownUntil   *float64 `json:"cooldown_until"`
}

type CLIStatus struct {
	Executable string `json:"executable"`
	Version    string `json:"version"`
	Home       string `json:"home"`
}
