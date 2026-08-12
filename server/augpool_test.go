package main

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

type recordingRunner struct {
	commands []CLICommand
	output   CLIOutput
	err      error
}

func (r *recordingRunner) Run(_ context.Context, command CLICommand) (CLIOutput, error) {
	command.Args = slices.Clone(command.Args)
	command.Stdin = slices.Clone(command.Stdin)
	r.commands = append(r.commands, command)
	return r.output, r.err
}

func validStatsJSON() string {
	return `{
	  "schema_version": 2,
	  "generated_at": "2026-08-06T18:00:00Z",
	  "home": "/tmp/aug pool",
	  "mode": "locked",
	  "locked_email": "alice@example.com",
	  "strategy": "least_used",
	  "usage": {
    "fetched_at": 1770000000,
    "age_seconds": 12,
    "ttl_seconds": 300,
    "stale": false,
	    "start_date": "2026-08-01",
	    "end_date": "2026-08-06",
    "refresh_attempted": true,
    "refresh_succeeded": true,
    "errors": [],
    "fetches_ok": 1,
    "tenants_queried": 1
  },
  "accounts": [{
    "email": "alice@example.com",
    "label": "Alice",
    "enabled": true,
    "weight": 1.5,
	    "locked": true,
    "credits_consumed": 42,
    "score": 28,
    "local_uses": 3,
    "source": "analytics",
    "last_selected_at": 1770000000,
    "in_cooldown": false,
    "cooldown_until": null
  }]
	}`
}

func validUsageJSON() string {
	return `{
	  "window": {
	    "start_date": "2026-08-01",
	    "end_date": "2026-08-06",
	    "fetched_at": 1770000000,
	    "age_seconds": 12
	  },
	  "totals": {
	    "accounts": 2,
	    "enabled_accounts": 2,
	    "credits_consumed": 100,
	    "local_sessions": 7
	  },
	  "session_history": {
	    "timezone": "UTC",
	    "start_date": "2026-07-08",
	    "end_date": "2026-08-06",
	    "tracked_sessions": 7,
	    "by_day": [
	      {"date":"2026-08-04","sessions":0,"accounts":{}},
	      {"date":"2026-08-05","sessions":5,"accounts":{"alice@example.com":2,"bob@example.com":3}},
	      {"date":"2026-08-06","sessions":2,"accounts":{"alice@example.com":2}}
	    ]
	  },
	  "accounts": [{
	    "email": "alice@example.com",
	    "label": "Alice",
	    "notes": "must stay server-side",
	    "enabled": true,
	    "locked": true,
	    "weight": 1.5,
	    "score": 28,
	    "credits_consumed": 42,
	    "credit_share": 0.42,
	    "local_sessions": 3,
	    "tracked_sessions_30d": 4,
	    "last_selected_at": 1770000000,
	    "source": "analytics",
	    "in_cooldown": false,
	    "cooldown_until": null
	  }],
	  "errors": []
	}`
}

func TestAugpoolCLIStatsUsesResolvedExecutableHomeAndExactArgs(t *testing.T) {
	runner := &recordingRunner{output: CLIOutput{Stdout: []byte(validStatsJSON())}}
	client := NewAugpoolCLI(CLIOptions{
		Home:   "/tmp/aug pool",
		Runner: runner,
		LookPath: func(name string) (string, error) {
			require.Equal(t, "augpool", name)
			return "/usr/local/bin/augpool", nil
		},
	})

	snapshot, err := client.Stats(context.Background(), true)
	require.NoError(t, err)
	require.Equal(t, 2, snapshot.SchemaVersion)
	require.Equal(t, "locked", snapshot.Mode)
	require.Equal(t, "alice@example.com", *snapshot.LockedEmail)
	require.True(t, snapshot.Accounts[0].Locked)
	require.Equal(t, "alice@example.com", snapshot.Accounts[0].Email)
	require.Len(t, runner.commands, 1)
	require.Equal(t, "/usr/local/bin/augpool", runner.commands[0].Executable)
	require.Equal(t, []string{
		"--home", "/tmp/aug pool", "stats", "--json", "--refresh",
	}, runner.commands[0].Args)
	require.Empty(t, runner.commands[0].Stdin)
	require.Positive(t, runner.commands[0].StdoutLimit)
	require.Positive(t, runner.commands[0].StderrLimit)
}

func TestAugpoolCLIUsageParsesDailyHistoryWithoutPrivateNotes(t *testing.T) {
	runner := &recordingRunner{output: CLIOutput{Stdout: []byte(validUsageJSON())}}
	client := NewAugpoolCLI(CLIOptions{Executable: "augpool", Runner: runner})

	report, err := client.Usage(context.Background())
	require.NoError(t, err)
	require.Equal(t, "UTC", report.SessionHistory.Timezone)
	require.Equal(t, 7, report.SessionHistory.TrackedSessions)
	require.Equal(t, 5, report.SessionHistory.ByDay[1].Sessions)
	require.Equal(t, 3, report.SessionHistory.ByDay[1].Accounts["bob@example.com"])
	require.NotNil(t, report.Accounts[0].CreditShare)
	require.Equal(t, 0.42, *report.Accounts[0].CreditShare)
	require.Equal(t, []string{"usage", "--json"}, runner.commands[0].Args)
	require.NotContains(t, fmt.Sprintf("%+v", report), "must stay server-side")
}

func TestAugpoolCLIRejectsNegativeDailySessions(t *testing.T) {
	runner := &recordingRunner{output: CLIOutput{Stdout: []byte(`{
		"window":{},
		"totals":{"accounts":1,"enabled_accounts":1,"credits_consumed":null,"local_sessions":0},
		"session_history":{"timezone":"UTC","start_date":"2026-07-08","end_date":"2026-08-06","tracked_sessions":0,"by_day":[{"date":"2026-08-06","sessions":-1,"accounts":{}}]},
		"accounts":[],
		"errors":[]
	}`)}}
	client := NewAugpoolCLI(CLIOptions{Executable: "augpool", Runner: runner})

	_, err := client.Usage(context.Background())
	require.ErrorIs(t, err, ErrInvalidOutput)
}

func TestAugpoolCLIRejectsUnknownRoutingMode(t *testing.T) {
	tests := map[string]string{
		"unknown mode": strings.Replace(validStatsJSON(), `"mode": "locked"`, `"mode": "manual"`, 1),
		"locked without account": strings.Replace(
			validStatsJSON(),
			`"locked_email": "alice@example.com"`,
			`"locked_email": null`,
			1,
		),
		"auto with locked account": strings.Replace(
			validStatsJSON(),
			`"mode": "locked"`,
			`"mode": "auto"`,
			1,
		),
	}
	for name, invalid := range tests {
		t.Run(name, func(t *testing.T) {
			runner := &recordingRunner{output: CLIOutput{Stdout: []byte(invalid)}}
			client := NewAugpoolCLI(CLIOptions{Executable: "augpool", Runner: runner})

			_, err := client.Stats(context.Background(), false)
			require.ErrorIs(t, err, ErrInvalidOutput)
		})
	}
}

func TestAugpoolCLIFindsUserInstallWhenProcessPathMissesCLI(t *testing.T) {
	home := t.TempDir()
	name := "augpool"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	userExecutable := filepath.Join(home, ".local", "bin", name)
	lookups := []string{}
	runner := &recordingRunner{output: CLIOutput{Stdout: []byte("augpool 0.3.0\n")}}
	client := NewAugpoolCLI(CLIOptions{
		Runner: runner,
		LookPath: func(name string) (string, error) {
			lookups = append(lookups, name)
			if name == userExecutable {
				return name, nil
			}
			return "", exec.ErrNotFound
		},
	})
	t.Setenv("HOME", home)

	status, err := client.Status(context.Background())
	require.NoError(t, err)
	require.Equal(t, userExecutable, status.Executable)
	require.Contains(t, lookups, "augpool")
	require.Contains(t, lookups, userExecutable)
	require.Equal(t, userExecutable, runner.commands[0].Executable)
}

func TestAugpoolCLIRejectsVersionWithoutMachineAPI(t *testing.T) {
	runner := &recordingRunner{output: CLIOutput{Stdout: []byte("augpool 0.2.0\n")}}
	client := NewAugpoolCLI(CLIOptions{Executable: "augpool", Runner: runner})

	_, err := client.Status(context.Background())
	require.ErrorIs(t, err, ErrUnsupportedVersion)
	require.Contains(t, err.Error(), "0.3.0")
}

func TestAugpoolCLIRealLifecycleIntegration(t *testing.T) {
	executable := os.Getenv("AUGPOOL_INTEGRATION_EXECUTABLE")
	if executable == "" {
		t.Skip("set AUGPOOL_INTEGRATION_EXECUTABLE to run against a real Augpool CLI")
	}
	client := NewAugpoolCLI(CLIOptions{Executable: executable, Home: t.TempDir()})

	status, err := client.Status(context.Background())
	require.NoError(t, err)
	require.Equal(t, "augpool 0.3.0", status.Version)

	shareJSON := `{"v":2,"email":"disposable@example.com","label":"Disposable","session":{"accessToken":"disposable-test-token","tenantURL":"https://e5.api.augmentcode.com/","scopes":[]}}`
	shareBlob := base64.RawURLEncoding.EncodeToString([]byte(shareJSON))
	require.NoError(t, client.Import(context.Background(), shareBlob, false))
	enabled := false
	weight := 2.5
	require.NoError(t, client.Update(
		context.Background(), "disposable@example.com", &enabled, &weight,
	))

	snapshot, err := client.Stats(context.Background(), false)
	require.NoError(t, err)
	require.Equal(t, 2, snapshot.SchemaVersion)
	require.Len(t, snapshot.Accounts, 1)
	require.False(t, snapshot.Accounts[0].Enabled)
	require.InDelta(t, 2.5, snapshot.Accounts[0].Weight, 0)
	report, err := client.Usage(context.Background())
	require.NoError(t, err)
	require.Len(t, report.SessionHistory.ByDay, 30)

	exported, err := client.Export(context.Background(), "disposable@example.com")
	require.NoError(t, err)
	decoded, err := base64.RawURLEncoding.DecodeString(exported)
	require.NoError(t, err)
	require.Contains(t, string(decoded), "disposable-test-token")

	require.NoError(t, client.Remove(context.Background(), "disposable@example.com"))
	snapshot, err = client.Stats(context.Background(), false)
	require.NoError(t, err)
	require.Empty(t, snapshot.Accounts)
}

func TestAugpoolCLIImportKeepsCredentialOutOfArgv(t *testing.T) {
	const blob = "eyJmdWxsIjoiY3JlZGVudGlhbCJ9"
	runner := &recordingRunner{output: CLIOutput{Stdout: []byte(`{"ok":true}`)}}
	client := NewAugpoolCLI(CLIOptions{
		Executable: "/opt/Aug Pool/augpool",
		Home:       "/srv/aug pool",
		Runner:     runner,
	})

	err := client.Import(context.Background(), blob, true)
	require.NoError(t, err)
	require.Len(t, runner.commands, 1)
	command := runner.commands[0]
	require.Equal(t, "/opt/Aug Pool/augpool", command.Executable)
	require.Equal(t, []string{
		"--home", "/srv/aug pool", "import", "-", "--json", "--force",
	}, command.Args)
	require.Equal(t, blob+"\n", string(command.Stdin))
	require.NotContains(t, strings.Join(command.Args, " "), blob)
}

func TestAugpoolCLIMutationCommandsUseStableJSONContract(t *testing.T) {
	runner := &recordingRunner{output: CLIOutput{Stdout: []byte(`{"ok":true}`)}}
	client := NewAugpoolCLI(CLIOptions{Executable: "augpool", Runner: runner})
	enabled := false
	weight := 2.75

	require.NoError(t, client.SetMode(context.Background(), "alice@example.com"))
	require.NoError(t, client.SetMode(context.Background(), "auto"))
	require.NoError(t, client.Update(context.Background(), "alice@example.com", &enabled, &weight))
	require.NoError(t, client.Remove(context.Background(), "alice@example.com"))

	require.Equal(t, []string{"mode", "alice@example.com", "--json"}, runner.commands[0].Args)
	require.Equal(t, []string{"mode", "auto", "--json"}, runner.commands[1].Args)
	require.Equal(t, []string{
		"update", "alice@example.com", "--disable", "--weight", "2.75", "--json",
	}, runner.commands[2].Args)
	require.Equal(t, []string{"remove", "alice@example.com", "--json"}, runner.commands[3].Args)
}

func TestAugpoolCLIImportErrorNeverIncludesCredential(t *testing.T) {
	const blob = "eyJzZWNyZXQiOiJmdWxsLWNyZWRlbnRpYWwifQ"
	runner := &recordingRunner{
		output: CLIOutput{Stderr: []byte("bad input: " + blob)},
		err:    errors.New("exit status 1: " + blob),
	}
	client := NewAugpoolCLI(CLIOptions{Executable: "augpool", Runner: runner})

	err := client.Import(context.Background(), blob, false)
	require.Error(t, err)
	require.NotContains(t, err.Error(), blob)
}

func TestAugpoolCLIExportAcceptsOneBase64URLToken(t *testing.T) {
	runner := &recordingRunner{output: CLIOutput{Stdout: []byte("YWxpY2UtdG9rZW4_\n")}}
	client := NewAugpoolCLI(CLIOptions{Executable: "augpool", Runner: runner})

	blob, err := client.Export(context.Background(), "alice@example.com")
	require.NoError(t, err)
	require.Equal(t, "YWxpY2UtdG9rZW4_", blob)
	require.Equal(t, []string{"export", "alice@example.com"}, runner.commands[0].Args)
}

func TestAugpoolCLIRejectsMalformedStatsSchemaAndExport(t *testing.T) {
	t.Run("schema", func(t *testing.T) {
		runner := &recordingRunner{output: CLIOutput{Stdout: []byte(`{"schema_version":1}`)}}
		client := NewAugpoolCLI(CLIOptions{Executable: "augpool", Runner: runner})
		_, err := client.Stats(context.Background(), false)
		require.ErrorIs(t, err, ErrUnsupportedSchema)
	})

	t.Run("export", func(t *testing.T) {
		runner := &recordingRunner{output: CLIOutput{Stdout: []byte("not a token!\n")}}
		client := NewAugpoolCLI(CLIOptions{Executable: "augpool", Runner: runner})
		_, err := client.Export(context.Background(), "alice@example.com")
		require.Error(t, err)
	})
}

func TestAugpoolCLIUsesLongerRefreshTimeout(t *testing.T) {
	runner := &deadlineRunner{deadlines: make([]time.Duration, 0, 2)}
	client := NewAugpoolCLI(CLIOptions{
		Executable:     "augpool",
		Runner:         runner,
		CommandTimeout: 2 * time.Second,
		RefreshTimeout: 10 * time.Second,
	})

	_, _ = client.Stats(context.Background(), false)
	_, _ = client.Stats(context.Background(), true)
	require.Len(t, runner.deadlines, 2)
	require.Greater(t, runner.deadlines[1], runner.deadlines[0])
}

func TestAugpoolCLIUsageAllowsAutomaticRefreshTimeout(t *testing.T) {
	runner := &deadlineRunner{
		deadlines: make([]time.Duration, 0, 1),
		output:    []byte(validUsageJSON()),
	}
	client := NewAugpoolCLI(CLIOptions{
		Executable:     "augpool",
		Runner:         runner,
		CommandTimeout: 2 * time.Second,
		RefreshTimeout: 10 * time.Second,
	})

	_, _ = client.Usage(context.Background())
	require.Len(t, runner.deadlines, 1)
	require.Greater(t, runner.deadlines[0], 5*time.Second)
}

func TestAugpoolCLIPreservesOutputLimitError(t *testing.T) {
	runner := &recordingRunner{err: ErrOutputTooLarge}
	client := NewAugpoolCLI(CLIOptions{Executable: "augpool", Runner: runner})

	_, err := client.Stats(context.Background(), false)
	require.ErrorIs(t, err, ErrOutputTooLarge)
}

func TestAugpoolCLIClassifiesConfiguredExecutableNotFound(t *testing.T) {
	runner := &recordingRunner{err: &exec.Error{Name: "missing-augpool", Err: exec.ErrNotFound}}
	client := NewAugpoolCLI(CLIOptions{Executable: "missing-augpool", Runner: runner})

	_, err := client.Status(context.Background())
	require.ErrorIs(t, err, ErrCLIUnavailable)
}

func TestAugpoolCLISerializesMutations(t *testing.T) {
	runner := &concurrencyRunner{}
	client := NewAugpoolCLI(CLIOptions{Executable: "augpool", Runner: runner})

	start := make(chan struct{})
	done := make(chan error, 2)
	for _, email := range []string{"alice@example.com", "bob@example.com"} {
		go func(email string) {
			<-start
			done <- client.SetMode(context.Background(), email)
		}(email)
	}
	close(start)
	require.NoError(t, <-done)
	require.NoError(t, <-done)
	require.Equal(t, 1, runner.maxActive)
}

type deadlineRunner struct {
	deadlines []time.Duration
	output    []byte
}

type concurrencyRunner struct {
	mu        sync.Mutex
	active    int
	maxActive int
}

func (r *concurrencyRunner) Run(context.Context, CLICommand) (CLIOutput, error) {
	r.mu.Lock()
	r.active++
	if r.active > r.maxActive {
		r.maxActive = r.active
	}
	r.mu.Unlock()
	time.Sleep(10 * time.Millisecond)
	r.mu.Lock()
	r.active--
	r.mu.Unlock()
	return CLIOutput{Stdout: []byte(`{"ok":true}`)}, nil
}

func (r *deadlineRunner) Run(ctx context.Context, _ CLICommand) (CLIOutput, error) {
	deadline, ok := ctx.Deadline()
	if ok {
		r.deadlines = append(r.deadlines, time.Until(deadline))
	}
	output := r.output
	if output == nil {
		output = []byte(validStatsJSON())
	}
	return CLIOutput{Stdout: output}, nil
}
