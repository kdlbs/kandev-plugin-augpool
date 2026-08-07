package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"testing"

	"github.com/kandev/kandev/pkg/pluginsdk"
	"github.com/stretchr/testify/require"
)

type fakeService struct {
	mu         sync.Mutex
	calls      []string
	status     CLIStatus
	snapshot   *StatsSnapshot
	exportBlob string
	err        error
	importBlob string
}

func newFakeService() *fakeService {
	return &fakeService{
		status: CLIStatus{Executable: "/usr/bin/augpool", Version: "augpool 0.2.0"},
		snapshot: &StatsSnapshot{
			SchemaVersion: 1,
			GeneratedAt:   "2026-08-06T18:00:00Z",
			Strategy:      "least_used",
			Accounts:      []AccountRecord{},
		},
		exportBlob: "ZXhwb3J0ZWQtY3JlZGVudGlhbA",
	}
}

func (s *fakeService) record(call string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls = append(s.calls, call)
	return s.err
}

func (s *fakeService) Status(context.Context) (CLIStatus, error) {
	if err := s.record("status"); err != nil {
		return CLIStatus{}, err
	}
	return s.status, nil
}

func (s *fakeService) Stats(_ context.Context, refresh bool) (*StatsSnapshot, error) {
	if err := s.record(fmt.Sprintf("stats:%t", refresh)); err != nil {
		return nil, err
	}
	return s.snapshot, nil
}

func (s *fakeService) Use(_ context.Context, email string) error {
	return s.record("select:" + email)
}

func (s *fakeService) Update(_ context.Context, email string, enabled *bool, weight *float64) error {
	value := "nil"
	if enabled != nil {
		value = fmt.Sprintf("%t", *enabled)
	}
	weightValue := "nil"
	if weight != nil {
		weightValue = fmt.Sprintf("%g", *weight)
	}
	return s.record("update:" + email + ":" + value + ":" + weightValue)
}

func (s *fakeService) Import(_ context.Context, blob string, force bool) error {
	s.importBlob = blob
	return s.record(fmt.Sprintf("import:%t", force))
}

func (s *fakeService) Remove(_ context.Context, email string) error {
	return s.record("remove:" + email)
}

func (s *fakeService) Export(_ context.Context, email string) (string, error) {
	if err := s.record("export:" + email); err != nil {
		return "", err
	}
	return s.exportBlob, nil
}

type fakeHost struct {
	pluginsdk.UnimplementedHostData
	config map[string]any
}

func (h *fakeHost) GetConfig(context.Context) (map[string]any, error) {
	return h.config, nil
}
func (*fakeHost) GetState(context.Context, string, string, string) (map[string]any, bool, error) {
	return nil, false, nil
}
func (*fakeHost) SetState(context.Context, string, string, string, map[string]any) error {
	return nil
}
func (*fakeHost) DeleteState(context.Context, string, string, string) error { return nil }
func (*fakeHost) ListState(context.Context, string, string) ([]pluginsdk.StateEntry, error) {
	return nil, nil
}
func (*fakeHost) RevealSecret(context.Context, string) (string, error) { return "", nil }
func (*fakeHost) GetSecret(context.Context, string) (string, bool, error) {
	return "", false, nil
}
func (*fakeHost) SetSecret(context.Context, string, string) error { return nil }
func (*fakeHost) DeleteSecret(context.Context, string) error      { return nil }
func (*fakeHost) EmitEvent(context.Context, string, map[string]any) error {
	return nil
}

var _ pluginsdk.Host = (*fakeHost)(nil)

func testPlugin(service augpoolService, management bool) *augpoolPlugin {
	p := newAugpoolPlugin(func(pluginConfig) augpoolService { return service })
	p.SetHost(&fakeHost{config: map[string]any{
		"augpool_executable": "/custom/augpool",
		"augpool_home":       "/custom/home",
		"management_enabled": management,
	}})
	return p
}

func webhook(key, method, query, contentType, body string) *pluginsdk.WebhookRequest {
	return &pluginsdk.WebhookRequest{
		WebhookKey: key,
		Method:     method,
		Query:      query,
		Headers:    map[string]string{"Content-Type": contentType},
		Body:       []byte(body),
	}
}

func TestStatsWebhookReturnsCLIAndSnapshotWithoutCaching(t *testing.T) {
	service := newFakeService()
	p := testPlugin(service, false)

	response, err := p.HandleWebhook(context.Background(), webhook("stats", "GET", "refresh=1", "", ""))
	require.NoError(t, err)
	require.Equal(t, int32(200), response.Status)
	require.Equal(t, "application/json", response.Headers["Content-Type"])
	require.Equal(t, "no-store", response.Headers["Cache-Control"])
	require.Equal(t, []string{"status", "stats:true"}, service.calls)

	var payload dashboardResponse
	require.NoError(t, json.Unmarshal(response.Body, &payload))
	require.Equal(t, "augpool 0.2.0", payload.CLI.Version)
	require.Equal(t, 1, payload.Snapshot.SchemaVersion)
	require.False(t, payload.ManagementEnabled)
}

func TestPluginPassesTrimmedExecutableAndHomeSettingsToCLI(t *testing.T) {
	service := newFakeService()
	var got pluginConfig
	p := newAugpoolPlugin(func(config pluginConfig) augpoolService {
		got = config
		return service
	})
	p.SetHost(&fakeHost{config: map[string]any{
		"augpool_executable": "  /opt/Aug Pool/augpool  ",
		"augpool_home":       "  /srv/Aug Pool  ",
		"management_enabled": true,
	}})

	response, err := p.HandleWebhook(context.Background(), webhook("stats", "GET", "", "", ""))
	require.NoError(t, err)
	require.Equal(t, int32(200), response.Status)
	require.Equal(t, pluginConfig{
		Executable:        "/opt/Aug Pool/augpool",
		Home:              "/srv/Aug Pool",
		ManagementEnabled: true,
	}, got)
}

func TestActionWebhookManagementDisabledByDefault(t *testing.T) {
	service := newFakeService()
	p := testPlugin(service, false)

	response, err := p.HandleWebhook(context.Background(), webhook(
		"action", "POST", "", "application/json", `{"action":"select","email":"alice@example.com"}`,
	))
	require.NoError(t, err)
	require.Equal(t, int32(403), response.Status)
	require.Empty(t, service.calls)
}

func TestActionWebhookMapsEveryAccountOperation(t *testing.T) {
	tests := []struct {
		name       string
		body       string
		expectCall string
	}{
		{"select", `{"action":"select","email":"alice@example.com"}`, "select:alice@example.com"},
		{"enable", `{"action":"enable","email":"alice@example.com"}`, "update:alice@example.com:true:nil"},
		{"disable", `{"action":"disable","email":"alice@example.com"}`, "update:alice@example.com:false:nil"},
		{"weight", `{"action":"weight","email":"alice@example.com","weight":2.5}`, "update:alice@example.com:nil:2.5"},
		{"import", `{"action":"import","blob":"YWJjZA","force":true}`, "import:true"},
		{"remove", `{"action":"remove","email":"alice@example.com"}`, "remove:alice@example.com"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			service := newFakeService()
			p := testPlugin(service, true)
			response, err := p.HandleWebhook(context.Background(), webhook(
				"action", "POST", "", "application/json; charset=utf-8", test.body,
			))
			require.NoError(t, err)
			require.Equal(t, int32(200), response.Status)
			require.Equal(t, test.expectCall, service.calls[0])
			require.Equal(t, []string{"status", "stats:false"}, service.calls[1:])
			if test.name == "import" {
				require.Equal(t, "YWJjZA", service.importBlob)
			}
		})
	}
}

func TestExportActionReturnsOnlyBlob(t *testing.T) {
	service := newFakeService()
	p := testPlugin(service, true)

	response, err := p.HandleWebhook(context.Background(), webhook(
		"action", "POST", "", "application/json", `{"action":"export","email":"alice@example.com"}`,
	))
	require.NoError(t, err)
	require.Equal(t, int32(200), response.Status)
	require.JSONEq(t, `{"blob":"ZXhwb3J0ZWQtY3JlZGVudGlhbA"}`, string(response.Body))
	require.Equal(t, []string{"export:alice@example.com"}, service.calls)
	require.NotContains(t, string(response.Body), "snapshot")
}

func TestWebhookRejectsInvalidMethodQueryContentAndBody(t *testing.T) {
	tests := []struct {
		name string
		req  *pluginsdk.WebhookRequest
		want int32
	}{
		{"stats method", webhook("stats", "POST", "", "", ""), 405},
		{"stats query", webhook("stats", "GET", "refresh=0", "", ""), 400},
		{"action method", webhook("action", "GET", "", "", ""), 405},
		{"content type", webhook("action", "POST", "", "text/plain", `{}`), 400},
		{"unknown field", webhook("action", "POST", "", "application/json", `{"action":"select","email":"alice@example.com","secret":"x"}`), 400},
		{"unknown action", webhook("action", "POST", "", "application/json", `{"action":"shell","email":"alice@example.com"}`), 400},
		{"short email", webhook("action", "POST", "", "application/json", `{"action":"select","email":"alice"}`), 400},
		{"bad weight", webhook("action", "POST", "", "application/json", `{"action":"weight","email":"alice@example.com","weight":0}`), 400},
		{"unknown key", webhook("other", "GET", "", "", ""), 404},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response, err := testPlugin(newFakeService(), true).HandleWebhook(context.Background(), test.req)
			require.NoError(t, err)
			require.Equal(t, test.want, response.Status)
		})
	}
}

func TestWebhookMapsKnownBackendErrors(t *testing.T) {
	tests := []struct {
		err  error
		want int32
	}{
		{ErrAccountNotFound, 404},
		{ErrTimedOut, 504},
		{ErrCLIUnavailable, 502},
		{errors.New("other failure"), 502},
	}
	for _, test := range tests {
		service := newFakeService()
		service.err = test.err
		response, err := testPlugin(service, true).HandleWebhook(context.Background(), webhook(
			"action", "POST", "", "application/json", `{"action":"select","email":"alice@example.com"}`,
		))
		require.NoError(t, err)
		require.Equal(t, test.want, response.Status)
		require.NotContains(t, string(response.Body), "credential")
	}
}

func TestMissingCLIErrorExplainsAbsolutePathSetting(t *testing.T) {
	response := backendError(ErrCLIUnavailable)

	require.Equal(t, int32(502), response.Status)
	require.JSONEq(t, `{
		"error": "Augpool CLI not found. In plugin settings, set Augpool executable to the absolute path reported by command -v augpool (where augpool on Windows)."
	}`, string(response.Body))
}
