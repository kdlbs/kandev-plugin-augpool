.PHONY: build run test test-backend test-ui test-ui-syntax test-package-verifier \
	test-release-version fmt check-format vet verify-sdk-pin package package-host \
	verify-package verify-package-host package-file clean

# When you rename the plugin, update BIN and VERSION to match manifest.yaml's
# id and version (PKG_OUT is derived from them).
BIN := bin/kandev-augpool
VERSION := 0.1.7
STAGE := .build/stage
PKG_OUT := kandev-augpool-$(VERSION).tar.gz
KANDEV_SDK := ../kandev/apps/backend

## Build the plugin binary for the host platform (development use). kandev
## itself always installs from `make package`/`package-host` output, not this.
build: verify-sdk-pin
	mkdir -p bin
	go build -o $(BIN) ./server/...

## Build + run. Mainly for -race / manual smoke checks: kandev normally spawns
## this binary itself via the go-plugin handshake, so a manually-started
## process has nothing to talk to on the other end.
run: build
	./$(BIN)

test: verify-sdk-pin test-backend test-ui test-ui-syntax test-package-verifier test-release-version

test-backend:
	go test ./server/...

test-ui:
	node --test test/*.test.mjs

test-ui-syntax:
	node --check ui/bundle.js

test-package-verifier:
	sh scripts/test-verify-package.sh

test-release-version:
	sh scripts/test-verify-release-version.sh

fmt:
	gofmt -l .

check-format:
	@test -z "$$(gofmt -l .)" || { echo "gofmt needed:"; gofmt -l .; exit 1; }

vet: verify-sdk-pin
	go vet ./server/...

## Require the deliberate sibling SDK checkout to match the committed source pin.
verify-sdk-pin:
	@set -eu; \
		expected="$$(cat .kandev-sdk-ref)"; \
		case "$$expected" in *[!0-9a-f]*|'') echo "Invalid .kandev-sdk-ref: $$expected" >&2; exit 1 ;; esac; \
		test "$${#expected}" -eq 40 || { echo "Invalid .kandev-sdk-ref length: $$expected" >&2; exit 1; }; \
		actual="$$(git -C ../kandev rev-parse HEAD 2>/dev/null || true)"; \
		test "$$actual" = "$$expected" || { echo "Kandev SDK checkout must be $$expected (found $${actual:-missing}); see README.md." >&2; exit 1; }; \
		status="$$(git -C ../kandev status --porcelain --untracked-files=normal 2>/dev/null || true)"; \
		test -z "$$status" || { echo "Kandev SDK checkout has local changes; restore the pinned checkout before building." >&2; exit 1; }

## Cross-compile server/plugin-<goos>-<goarch>[.exe] for every platform in
## manifest.yaml's runtime.executables, stage manifest.yaml + ui/ alongside
## them, and pack the tree into $(PKG_OUT) with
## kandev's plugin-pack command from its own module. Install the tarball via
## Settings > Plugins or curl -F package=@...
package: verify-sdk-pin
	rm -rf $(STAGE)
	mkdir -p $(STAGE)/server
	cp manifest.yaml $(STAGE)/manifest.yaml
	cp -r ui $(STAGE)/ui
	GOOS=linux   GOARCH=amd64 go build -o $(STAGE)/server/plugin-linux-amd64       ./server
	GOOS=linux   GOARCH=arm64 go build -o $(STAGE)/server/plugin-linux-arm64       ./server
	GOOS=darwin  GOARCH=amd64 go build -o $(STAGE)/server/plugin-darwin-amd64      ./server
	GOOS=darwin  GOARCH=arm64 go build -o $(STAGE)/server/plugin-darwin-arm64      ./server
	GOOS=windows GOARCH=amd64 go build -o $(STAGE)/server/plugin-windows-amd64.exe ./server
	cd "$(KANDEV_SDK)" && go run ./cmd/plugin-pack -dir "$(CURDIR)/$(STAGE)" -out "$(CURDIR)/$(PKG_OUT)"
	rm -rf $(STAGE)
	@echo "Wrote $(PKG_OUT)"

## Package for the host platform only — faster local iteration than the full
## 5-platform `make package` (matches plugin-pack's -platform-only).
package-host: verify-sdk-pin
	rm -rf $(STAGE)
	mkdir -p $(STAGE)/server
	cp manifest.yaml $(STAGE)/manifest.yaml
	cp -r ui $(STAGE)/ui
	go build -o $(STAGE)/server/plugin-$$(go env GOOS)-$$(go env GOARCH)$$(go env GOEXE) ./server
	cd "$(KANDEV_SDK)" && go run ./cmd/plugin-pack -dir "$(CURDIR)/$(STAGE)" -out "$(CURDIR)/$(PKG_OUT)" -platform-only
	rm -rf $(STAGE)
	@echo "Wrote $(PKG_OUT)"

## Build and validate the complete all-platform archive.
verify-package: package
	@set -eu; \
		tmp="$$(mktemp -d)"; \
		trap 'rm -rf "$$tmp"' EXIT; \
		tar -xzf "$(PKG_OUT)" -C "$$tmp"; \
		cmp manifest.yaml "$$tmp/manifest.yaml"; \
		sh scripts/verify-package.sh "$$tmp" full

## Faster package validation for the current host platform.
verify-package-host: package-host
	@set -eu; \
		tmp="$$(mktemp -d)"; \
		trap 'rm -rf "$$tmp"' EXIT; \
		tar -xzf "$(PKG_OUT)" -C "$$tmp"; \
		cmp manifest.yaml "$$tmp/manifest.yaml"; \
		sh scripts/verify-package.sh "$$tmp" host "$$(go env GOOS)-$$(go env GOARCH)"

## Print the archive name without building it.
package-file:
	@printf '%s\n' "$(PKG_OUT)"

clean:
	rm -rf bin $(STAGE) kandev-augpool-*.tar.gz
