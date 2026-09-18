.DEFAULT_GOAL := help
.PHONY: help setup dev start infra-up infra-down build test e2e release clean

PLUGIN_DIR := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

setup: ## Install dev dependencies (pnpm)
	pnpm install --frozen-lockfile

dev: ## Link the plugin into a local OpenClaw gateway and enable it
	openclaw plugins install --link "$(PLUGIN_DIR)" --force
	openclaw plugins enable jev-gate
	@echo "Set TYPESAFE_API_KEY in the gateway environment, then run: openclaw plugins inspect jev-gate --runtime --json"

start: ## No-op: the plugin runs inside the OpenClaw gateway process
	@echo "Nothing to start. The gateway loads the plugin (see 'make dev')."

infra-up: ## No-op: no local infrastructure
	@echo "No infrastructure for this plugin."

infra-down: ## No-op: no local infrastructure
	@echo "No infrastructure for this plugin."

build: ## Type-check and emit dist/
	pnpm run typecheck
	pnpm run build

test: ## Run unit tests
	pnpm run test

e2e: ## No-op: exercise the gate against a live gateway with 'make dev'
	@echo "No automated E2E suite. Use 'make dev' and send a group message."

release: ## No-op: not published yet
	@echo "Not published. To publish: point openclaw.extensions at dist/index.js, then npm pack."

clean: ## Remove build output
	rm -rf dist
