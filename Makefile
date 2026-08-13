.DEFAULT_GOAL := help
SHELL := /bin/bash

help: ## List targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  %-10s %s\n", $$1, $$2}'

setup: ## Install toolchain and dependencies
	mise install
	pnpm install --frozen-lockfile

dev: ## Vite dev server
	pnpm dev

build: ## Production single-file build (fails if > 800 KB)
	pnpm build
	@size=$$(stat -c%s dist/index.html); \
	echo "dist/index.html: $$size bytes"; \
	test $$size -lt 800000 || { echo "bundle exceeds 800 KB budget"; exit 1; }

test: ## Unit tests
	pnpm test

test-diff: ## Differential test against real data: make test-diff DS1_DIR=~/Downloads/dreamsleep
	DS1_DIR=$(DS1_DIR) pnpm vitest run src/test/differential.test.ts

typecheck: ## tsc --noEmit
	pnpm typecheck

format: ## Prettier write
	pnpm format

lint: ## Prettier check
	pnpm lint

export: ## Decode .ds1 to CSV: make export OUT=csv IN="path/*.ds1"
	python3 ds1.py --export $(OUT) $(IN)

clean: ## Remove build output and caches
	rm -rf dist .vite node_modules/.vite

.PHONY: help setup dev build test test-diff typecheck format lint export clean
