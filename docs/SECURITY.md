# Security Policy

This document describes the security practices for the AWS Swarm project.

## Dependency Security

### Automated Audits

The project uses automated dependency security audits in the CI pipeline to detect known vulnerabilities in dependencies.

#### CI Pipeline

Every pull request and push to `main` runs:

```bash
pnpm audit --audit-level=high
```

This command:
- Checks all dependencies (including transitive) against the npm advisory database
- **Fails the build** if high or critical severity vulnerabilities are found
- Reports moderate and low severity issues without failing

#### Severity Levels

| Severity | Action | Description |
|----------|--------|-------------|
| **Critical** | ❌ Fails build | Immediate exploitation risk; requires immediate fix |
| **High** | ❌ Fails build | Serious security risk; blocks merge until resolved |
| **Moderate** | ⚠️ Warning only | Should be addressed but won't block merge |
| **Low** | ℹ️ Info only | Minimal risk; fix when convenient |

### Handling Audit Failures

When the security audit fails in CI, follow these steps:

#### 1. Review the Vulnerability

```bash
# Run audit locally to see details
pnpm audit

# Get detailed report with recommendations
pnpm audit --json
```

#### 2. Attempt Automatic Fix

```bash
# Try automatic fix (updates dependencies)
pnpm audit --fix

# Verify the fix doesn't break anything
pnpm install
pnpm build
pnpm test
```

#### 3. Manual Resolution

If automatic fix doesn't work or breaks functionality:

**Option A: Update the vulnerable package**
```bash
# Update specific package
pnpm update package-name

# Or update all dependencies
pnpm update --latest
```

**Option B: Find alternative package**
- Search for maintained alternatives
- Replace in package.json
- Update code to use new package

**Option C: Override vulnerable transitive dependency**
- Add override to root `package.json`:
```json
{
  "pnpm": {
    "overrides": {
      "vulnerable-package": "fixed-version"
    }
  }
}
```

#### 4. Document Exceptions (Last Resort)

If a vulnerability cannot be fixed immediately (e.g., waiting for upstream fix):

1. Create an exception file `.npmrc`:
```
audit-level=high
```

2. Document in this file:

**Known Exceptions:**

| Package | Severity | Issue | Reason | Target Resolution |
|---------|----------|-------|--------|-------------------|
| example-pkg | High | CVE-XXXX | No fix available, not exploitable in our usage | 2026-03-01 |

3. Create a tracking issue in GitHub
4. Set reminder to re-evaluate monthly

### Dependency Update Strategy

1. **Regular Updates**: Review and update dependencies monthly
2. **Security Updates**: Apply security patches immediately
3. **Version Pinning**: Use exact versions in `pnpm-lock.yaml` (committed to git)
4. **Testing**: Always test after dependency updates

### Automated Dependency Updates

Consider enabling automated dependency updates:

**Dependabot** (GitHub native):
```yaml
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
    open-pull-requests-limit: 10
```

**Renovate** (more configurable):
```json
{
  "extends": ["config:base"],
  "schedule": ["before 3am on Monday"],
  "vulnerabilityAlerts": {
    "enabled": true
  }
}
```

## Reporting Security Vulnerabilities

**DO NOT** open public GitHub issues for security vulnerabilities.

Instead, please report security issues by contacting the project maintainers through GitHub's private vulnerability reporting feature or by email to the repository owner.

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We aim to respond within 48 hours.

## Security Best Practices

### Code Security

1. **No Secrets in Code**: Use AWS Secrets Manager, never commit secrets
2. **Input Validation**: Validate all external inputs (webhooks, API requests)
3. **Least Privilege**: Lambda roles have minimal necessary permissions
4. **Encryption**: All secrets encrypted with KMS, data at rest encrypted

### Infrastructure Security

1. **Zero Trust**: Cloudflare Access for admin authentication
2. **API Security**: Token-based webhook validation
3. **Network Isolation**: Lambda functions in VPC where needed
4. **Audit Logging**: All admin actions logged to CloudWatch

### Telegram Webhook Security

The Telegram webhook handler implements multiple security layers:

1. **Secret Token Verification**: Unique per-avatar webhook secrets
2. **IP Verification**: Checks against Telegram's official IP ranges
3. **No Information Disclosure**: Returns 200 for all errors
4. **Sanitized Logging**: Never logs message content or secrets

See `CLAUDE.md` for implementation details.

## Security Checklist for PRs

- [ ] No secrets or credentials in code
- [ ] All inputs validated and sanitized
- [ ] Dependencies audited (CI will check)
- [ ] No new high/critical vulnerabilities introduced
- [ ] Security-sensitive changes reviewed by maintainer
- [ ] Audit logging added for sensitive operations

## Security Tools

| Tool | Purpose | Status |
|------|---------|--------|
| `pnpm audit` | Dependency vulnerability scanning | ✅ Enabled in CI |
| CodeQL | Static code analysis | 🔄 Consider adding |
| Dependabot | Automated dependency updates | 🔄 Optional |
| npm-audit-resolver | Manage audit exceptions | 🔄 As needed |

## Security Contact

For security concerns or questions:
- GitHub Issues: Use `type:security` label (for non-sensitive issues only)
- Private Vulnerability Reporting: Use GitHub's security advisory feature
- Email: Contact repository owner through GitHub profile

## Compliance

This project follows security best practices including:
- OWASP Top 10 web application security risks
- AWS Well-Architected Framework security pillar
- Principle of least privilege
- Defense in depth

## License

This security policy is part of the AWS Swarm project and follows the same MIT license.

---

*Last updated: 2026-02-16*
