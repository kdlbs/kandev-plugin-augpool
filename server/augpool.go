package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	defaultCommandTimeout = 15 * time.Second
	defaultRefreshTimeout = 90 * time.Second
	statsOutputLimit      = 2 << 20
	commandOutputLimit    = 256 << 10
	commandErrorLimit     = 64 << 10
)

var (
	ErrCLIUnavailable     = errors.New("augpool CLI unavailable")
	ErrUnsupportedVersion = errors.New("unsupported Augpool version")
	ErrUnsupportedSchema  = errors.New("unsupported Augpool stats schema")
	ErrInvalidOutput      = errors.New("invalid Augpool output")
	ErrOutputTooLarge     = errors.New("Augpool output exceeded limit")
	ErrTimedOut           = errors.New("Augpool command timed out")
	ErrAccountNotFound    = errors.New("Augpool account not found")
)

var base64URLToken = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
var augpoolVersion = regexp.MustCompile(`^augpool ([0-9]+)\.([0-9]+)\.([0-9]+)(?:[.+-][0-9A-Za-z.-]+)?$`)

type CLICommand struct {
	Executable  string
	Args        []string
	Stdin       []byte
	StdoutLimit int
	StderrLimit int
}

type CLIOutput struct {
	Stdout []byte
	Stderr []byte
}

type Runner interface {
	Run(context.Context, CLICommand) (CLIOutput, error)
}

type CLIOptions struct {
	Executable     string
	Home           string
	Runner         Runner
	LookPath       func(string) (string, error)
	CommandTimeout time.Duration
	RefreshTimeout time.Duration
}

type AugpoolCLI struct {
	executable     string
	home           string
	runner         Runner
	lookPath       func(string) (string, error)
	commandTimeout time.Duration
	refreshTimeout time.Duration
	mutationMu     sync.Mutex
}

func NewAugpoolCLI(options CLIOptions) *AugpoolCLI {
	runner := options.Runner
	if runner == nil {
		runner = execRunner{}
	}
	lookPath := options.LookPath
	if lookPath == nil {
		lookPath = exec.LookPath
	}
	commandTimeout := options.CommandTimeout
	if commandTimeout <= 0 {
		commandTimeout = defaultCommandTimeout
	}
	refreshTimeout := options.RefreshTimeout
	if refreshTimeout <= 0 {
		refreshTimeout = defaultRefreshTimeout
	}
	return &AugpoolCLI{
		executable:     strings.TrimSpace(options.Executable),
		home:           strings.TrimSpace(options.Home),
		runner:         runner,
		lookPath:       lookPath,
		commandTimeout: commandTimeout,
		refreshTimeout: refreshTimeout,
	}
}

func (c *AugpoolCLI) resolveExecutable() (string, error) {
	if c.executable != "" {
		return c.executable, nil
	}
	resolved, err := c.lookPath("augpool")
	if err == nil {
		return resolved, nil
	}
	for _, candidate := range defaultExecutableCandidates() {
		resolved, candidateErr := c.lookPath(candidate)
		if candidateErr == nil {
			return resolved, nil
		}
	}
	return "", fmt.Errorf("%w: install augpool on Kandev's PATH or configure augpool_executable", ErrCLIUnavailable)
}

func defaultExecutableCandidates() []string {
	name := "augpool"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	candidates := make([]string, 0, 3)
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		candidates = append(candidates, filepath.Join(home, ".local", "bin", name))
	}
	if runtime.GOOS != "windows" {
		candidates = append(candidates, "/opt/homebrew/bin/augpool", "/usr/local/bin/augpool")
	}
	return candidates
}

func (c *AugpoolCLI) args(values ...string) []string {
	if c.home == "" {
		return values
	}
	return append([]string{"--home", c.home}, values...)
}

func (c *AugpoolCLI) run(
	ctx context.Context,
	operation string,
	args []string,
	stdin []byte,
	timeout time.Duration,
	stdoutLimit int,
) (CLIOutput, error) {
	executable, err := c.resolveExecutable()
	if err != nil {
		return CLIOutput{}, err
	}
	commandCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	output, runErr := c.runner.Run(commandCtx, CLICommand{
		Executable:  executable,
		Args:        args,
		Stdin:       stdin,
		StdoutLimit: stdoutLimit,
		StderrLimit: commandErrorLimit,
	})
	if errors.Is(commandCtx.Err(), context.DeadlineExceeded) {
		return CLIOutput{}, ErrTimedOut
	}
	if runErr != nil {
		var executableError *exec.Error
		if errors.Is(runErr, os.ErrNotExist) || errors.As(runErr, &executableError) {
			return CLIOutput{}, ErrCLIUnavailable
		}
		if errors.Is(runErr, ErrOutputTooLarge) {
			return CLIOutput{}, ErrOutputTooLarge
		}
		if operation == "import" {
			return CLIOutput{}, errors.New("augpool import failed")
		}
		message := safeCommandMessage(output.Stderr)
		if strings.Contains(strings.ToLower(message), "unknown account") {
			return CLIOutput{}, fmt.Errorf("%w: %s", ErrAccountNotFound, message)
		}
		if message == "" {
			message = "command failed"
		}
		return CLIOutput{}, fmt.Errorf("augpool %s failed: %s", operation, message)
	}
	return output, nil
}

func safeCommandMessage(stderr []byte) string {
	message := strings.TrimSpace(string(stderr))
	if index := strings.IndexByte(message, '\n'); index >= 0 {
		message = message[:index]
	}
	message = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, message)
	if len(message) > 512 {
		message = message[:512]
	}
	return message
}

func (c *AugpoolCLI) Status(ctx context.Context) (CLIStatus, error) {
	output, err := c.run(ctx, "version", []string{"--version"}, nil, c.commandTimeout, commandOutputLimit)
	if err != nil {
		return CLIStatus{}, err
	}
	version := strings.TrimSpace(string(output.Stdout))
	matches := augpoolVersion.FindStringSubmatch(version)
	if matches == nil || strings.Contains(version, "\n") {
		return CLIStatus{}, fmt.Errorf("%w: unexpected version response", ErrInvalidOutput)
	}
	major, _ := strconv.Atoi(matches[1])
	minor, _ := strconv.Atoi(matches[2])
	if major == 0 && minor < 3 {
		return CLIStatus{}, fmt.Errorf("%w: got %s; need 0.3.0 or newer", ErrUnsupportedVersion, version)
	}
	executable, err := c.resolveExecutable()
	if err != nil {
		return CLIStatus{}, err
	}
	return CLIStatus{Executable: executable, Version: version, Home: c.home}, nil
}

func (c *AugpoolCLI) Stats(ctx context.Context, refresh bool) (*StatsSnapshot, error) {
	args := c.args("stats", "--json")
	timeout := c.commandTimeout
	if refresh {
		args = append(args, "--refresh")
		timeout = c.refreshTimeout
	}
	output, err := c.run(ctx, "stats", args, nil, timeout, statsOutputLimit)
	if err != nil {
		return nil, err
	}
	var snapshot StatsSnapshot
	decoder := json.NewDecoder(bytes.NewReader(output.Stdout))
	if err := decoder.Decode(&snapshot); err != nil {
		return nil, fmt.Errorf("%w: stats JSON", ErrInvalidOutput)
	}
	if err := ensureEOF(decoder); err != nil {
		return nil, fmt.Errorf("%w: stats JSON", ErrInvalidOutput)
	}
	if snapshot.SchemaVersion != 1 {
		return nil, fmt.Errorf("%w: got %d, need 1; upgrade the plugin or Augpool", ErrUnsupportedSchema, snapshot.SchemaVersion)
	}
	if err := validateSnapshot(&snapshot); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidOutput, err)
	}
	return &snapshot, nil
}

func ensureEOF(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("multiple JSON values")
		}
		return err
	}
	return nil
}

func validateSnapshot(snapshot *StatsSnapshot) error {
	if snapshot.GeneratedAt == "" || snapshot.Strategy == "" || snapshot.Accounts == nil {
		return errors.New("missing required stats fields")
	}
	if snapshot.Usage.TTLSeconds < 0 || snapshot.Usage.FetchesOK < 0 || snapshot.Usage.TenantsQueried < 0 {
		return errors.New("invalid usage metadata")
	}
	for _, account := range snapshot.Accounts {
		if !strings.Contains(account.Email, "@") || strings.ContainsAny(account.Email, " \t\r\n") {
			return errors.New("invalid account email")
		}
		if account.Weight <= 0 || math.IsNaN(account.Weight) || math.IsInf(account.Weight, 0) {
			return errors.New("invalid account weight")
		}
	}
	return nil
}

func (c *AugpoolCLI) Use(ctx context.Context, email string) error {
	return c.mutate(ctx, "use", c.args("use", email, "--json"), nil)
}

func (c *AugpoolCLI) Update(
	ctx context.Context,
	email string,
	enabled *bool,
	weight *float64,
) error {
	args := c.args("update", email)
	if enabled != nil {
		if *enabled {
			args = append(args, "--enable")
		} else {
			args = append(args, "--disable")
		}
	}
	if weight != nil {
		args = append(args, "--weight", strconv.FormatFloat(*weight, 'g', -1, 64))
	}
	args = append(args, "--json")
	return c.mutate(ctx, "update", args, nil)
}

func (c *AugpoolCLI) Import(ctx context.Context, blob string, force bool) error {
	args := c.args("import", "-", "--json")
	if force {
		args = append(args, "--force")
	}
	return c.mutate(ctx, "import", args, []byte(blob+"\n"))
}

func (c *AugpoolCLI) Remove(ctx context.Context, email string) error {
	return c.mutate(ctx, "remove", c.args("remove", email, "--json"), nil)
}

func (c *AugpoolCLI) mutate(ctx context.Context, operation string, args []string, stdin []byte) error {
	c.mutationMu.Lock()
	defer c.mutationMu.Unlock()
	_, err := c.run(ctx, operation, args, stdin, c.commandTimeout, commandOutputLimit)
	return err
}

func (c *AugpoolCLI) Export(ctx context.Context, email string) (string, error) {
	output, err := c.run(
		ctx,
		"export",
		c.args("export", email),
		nil,
		c.commandTimeout,
		commandOutputLimit,
	)
	if err != nil {
		return "", err
	}
	blob := strings.TrimSpace(string(output.Stdout))
	if !base64URLToken.MatchString(blob) || strings.Contains(blob, "\n") {
		return "", fmt.Errorf("%w: export was not one base64url token", ErrInvalidOutput)
	}
	return blob, nil
}

type execRunner struct{}

func (execRunner) Run(ctx context.Context, command CLICommand) (CLIOutput, error) {
	cmd := exec.CommandContext(ctx, command.Executable, command.Args...)
	if len(command.Stdin) > 0 {
		cmd.Stdin = bytes.NewReader(command.Stdin)
	}
	stdout := newLimitedBuffer(command.StdoutLimit)
	stderr := newLimitedBuffer(command.StderrLimit)
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	err := cmd.Run()
	output := CLIOutput{Stdout: stdout.Bytes(), Stderr: stderr.Bytes()}
	if stdout.overflow || stderr.overflow {
		return output, ErrOutputTooLarge
	}
	return output, err
}

type limitedBuffer struct {
	buffer   bytes.Buffer
	limit    int
	overflow bool
}

func newLimitedBuffer(limit int) *limitedBuffer {
	return &limitedBuffer{limit: max(0, limit)}
}

func (b *limitedBuffer) Write(data []byte) (int, error) {
	originalLength := len(data)
	remaining := b.limit - b.buffer.Len()
	if remaining < len(data) {
		b.overflow = true
		if remaining > 0 {
			_, _ = b.buffer.Write(data[:remaining])
		}
		return originalLength, nil
	}
	_, _ = b.buffer.Write(data)
	return originalLength, nil
}

func (b *limitedBuffer) Bytes() []byte {
	return bytes.Clone(b.buffer.Bytes())
}
