# Mail Credential Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the mail transport authenticate from the encrypted secrets store instead of an environment variable, so the store finally has a production consumer.

**Architecture:** The transport stops holding credentials. `SmtpConfig.auth` is removed, and `MailSendContext.credential` becomes the only source of the SMTP password — so a caller with no credential is a compile error rather than a quiet fallback. Both callers resolve their own ref per send: plan-driven sends already do (the binding's `credential_ref`, resolved by `runPlan`), and the notifier gains its own ref and its own lookup.

**Tech Stack:** TypeScript NodeNext ESM, Postgres 17 via `pg`, nodemailer, vitest against a real database.

**Spec:** [docs/superpowers/specs/2026-09-24-mail-credential-wiring-design.md](../specs/2026-09-24-mail-credential-wiring-design.md)

## Global Constraints

- `.js` on every relative import, including from `.ts` files — required by `NodeNext` + `"type": "module"`.
- `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` (conditional spread for optional properties), `verbatimModuleSyntax` (`import type` separated exactly), `noUnusedLocals` — all on.
- Hebrew for anything a human reads (rejection reasons, dashboard copy, CLI output, docs). English for identifiers, comments and internal errors.
- **The username is configuration, not a secret. Only the password comes from the store.** An account name identifies rather than authenticates, and making it a secret would mean an operator cannot see which account an install uses without decrypting.
- **Resolve per send. Never cache a resolved secret in a module variable or a closure that outlives one send.** A secret held in memory keeps working after the owner rotates it, which is the opposite of what should happen in the scenario that prompts a rotation.
- **Five places the secret value must never reach** (spec §6): an error message, an audit row, a log line (including nodemailer's `debug`/`logger` options, which print the SMTP dialogue and the AUTH exchange inside it), `process.env` or any child process, and a thrown object.
- **A value that could not be read is never the permissive value.** A ref that does not resolve is a refusal, never a fallback.
- **Controls are written positively, never as "everything except X".**
- **A negative test must prove the code it covers actually ran.** Asserting that a secret does not appear somewhere passes trivially if the secret was never in the path — every such test must first assert the value WAS present where it belongs.
- Read `CLAUDE.md`'s "כללים שהקוד אוכף בשקט" before touching the credential path.
- Tests need a real Postgres. Do not run `npm test` — the controller owns the single full-suite run.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/mail/transport.ts` (modify) | Drop `SmtpConfig.auth`; authenticate from `context.credential.value`; refuse an empty one. |
| `src/governance/notify.ts` (modify) | Resolve the notifier's own ref per send instead of presenting an empty placeholder handle. |
| `src/orchestrator/runtime.ts` (modify) | Stop reading `SMTP_PASS`; read `NOTIFY_CREDENTIAL_REF`; hand the notifier a `CredentialSource` and the ref. |
| `src/config.ts` (modify) | `NOTIFY_CREDENTIAL_REF` replaces `SMTP_PASS` in the mail-config gate. |
| `.env.example`, `CLAUDE.md`, `docs/dashboard-deployment.md` (modify) | The provisioning step an operator must now perform, and what breaks until they do. |

---

## Task 1: The transport authenticates from the handed credential

**Files:**
- Modify: `src/mail/transport.ts`
- Test: `src/mail/transport.test.ts`

**Interfaces:**
- Consumes: `CredentialHandle` from `src/orchestrator/adapters/types.ts` — `{ readonly ref: string; readonly value: string; readonly toJSON: () => unknown }`, where `value` is defined non-enumerable so `JSON.stringify` and `canonicalJson` cannot see it.
- Produces: `SmtpConfig` **without** an `auth` field. `createSmtpTransport(config: SmtpConfig): MailTransport` keeps its signature otherwise, and `MailTransport.send(message, context)` keeps `MailSendContext.credential: CredentialHandle` as it already is.

- [ ] **Step 1: Write the failing tests**

Add to `src/mail/transport.test.ts`. The existing file already builds an `SmtpConfig`; update its helper to drop `auth` and let the compiler find every construction site.

```ts
  it('authenticates with the credential handed to this send, not with anything the transport holds', async () => {
    // The positive half first: without this, the negative assertions below
    // would pass on a transport that authenticated with nothing at all.
    const captured: Array<{ user?: string; pass?: string }> = [];
    const transport = createSmtpTransport(configWithoutAuth({ createTransport: (opts) => {
      captured.push(opts.auth);
      return fakeTransporter();
    } }));
    await transport.send(aMessage(), aContext({ credential: createCredentialHandle('OFFICE_MAIL', 'סוד-אמיתי-1') }));
    expect(captured[0]?.pass).toBe('סוד-אמיתי-1');
    expect(captured[0]?.user).toBe(configWithoutAuth().user);
  });

  it('uses the second send\'s credential, not the first — nothing is cached', async () => {
    const captured: string[] = [];
    const transport = createSmtpTransport(configWithoutAuth({ createTransport: (opts) => {
      captured.push(opts.auth.pass);
      return fakeTransporter();
    } }));
    await transport.send(aMessage(), aContext({ credential: createCredentialHandle('A', 'ראשון') }));
    await transport.send(aMessage(), aContext({ credential: createCredentialHandle('A', 'שני') }));
    expect(captured).toEqual(['ראשון', 'שני']);
  });

  it('refuses a send whose credential carries an empty value, before opening a socket', async () => {
    let opened = false;
    const transport = createSmtpTransport(configWithoutAuth({ createTransport: () => { opened = true; return fakeTransporter(); } }));
    await expect(
      transport.send(aMessage(), aContext({ credential: createCredentialHandle('OFFICE_MAIL', '') })),
    ).rejects.toThrow(/credential/i);
    // The point of refusing early: an empty password is not an anonymous
    // send, it is a misconfiguration, and it must cost nothing external.
    expect(opened).toBe(false);
  });

  it('keeps the secret out of the error a failed authentication produces', async () => {
    const secret = 'סוד-שאסור-לו-להופיע';
    const transport = createSmtpTransport(configWithoutAuth({ createTransport: () => ({
      sendMail: () => Promise.reject(new Error('535 Authentication credentials invalid')),
    }) }));
    const err = await transport
      .send(aMessage(), aContext({ credential: createCredentialHandle('OFFICE_MAIL', secret) }))
      .catch((e: unknown) => e);
    expect(String(err)).toContain('535');
    expect(String(err)).not.toContain(secret);
    // And the handle itself must not serialise the value into anything.
    expect(JSON.stringify({ c: createCredentialHandle('OFFICE_MAIL', secret) })).not.toContain(secret);
  });

  it('never enables nodemailer\'s debug or logger options', () => {
    // Both print the SMTP dialogue, and the AUTH exchange is inside it.
    const captured: Array<Record<string, unknown>> = [];
    const transport = createSmtpTransport(configWithoutAuth({ createTransport: (opts) => {
      captured.push(opts as Record<string, unknown>);
      return fakeTransporter();
    } }));
    void transport.send(aMessage(), aContext());
    expect(captured[0]?.['debug']).toBeUndefined();
    expect(captured[0]?.['logger']).toBeUndefined();
  });
```

**The seam does not exist and you must add it — this is settled, not a judgement call.** `src/mail/transport.test.ts` has eight tests and every one of them stops before a socket opens; the file's own comment at `:16-19` says so explicitly. So none of the assertions above can be written today.

Add an optional factory field to `SmtpConfig`, typed as a function returning the minimal `{ sendMail }` shape the send path actually uses, defaulting to `nodemailer.createTransport`. In its docblock, name the precedent rather than inventing a justification: `LocalToolContext.reader` and `LocalToolContext.verifier` exist for the identical reason — "the one step that costs money, injectable so a test can drive it without an API key" — and `ReadDocumentOptions.reader` before them. Production never passes it.

**Two existing tests in that file need deciding, and here is the decision.** `:85` refuses to build a transport with an empty username and `:97` refuses to build one with an empty password. The username stays configuration, so `:85` is unaffected and stays exactly as it is. The password is no longer present at build time at all, so `:97`'s property moves to where the value now arrives — a send whose credential carries an empty value, which is the third test above. **Move it; do not delete it.** Deleting a real control because its location became inconvenient is how controls disappear.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/mail/transport.test.ts`
Expected: FAIL — `SmtpConfig` still requires `auth`, and the transport still authenticates from it.

- [ ] **Step 3: Implement**

Remove `auth` from `SmtpConfig` and its validation. In `send`, before anything opens a socket:

```ts
      // `config.auth` is gone. The credential this send was handed is the only
      // source, which is what makes "a caller with no credential" a compile
      // error rather than a silent fallback to somebody else's account. The
      // previous shape held an unconditional `auth` precisely so the notifier
      // — which had no per-call credential — could not authenticate with one;
      // the notifier now resolves its own, so the default has nothing left to
      // protect and its existence is the hazard.
      if (context.credential.value.length === 0) {
        throw new Error(
          'createSmtpTransport: הסוד שהועבר לשליחה ריק — לא ניתן להזדהות מול שרת הדואר',
        );
      }
```

and build the transporter with `auth: { user: config.user, pass: context.credential.value }`. Rename `SmtpConfig.auth.user` to a plain `SmtpConfig.user: string` — the username stays configuration.

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run src/mail/transport.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, then commit**

`npm run typecheck` will now fail at every site that builds an `SmtpConfig` with `auth` — that is the compiler doing the work of finding the callers, and those sites are Tasks 2 and 3. Commit this task with the transport and its tests only; leave the callers failing to typecheck until their own task, and say so in the commit message so a bisect lands on a known state.

```bash
git add src/mail/transport.ts src/mail/transport.test.ts
git commit -m "The transport authenticates with the credential it was handed"
```

---

## Task 2: The notifier resolves its own credential

**Files:**
- Modify: `src/governance/notify.ts`
- Test: `src/governance/notify.test.ts`

**Interfaces:**
- Consumes: `CredentialSource` from `src/orchestrator/credentials.ts` — `{ resolve(ref: string, businessId: string): Promise<CredentialHandle | null> }`. Note `businessId` is **required and has no default**, deliberately: an omission would silently read the configured business's secret, which is how one tenant reads another's.
- Produces: `createEmailNotifier(transport: MailTransport, to: string, credentials: CredentialSource, ref: string, businessId: string): ApprovalNotifier` — four positional arguments become five plus one; if that reads badly at the call site, take an options object instead and say so in the report, but do not give any parameter a default.

- [ ] **Step 1: Write the failing tests**

**Use the file's own fake, not new ones.** `src/governance/notify.test.ts:100` already has `recordingTransport()`, which returns a `MailTransport` and a `sent` array. Extend it so it also records the credential each send presented — that is the one thing it is missing. The helper names in the test code below (`transportCapturing`, `stubSource`, `mutableSource`, and the rest) are placeholders for shapes you should build from that existing fake plus a small `CredentialSource` stub; five new single-use helpers beside an existing one is the duplication the review rubric treats as a defect.

```ts
  it('resolves its own credential per notification and sends with it', async () => {
    const sent: string[] = [];
    const notifier = createEmailNotifier(
      transportCapturing(sent), 'boss@example.com',
      stubSource({ NOTIFY_MAIL: 'סוד-המודיע' }), 'NOTIFY_MAIL', BUSINESS,
    );
    expect(await notifier.notify(aRequest(), 'https://x/a/1')).toEqual({ ok: true });
    expect(sent).toEqual(['סוד-המודיע']);
  });

  it('resolves again on the second notification, so a rotation takes effect without a restart', async () => {
    const sent: string[] = [];
    const source = mutableSource({ NOTIFY_MAIL: 'לפני' });
    const notifier = createEmailNotifier(transportCapturing(sent), 'boss@example.com', source, 'NOTIFY_MAIL', BUSINESS);
    await notifier.notify(aRequest(), 'https://x/a/1');
    source.set('NOTIFY_MAIL', 'אחרי');
    await notifier.notify(aRequest(), 'https://x/a/2');
    expect(sent).toEqual(['לפני', 'אחרי']);
  });

  it('reports a failure without sending when the ref does not resolve', async () => {
    let sends = 0;
    const notifier = createEmailNotifier(
      transportCounting(() => { sends += 1; }), 'boss@example.com',
      stubSource({}), 'NOTIFY_MAIL', BUSINESS,
    );
    // `notify` never throws by contract — the approval row already exists and
    // the dashboard already shows it. An unresolved ref is the same class of
    // event as an unreachable relay.
    const result = await notifier.notify(aRequest(), 'https://x/a/1');
    expect(result.ok).toBe(false);
    expect(sends).toBe(0);
  });

  it('keeps the secret out of the failure it reports', async () => {
    const secret = 'סוד-המודיע-שאסור-להופיע';
    const notifier = createEmailNotifier(
      transportRejecting(new Error('535 Authentication credentials invalid')), 'boss@example.com',
      stubSource({ NOTIFY_MAIL: secret }), 'NOTIFY_MAIL', BUSINESS,
    );
    const result = await notifier.notify(aRequest(), 'https://x/a/1');
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(secret);
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/governance/notify.test.ts`
Expected: FAIL — `createEmailNotifier` takes two arguments and presents `SYSTEM_CREDENTIAL`.

- [ ] **Step 3: Implement**

Delete `SYSTEM_CREDENTIAL` — the placeholder built with `createCredentialHandle('notify:system', '')` — and resolve inside `notify` instead, before building the message. An unresolved ref returns the same `{ ok: false }` shape a transport failure already returns, and must not throw: `notify`'s contract is that a notification failure never fails the approval it announces.

Keep the existing `withDeadline` race exactly as it is. The resolution is a local database read, not a network call, and giving it its own timeout would be inventing a second deadline where the module already argues for one.

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run src/governance/notify.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run typecheck   # runtime.ts will still fail; Task 3 closes it
git add src/governance/notify.ts src/governance/notify.test.ts
git commit -m "The notifier resolves its own credential, per notification"
```

---

## Task 3: The runtime stops reading the password from the environment

**Files:**
- Modify: `src/orchestrator/runtime.ts`
- Modify: `src/config.ts`
- Test: `src/orchestrator/runtime.test.ts`

**Interfaces:**
- Consumes: Task 1's `SmtpConfig` without `auth`; Task 2's `createEmailNotifier` with its credential parameters. `storedCredentials(key)` from `src/governance/credential-store.ts` returns the production `CredentialSource`, and `buildRuntime` already builds it.
- Produces: a runtime whose `notify` is present only when the mail configuration AND `NOTIFY_CREDENTIAL_REF` are all set, with a warning naming what is missing otherwise.

- [ ] **Step 1: Write the failing tests**

**Follow this file's own conventions, not the names below.** `src/orchestrator/runtime.test.ts` uses a `FULL` env constant with `withoutX` variants derived from it, and asserts on `runtime.warnings.join(' ')` with `toMatch`. The `envWith` / `envWithout` in the code below are my invention and do not exist — build each case the way the neighbouring tests already do.

```ts
  it('builds a notifier when the mail settings and the notify ref are all present', async () => {
    const runtime = await buildRuntime(envWith({ NOTIFY_CREDENTIAL_REF: 'NOTIFY_MAIL' }));
    expect(runtime.notify).toBeDefined();
    expect(runtime.warnings).toEqual([]);
  });

  it('warns and runs without mail when the notify ref is missing, rather than throwing', async () => {
    const runtime = await buildRuntime(envWithout('NOTIFY_CREDENTIAL_REF'));
    // The scheduler still has to expire approvals — this was already the
    // shape for a missing SMTP variable, and an unset ref is the same class.
    expect(runtime.notify).toBeUndefined();
    expect(runtime.warnings.join(' ')).toContain('NOTIFY_CREDENTIAL_REF');
  });

  it('no longer reads SMTP_PASS at all', async () => {
    const runtime = await buildRuntime(envWith({ SMTP_PASS: 'סוד-נשכח', NOTIFY_CREDENTIAL_REF: 'NOTIFY_MAIL' }));
    // Positive half first, so the negative assertion cannot pass vacuously.
    expect(runtime.notify).toBeDefined();
    expect(JSON.stringify(runtime)).not.toContain('סוד-נשכח');
  });

  it('rejects a notify ref that is not a legal credential ref', async () => {
    // `CREDENTIAL_REF_PATTERN` is uppercase, digits and underscore only, and
    // `key-check` / `key-recovery` are lowercase-with-hyphen precisely so a
    // real ref can never collide with them. A misconfigured ref must be
    // refused at startup, not at the first approval.
    await expect(buildRuntime(envWith({ NOTIFY_CREDENTIAL_REF: 'key-check' }))).rejects.toThrow();
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/orchestrator/runtime.test.ts`
Expected: FAIL — `SMTP_PASS` is still required and `NOTIFY_CREDENTIAL_REF` is unknown.

- [ ] **Step 3: Implement**

In `src/config.ts`, replace `SMTP_PASS` with `NOTIFY_CREDENTIAL_REF` in the set of variables the mail path requires, and validate the ref against `CREDENTIAL_REF_PATTERN` from `src/orchestrator/credentials.ts` — reusing that constant rather than restating the shape, so the two cannot drift.

In `buildRuntime`, build the `SmtpConfig` without `auth` (carrying `user` as plain configuration), and pass the already-built `storedCredentials(key)` plus the ref and `config.businessId` into `createEmailNotifier`.

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run src/orchestrator/runtime.test.ts src/mail/transport.test.ts src/governance/notify.test.ts`
Expected: PASS, and `npm run typecheck` clean for the first time since Task 1.

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add src/orchestrator/runtime.ts src/config.ts src/orchestrator/runtime.test.ts
git commit -m "The runtime hands the notifier a ref, and stops reading the password"
```

---

## Task 4: The operator's path, and the documentation this makes false

**Files:**
- Modify: `.env.example`
- Modify: `CLAUDE.md`
- Modify: `docs/dashboard-deployment.md`
- Test: `src/orchestrator/notify-wiring.test.ts` (existing file — extend)

- [ ] **Step 1: Write the failing test**

One end-to-end wiring assertion, in the file that already covers this path:

```ts
  it('carries a real secret from the store to the transport, for a plan-driven send', async () => {
    // The store is the source: nothing in this test sets SMTP_PASS.
    //
    // `putSecret` takes an input OBJECT and the master key — check its real
    // signature in `src/governance/credential-store.ts` before calling it. The
    // three-loose-arguments form below is wrong; it is my error, not the
    // codebase's, and the compiler will say so immediately.
    await putSecret('OFFICE_MAIL', 'סוד-מהמאגר', { businessId: BUSINESS, db: getPool() });
    const captured: string[] = [];
    // …drive a plan whose binding names OFFICE_MAIL, through runDueJobs…
    expect(captured).toEqual(['סוד-מהמאגר']);
  });
```

Build it from the existing seeding in this file rather than inventing new helpers; it already stands up a charter, a binding and a job.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/orchestrator/notify-wiring.test.ts`
Expected: FAIL before Task 1-3 land; PASS after. If it passes before, the test is not exercising the path — say so rather than accepting it.

- [ ] **Step 3: Update `.env.example`**

Remove `SMTP_PASS`. Add `NOTIFY_CREDENTIAL_REF`, and beside it the sentence an operator needs: the password is provisioned with `npm run secret` under that ref, mail does not send until it is, and the username stays here because it identifies rather than authenticates.

- [ ] **Step 4: Correct what this makes false**

Each of these is true today and false after Task 3. Open the code before rewriting each, and make the new sentence true rather than merely not-the-old-one:

1. **`CLAUDE.md`** — the paragraph stating the store is built and no adapter reads a secret value, and that wiring the mail adapter is separate, still-open work. It is now done; say what is wired and what it cost (the transport holds no default, so a caller with no credential cannot send at all).
2. **`CLAUDE.md`** — the "six SMTP variables plus `APPROVAL_NOTIFY_TO`" formulation, in both places it appears. The count and the membership both change.
3. **`docs/dashboard-deployment.md`** — wherever it tells an operator to set a mail password, it must now tell them to provision a secret.
4. **Add** to `CLAUDE.md`'s "כללים שהקוד אוכף בשקט": the transport has no default credential, and why that is the control rather than an inconvenience; and that the resolution happens per send so a rotation takes effect without a restart.

- [ ] **Step 5: Full check, then commit**

```bash
npm run typecheck
git add -A
git commit -m "Provisioning replaces a password variable, and the docs say so"
```

---

## Self-Review

**Spec coverage.** §1 (what exists) → informs Tasks 1-3, nothing to build. §2 (transport holds no secrets) → Task 1. §3 (username is configuration) → Task 1 Step 3 and Task 3. §4 (two refs) → the binding's ref needs no work, the notifier's is Task 2 + Task 3. §5 (resolve per send) → Task 1's no-caching test and Task 2's rotation test. §6 (five boundaries) → error message and serialisation in Task 1, the reported failure in Task 2, the log options in Task 1's debug/logger test; `process.env` and the thrown object are Global Constraints and belong to the security reviews, since no task adds such a path. §7 (startup and failure) → Task 3. §8 (three security-review layers) → the controller's process, not a task. §9 (out of scope) → no task touches an adapter, the binding registry, `envCredentials` or the autonomy dial. §10 invariants: 1 → Task 1 tests 1 and 3; 2 → Task 1 test 1 plus Task 2 test 1, with Task 4's end-to-end tying them; 3 → **gap, see below**; 4 → Task 1 test 4 and Task 2 test 4; 5 → Task 1 test 4's `JSON.stringify` assertion; 6 → Task 3 test 2; 7 → Global Constraints, and every negative test above is paired with a positive.

**One gap, stated rather than papered over.** Invariant 3 — the value never appears in an audit row — has no task. No task in this plan writes an audit row, and the value cannot reach one that does not exist; but "no task touches it" is not the same as "a test proves it". The controller should decide whether to add that assertion to Task 4 or leave it to the final security review, which has the whole branch in view.

**Placeholder scan.** The one deliberately incomplete fragment is Task 4 Step 1's `…drive a plan…`, which points at existing seeding in the file rather than restating forty lines of it; the task says so explicitly. Task 1 Step 1 names three helpers (`configWithoutAuth`, `aContext`, `fakeTransporter`) and tells the implementer to add a `createTransport` seam if the file lacks one — flagged rather than assumed.

**Type consistency.** `SmtpConfig` loses `auth` and gains `user: string` in Task 1, consumed with that spelling in Task 3. `createEmailNotifier`'s parameters are declared in Task 2's Interfaces block and called with the same order in Task 3. `CredentialHandle` is only ever built through `createCredentialHandle(ref, value)` — the brand makes a literal impossible — and `CredentialSource.resolve(ref, businessId)` keeps its required `businessId` at every call site.
