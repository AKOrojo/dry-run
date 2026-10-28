SHELL := /bin/bash
PY ?= python3
include $(wildcard .env)
export
export PYTHONPATH := $(CURDIR)

.PHONY: help setup fixtures contracts api web test smoke lint deploy

help:            ## list targets
	@grep -E '^[a-z-]+:.*##' Makefile | sed 's/:.*## /\t/'

setup:           ## install python (all extras) + web deps
	$(PY) -m pip install -e ".[sim,meta,dev]"
	cd web && npm install

fixtures:        ## write synthetic AOI to ./data (no GCP needed)
	$(PY) -m dryrun.pipeline.fixtures

contracts:       ## export JSON Schema + TS types for the web app
	$(PY) scripts/export_contracts.py
	cd web && npx --yes json-schema-to-typescript -i ../contracts/jsonschema/ -o src/contracts/gen/ --cwd ../contracts/jsonschema

api:             ## run API locally on :8080 (fake sim + fake agent by default)
	uvicorn dryrun.api.main:app --reload --port 8080

web:             ## run Vite dev server on :5173
	cd web && npm run dev

test:            ## unit tests
	$(PY) -m pytest -q

smoke:           ## end-to-end: fixtures -> 2 runs -> route -> fake agent brief
	$(PY) scripts/smoke.py

lint:
	ruff check dryrun tests scripts

deploy:          ## build + deploy to Cloud Run (needs gcloud auth + infra/env.sh)
	bash infra/scripts/deploy.sh
