# Console plugin replacement implementation plan

**Goal:** Rebuild the Console request path without duplicate model retries or credential refresh races.
**Spec:** ../specs/2026-10-29-honest-console-plugin.md
**Execution:** Inline in the current repository, as authorized by the user. Preserve unrelated edits.
**Stack:** TypeScript, @opencode/plugin 2.2.1, node:test.

## Tasks
1. Write failing provider and credential tests for coordinated key creation, OAuth expiry,
   untouched 429/529 responses, replay protection, origin scope and preserved SDK headers.
2. Replace src/provider.ts request handling and simplify src/model-config.ts. Preserve the
   registerConsoleRequests entry point. Replace AInative HTTP hooks with native session HTTP hooks.
   Change src/credentials.ts refreshCredential to preserve an existing API key.
3. Verify failure recovery, connection switches and native request concurrency with additional tests.
   Repair only behavior those tests expose. Use response hooks to invalidate rejected keys without replay.
4. Test login transport cancellation and response cleanup, then fix src/http.ts as needed.
   Test and repair ESM logging. Keep the existing retry environment variable compatible.
5. Update README.md and package.json for the replacement behavior and Node runtime.
6. Run npm test, git diff --check and npm pack --dry-run. Review the complete diff and fix
   substantive findings. Leave the active OpenCode configuration unchanged.

## Review focus
Concurrent 401s must trigger one update on the next request; stale refreshes must not replace a new connection;
stream bodies must never be replayed; cancellation must stop waits; quota responses must
reach OpenCode intact. Tests use injected network boundaries rather than live credentials.

## Verification record

- Baseline: 36 tests passed before edits.
- Test-first failures confirmed duplicate key creation, ineffective native hook registration,
  model retry duplication, OAuth cancellation and ESM logging failures.
- Review found two credential recovery issues. Regression tests confirmed both failures:
  losing rotated tokens after key-creation failure, and losing them during account switches.
  The implementation now retains per-connection updates before attempting key creation.
- Type checking found the old handwritten OAuth type lacked OpenCode's branded method ID.
  The plugin now uses Credential.OAuth and Integration.MethodID.make.
- Final checks passed: npm test (48 tests), TypeScript noEmit, git diff --check, package dry run and tarball contents.
- Independent review: both recovery findings resolved; no remaining blockers reported.
- Live OpenCode authorization and a billed model request were not run. User configuration is unchanged.

## OAuth exchange correction (0.2.1)

User reported rate_limit_error at token exchange, before model requests. Comparing Pi's
current oauth/tokens.ts confirms identical endpoint, client ID, grant fields and explicit
headers, but Pi makes one exchange attempt. The plugin now also exchanges each code once.
Regression tests first showed three attempts and missing status/retry/request-ID diagnostics.
This change corrects retry behavior and exposes server metadata; it does not establish or
claim to fix the server's reason for rejecting the first exchange.

## Runtime transport correction (0.2.2)

User confirmed a fresh Pi login succeeds. Differential localhost probe of Node versus
OpenCode's embedded Bun 1.4.4 confirmed differing default User-Agent and encoding headers.
A Bun regression test first failed with Bun/1.4.4 versus Node's node header, then passed
using src/oauth-transport.ts. OAuth functions use that transport by default under Bun;
injected test fetches are preserved. Model transport is unchanged. Add coverage for
upstream 429 metadata and cancellation. Run Node suite, Bun transport tests and TypeScript
checks before reload. A fresh remote login is still required to validate the hypothesis.
