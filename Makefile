# TeleHood — task runner.
#
#   make install       install workspace dependencies
#   make chain         run a local anvil chain on 127.0.0.1:8545 (foreground)
#   make deploy-local  deploy the contracts to that chain and sync addresses
#   make dev           run the relay (:8787) and the web app (:3000)
#   make build         compile contracts, regenerate ABIs, build every package
#   make test          forge test + every package's vitest suite
#   make fit           strict overflow check at 1440/1024/760/390 (needs make dev)
#   make clean         remove build output, caches and the relay database
#
# A normal first run is:  make install && make build   then in three terminals:
#   make chain  |  make deploy-local  |  make dev
#
# FIT_URL overrides the page checked by `make fit`:
#   make fit FIT_URL=http://localhost:3000/access

FIT_URL ?= http://localhost:3000

.DEFAULT_GOAL := help
.PHONY: help install chain deploy-local dev build test fit clean

help: ## show this list
	@grep -E '^[a-z-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  %-14s %s\n", $$1, $$2}'

install: ## install workspace dependencies (pnpm workspaces; contracts libs are vendored)
	pnpm install --frozen-lockfile

chain: ## run anvil on 127.0.0.1:8545, chain id 31337 (foreground; Ctrl-C to stop)
	anvil --chain-id 31337 --block-time 1

deploy-local: ## deploy to anvil and write the addresses into packages/crypto/src/deployments.ts
	node infra/scripts/deploy-local.mjs

dev: ## run @telehood/relay and @telehood/web together
	pnpm --parallel --filter @telehood/relay --filter @telehood/web dev

build: ## forge build -> sync ABIs -> build every workspace package
	forge build --root contracts && node infra/scripts/sync-abis.mjs && pnpm -r build

test: ## forge test + vitest across the workspace
	forge test --root contracts -vv && pnpm -r test

fit: ## assert nothing overflows at 1440/1024/760/390 px (requires a running web app)
	node infra/scripts/check-fit.mjs $(FIT_URL)

clean: ## remove build output, caches and the local relay database
	rm -rf contracts/out contracts/cache contracts/broadcast apps/web/.next apps/web/out apps/relay/data packages/crypto/dist
