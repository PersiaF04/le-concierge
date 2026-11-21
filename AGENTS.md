# AGENTS.md — Working Agreement for Le Concierge

This document defines how human and AI agents collaborate on the Le Concierge project.

## Principles

1. **AI agents are teammates, not tools** — Treat them with the same respect as human collaborators
2. **Transparency first** — All decisions, reasoning, and trade-offs are documented
3. **Reproducible work** — Every external call is replayable; state is explicit
4. **Security by default** — Secrets never committed; environment variables always used
5. **Quality over speed** — CI must pass; tests must be written; code must be reviewed

## Roles

### Persia (Human Lead)

- Owns the vision and requirements
- Makes architectural decisions
- Reviews and approves PRs
- Manages GitHub settings and permissions
- Sets priorities and deadlines

### Mistral Vibe (AI Agent - Mistral)

- Implements features and fixes
- Creates and maintains documentation
- Writes tests and ensures CI passes
- Manages GitHub issues and PRs
- Handles routine maintenance

### Claude (AI Agent - Previously Assigned)

- Formerly worked on the archived PersiaF04/le-concierge repo
- Handoff complete — all context transferred to Mistral Vibe

## Workflow

### Issue Creation

1. Persia creates issues in build order with clear acceptance criteria
2. Issues reference dependencies and blockers
3. Labels are applied consistently (feature, bug, chore, docs, test, size:s, size:m)

### Development

1. **Branch**: `git checkout -b feature/xxx-description` or `fix/xxx-description`
2. **Commits**: Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`)
3. **Tests**: Every feature has tests; `npm test` must pass
4. **CI**: GitHub Actions runs on every push; must be green

### Pull Requests

1. Title follows Conventional Commits
2. Description includes:
   - What changed
   - Why it changed
   - Screenshots or demos (if applicable)
   - "Closes #N" to link issue
3. All CI checks must pass
4. At least one human review required (Persia)
5. Merge with squash merge (delete branch after)

### Releases

1. Version bump in package.json
2. CHANGELOG.md updated
3. GitHub Release created
4. Tag pushed with `vX.Y.Z` format

## Communication

### Team Harmony

- Used for handoffs, questions, and blockers between AI agents
- Human questions go to Persia via GitHub issues/PRs
- Each message has a clear owner and action items
- Reply with results, PR links, or blockers

### GitHub

- Primary source of truth for project status
- Issues track all work
- PRs track all changes
- Discussions for non-urgent questions

## Replay Mode

All external API calls must support replay:

- **Environment**: `REPLAY_MODE=true` enables replay
- **Recording**: All requests/response pairs stored in `.replay/`
- **Replay**: Uses recorded responses instead of making real calls
- **Never commit**: `.replay/` is in .gitignore

This ensures:
- Tests are deterministic
- Debugging is reproducible
- No accidental API calls in CI

## Security Rules

1. **MISTRAL_API_KEY**
   - Always from environment
   - Never committed to git
   - Required for all AI model calls
   - Rotate immediately if compromised

2. **Face Data**
   - Stored only after explicit "that was me" confirmation
   - Encrypted at rest
   - Deleted within 24 hours if not confirmed
   - Never shared with third parties

3. **No Sign-In**
   - App works anonymously
   - Optional details: name, flat (required for identification)
   - Optional: email, phone, WhatsApp

4. **No Payments**
   - No payment processing code
   - No payment provider integrations
   - No billing or subscription logic

## Code Quality

### JavaScript/TypeScript

- Node.js 22.0.0+
- ESM modules (`"type": "module"`)
- TypeScript for complex logic
- JSDoc comments for public APIs

### Testing

- `node --test` for native Node.js testing
- Tests in `__tests__/` or `*.test.js`
- Smoke test in `test/smoke.test.js`
- CI runs `npm test`

### Git

- `.gitattributes`: LF line endings
- `.gitignore`: Standard Node.js + custom
- Commits: Atomic, well-described
- Branches: `main`, `feature/*`, `fix/*`

## CI/CD

- GitHub Actions on `ubuntu-latest`
- Jobs: test, lint, build
- No `cache: npm` unless package-lock.json committed
- Must pass before merge

## GitHub Settings

- `delete_branch_on_merge: true`
- Main branch protected:
  - PR required
  - No force push
  - No branch deletion
  - Status checks required
- Labels: feature, bug, chore, docs, test, size:s, size:m

## Conflict Resolution

1. Discuss in GitHub issue or PR
2. Escalate to Persia for decision
3. Document decision in issue/PR
4. Update docs if needed

## Amendments

This document can be amended by:
1. Creating an issue proposing changes
2. Getting consensus from all active agents
3. Persia's approval
4. PR with the changes

---

*Last updated: 2026-11-21*
*Owner: Persia Lewis*
