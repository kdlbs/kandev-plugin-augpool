package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"math"
	"mime"
	"net/url"
	"strings"
	"sync"

	"github.com/kandev/kandev/pkg/pluginsdk"
)

const maxActionBody = 64 << 10

type augpoolService interface {
	Status(context.Context) (CLIStatus, error)
	Stats(context.Context, bool) (*StatsSnapshot, error)
	Use(context.Context, string) error
	Update(context.Context, string, *bool, *float64) error
	Import(context.Context, string, bool) error
	Remove(context.Context, string) error
	Export(context.Context, string) (string, error)
}

type pluginConfig struct {
	Executable        string
	Home              string
	ManagementEnabled bool
}

type serviceFactory func(pluginConfig) augpoolService

type augpoolPlugin struct {
	pluginsdk.UnimplementedPlugin
	factory  serviceFactory
	actionMu sync.Mutex
}

var _ pluginsdk.Plugin = (*augpoolPlugin)(nil)

type dashboardResponse struct {
	CLI               CLIStatus      `json:"cli"`
	ManagementEnabled bool           `json:"management_enabled"`
	Snapshot          *StatsSnapshot `json:"snapshot"`
}

type actionRequest struct {
	Action string   `json:"action"`
	Email  string   `json:"email"`
	Weight *float64 `json:"weight"`
	Blob   string   `json:"blob"`
	Force  *bool    `json:"force"`
}

func newPlugin() *augpoolPlugin {
	return newAugpoolPlugin(func(config pluginConfig) augpoolService {
		return NewAugpoolCLI(CLIOptions{
			Executable: config.Executable,
			Home:       config.Home,
		})
	})
}

func newAugpoolPlugin(factory serviceFactory) *augpoolPlugin {
	return &augpoolPlugin{factory: factory}
}

func (p *augpoolPlugin) HandleWebhook(
	ctx context.Context,
	req *pluginsdk.WebhookRequest,
) (*pluginsdk.WebhookResponse, error) {
	switch req.WebhookKey {
	case "stats":
		return p.handleStats(ctx, req), nil
	case "action":
		return p.handleAction(ctx, req), nil
	default:
		return errorResponse(404, "Webhook not found"), nil
	}
}

func (p *augpoolPlugin) handleStats(
	ctx context.Context,
	req *pluginsdk.WebhookRequest,
) *pluginsdk.WebhookResponse {
	if req.Method != "GET" {
		return methodNotAllowed("GET")
	}
	refresh, err := parseRefreshQuery(req.Query)
	if err != nil {
		return errorResponse(400, "Query must be empty or refresh=1")
	}
	config, err := p.config(ctx)
	if err != nil {
		return errorResponse(502, "Could not read plugin settings")
	}
	return p.dashboard(ctx, p.factory(config), config, refresh)
}

func parseRefreshQuery(raw string) (bool, error) {
	if raw == "" {
		return false, nil
	}
	query, err := url.ParseQuery(raw)
	if err != nil || len(query) != 1 {
		return false, errors.New("invalid query")
	}
	values, ok := query["refresh"]
	if !ok || len(values) != 1 || values[0] != "1" {
		return false, errors.New("invalid refresh value")
	}
	return true, nil
}

func (p *augpoolPlugin) handleAction(
	ctx context.Context,
	req *pluginsdk.WebhookRequest,
) *pluginsdk.WebhookResponse {
	if req.Method != "POST" {
		return methodNotAllowed("POST")
	}
	if !isJSONContentType(header(req.Headers, "Content-Type")) {
		return errorResponse(400, "Content-Type must be application/json")
	}
	config, err := p.config(ctx)
	if err != nil {
		return errorResponse(502, "Could not read plugin settings")
	}
	if !config.ManagementEnabled {
		return errorResponse(403, "Account management is disabled in plugin settings")
	}
	action, err := decodeAction(req.Body)
	if err != nil {
		return errorResponse(400, err.Error())
	}

	p.actionMu.Lock()
	defer p.actionMu.Unlock()
	service := p.factory(config)
	if action.Action == "export" {
		blob, err := service.Export(ctx, action.Email)
		if err != nil {
			return backendError(err)
		}
		return jsonResponse(200, map[string]string{"blob": blob})
	}
	if err := executeAction(ctx, service, action); err != nil {
		return backendError(err)
	}
	return p.dashboard(ctx, service, config, false)
}

func executeAction(ctx context.Context, service augpoolService, action actionRequest) error {
	switch action.Action {
	case "select":
		return service.Use(ctx, action.Email)
	case "enable":
		enabled := true
		return service.Update(ctx, action.Email, &enabled, nil)
	case "disable":
		enabled := false
		return service.Update(ctx, action.Email, &enabled, nil)
	case "weight":
		return service.Update(ctx, action.Email, nil, action.Weight)
	case "import":
		force := action.Force != nil && *action.Force
		return service.Import(ctx, action.Blob, force)
	case "remove":
		return service.Remove(ctx, action.Email)
	default:
		return errors.New("unsupported action")
	}
}

func decodeAction(body []byte) (actionRequest, error) {
	if len(body) == 0 || len(body) > maxActionBody {
		return actionRequest{}, errors.New("Request body is empty or too large")
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	var action actionRequest
	if err := decoder.Decode(&action); err != nil {
		return actionRequest{}, errors.New("Request body must be one JSON object")
	}
	if err := ensureEOF(decoder); err != nil {
		return actionRequest{}, errors.New("Request body must be one JSON object")
	}
	if err := validateAction(action); err != nil {
		return actionRequest{}, err
	}
	return action, nil
}

func validateAction(action actionRequest) error {
	requireEmail := func() error {
		if action.Email == "" || action.Email != strings.TrimSpace(action.Email) ||
			!strings.Contains(action.Email, "@") || strings.ContainsAny(action.Email, " \t\r\n") {
			return errors.New("A full account email is required")
		}
		return nil
	}
	noImportFields := func() error {
		if action.Blob != "" || action.Force != nil {
			return errors.New("Action contains fields it does not use")
		}
		return nil
	}

	switch action.Action {
	case "select", "enable", "disable", "remove", "export":
		if err := requireEmail(); err != nil {
			return err
		}
		if action.Weight != nil || noImportFields() != nil {
			return errors.New("Action contains fields it does not use")
		}
	case "weight":
		if err := requireEmail(); err != nil {
			return err
		}
		if action.Weight == nil || *action.Weight <= 0 || math.IsNaN(*action.Weight) || math.IsInf(*action.Weight, 0) {
			return errors.New("Weight must be a finite number greater than zero")
		}
		if err := noImportFields(); err != nil {
			return err
		}
	case "import":
		if action.Email != "" || action.Weight != nil {
			return errors.New("Import contains fields it does not use")
		}
		if len(action.Blob) == 0 || len(action.Blob) > maxActionBody/2 || !base64URLToken.MatchString(action.Blob) {
			return errors.New("Import blob must be one base64url token")
		}
	default:
		return errors.New("Unsupported action")
	}
	return nil
}

func (p *augpoolPlugin) dashboard(
	ctx context.Context,
	service augpoolService,
	config pluginConfig,
	refresh bool,
) *pluginsdk.WebhookResponse {
	status, err := service.Status(ctx)
	if err != nil {
		return backendError(err)
	}
	snapshot, err := service.Stats(ctx, refresh)
	if err != nil {
		return backendError(err)
	}
	return jsonResponse(200, dashboardResponse{
		CLI:               status,
		ManagementEnabled: config.ManagementEnabled,
		Snapshot:          snapshot,
	})
}

func (p *augpoolPlugin) config(ctx context.Context) (pluginConfig, error) {
	host := p.Host()
	if host == nil {
		return pluginConfig{}, nil
	}
	values, err := host.GetConfig(ctx)
	if err != nil {
		return pluginConfig{}, err
	}
	config := pluginConfig{}
	config.Executable, _ = values["augpool_executable"].(string)
	config.Home, _ = values["augpool_home"].(string)
	config.ManagementEnabled, _ = values["management_enabled"].(bool)
	config.Executable = strings.TrimSpace(config.Executable)
	config.Home = strings.TrimSpace(config.Home)
	return config, nil
}

func isJSONContentType(value string) bool {
	mediaType, _, err := mime.ParseMediaType(value)
	return err == nil && mediaType == "application/json"
}

func header(headers map[string]string, name string) string {
	for key, value := range headers {
		if strings.EqualFold(key, name) {
			return value
		}
	}
	return ""
}

func backendError(err error) *pluginsdk.WebhookResponse {
	switch {
	case errors.Is(err, ErrAccountNotFound):
		return errorResponse(404, "Account not found")
	case errors.Is(err, ErrTimedOut):
		return errorResponse(504, "Augpool command timed out")
	case errors.Is(err, ErrCLIUnavailable):
		return errorResponse(502, "Augpool CLI not found. In plugin settings, set Augpool executable to the absolute path reported by command -v augpool (where augpool on Windows).")
	case errors.Is(err, ErrUnsupportedVersion):
		return errorResponse(502, "Augpool 0.3.0 or newer is required; upgrade the configured CLI")
	case errors.Is(err, ErrUnsupportedSchema):
		return errorResponse(502, "Augpool stats schema is incompatible; upgrade Augpool or this plugin")
	default:
		return errorResponse(502, "Augpool command failed")
	}
}

func methodNotAllowed(allow string) *pluginsdk.WebhookResponse {
	response := errorResponse(405, "Method not allowed")
	response.Headers["Allow"] = allow
	return response
}

func errorResponse(status int32, message string) *pluginsdk.WebhookResponse {
	return jsonResponse(status, map[string]string{"error": message})
}

func jsonResponse(status int32, payload any) *pluginsdk.WebhookResponse {
	body, err := json.Marshal(payload)
	if err != nil {
		status = 500
		body = []byte(`{"error":"Response encoding failed"}`)
	}
	return &pluginsdk.WebhookResponse{
		Status: status,
		Headers: map[string]string{
			"Content-Type":  "application/json",
			"Cache-Control": "no-store",
		},
		Body: body,
	}
}
