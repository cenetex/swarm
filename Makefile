# Swarm Project Makefile
# Common tasks for development and deployment

.PHONY: help install build dev test lint typecheck clean secrets deploy gh-secrets synth diff bootstrap

# Default target
help:
	@echo "Swarm Project Commands:"
	@echo ""
	@echo "  make install      - Install all dependencies"
	@echo "  make build        - Build all packages"
	@echo "  make dev          - Start development server (admin-ui)"
	@echo "  make test         - Run all tests"
	@echo "  make lint         - Run linter"
	@echo "  make typecheck    - Run TypeScript type checking"
	@echo "  make clean        - Clean build artifacts"
	@echo ""
	@echo "  make secrets      - Setup AWS Secrets Manager (staging)"
	@echo "  make secrets-prod - Setup AWS Secrets Manager (production)"
	@echo "  make gh-secrets   - Manage GitHub repository secrets (CI/CD)"
	@echo ""
	@echo "  make bootstrap    - Update OIDC role CloudFormation stack"
	@echo "  make deploy       - Deploy to staging (via GitHub Actions)"
	@echo "  make synth        - Synthesize CDK stack"
	@echo ""

# Development
install:
	pnpm install

build:
	pnpm -r build

dev:
	cd packages/admin-ui && pnpm dev

test:
	pnpm -r test

lint:
	pnpm -r lint

typecheck:
	pnpm -r typecheck

clean:
	pnpm -r clean
	rm -rf node_modules/.cache
	find . -name "dist" -type d -prune -exec rm -rf {} \; 2>/dev/null || true
	find . -name "*.tsbuildinfo" -delete 2>/dev/null || true

# AWS Secrets
secrets:
	./scripts/setup-secrets.sh staging

secrets-prod:
	./scripts/setup-secrets.sh prod

# GitHub Secrets (CI/CD)
gh-secrets:
	./scripts/setup-github-secrets.sh

# Bootstrap / OIDC role
bootstrap:
	@echo "Updating OIDC role CloudFormation stack..."
	aws cloudformation deploy \
		--template-file .github/cloudformation/github-oidc-role.yml \
		--stack-name github-oidc-role \
		--capabilities CAPABILITY_NAMED_IAM \
		--no-fail-on-empty-changeset
	@echo "✅ OIDC role stack updated."

