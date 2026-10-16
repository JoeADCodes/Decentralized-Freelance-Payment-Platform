# Contributing

Thanks for your interest in contributing. This document explains how the project
is structured, how to get a working environment, and the conventions to follow.

---

## What this project is

A decentralized freelance payment platform on Stellar. Clients fund a
milestone-based escrow in a Stellar Asset Contract (USDC in production); the
freelancer is paid as milestones are approved. Disputes are resolved by an
arbitrator, and both parties rate each other on-chain afterwards.

Three Soroban contracts (Rust → Wasm) plus a React frontend and an Express
backend. **Everything is testnet-only — never use real funds.**

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Rust + Cargo | stable ≥ 1.91 | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| Stellar CLI | ≥ 25.2.0 (v28 current) | https://github.com/stellar/stellar-cli/releases |
| Node.js | ≥ 20 | https://nodejs.org |
| Docker + Compose | optional, for the one-command stack | https://docs.docker.com/get-docker |

You do **not** need to add the wasm target by hand: `contracts/rust-toolchain.toml`
declares `wasm32v1-none` plus the `rustfmt`/`clippy` components, and rustup
installs them on first use.

> **Why `wasm32v1-none` and not `wasm32-unknown-unknown`?** Soroban SDK v28+
> refuses the old target and requires building with `stellar contract build`
> (which sets a build-system flag the SDK checks). See `docs/TESTNET.md`.

---

## Quick start

### Option A — one command (Docker)

```bash
docker compose up --build
```

- API: http://localhost:3000 (health at `/health`)
- Frontend: http://localhost:5173

This starts PostgreSQL, applies the committed Prisma migrations, boots the API,
and serves the built frontend. To point the frontend at deployed contracts, pass
the addresses (see `deployments/testnet.json`):

```bash
VITE_ESCROW_CONTRACT_ID=C... VITE_DISPUTE_CONTRACT_ID=C... \
VITE_REPUTATION_CONTRACT_ID=C... VITE_USDC_CONTRACT_ID=C... \
docker compose up --build
```

### Option B — manual

```bash
# Contracts
cd contracts
cargo test
stellar contract build        # wasm lands in target/wasm32v1-none/release/

# Frontend
cd ../frontend
npm install
cp .env.example .env          # fill in contract IDs (or run scripts/deploy_testnet.sh)
npm run dev                   # http://localhost:5173

# Backend (needs PostgreSQL)
cd ../backend
npm install
cp .env.example .env          # DATABASE_URL, JWT_SECRET (≥32 chars), RPC URLs
npx prisma migrate deploy
npm run dev
```

### Deploy to testnet

```bash
rustup target add wasm32v1-none
stellar keys generate deployer --network testnet --fund
scripts/deploy_testnet.sh     # deploys + initializes all three contracts
scripts/demo_testnet.sh       # create → fund → release → rate
```

---

## Repository layout

```
contracts/
  interface/     # shared types + cross-contract client (plain rlib, no exports)
  escrow/        # funds, milestone state machine, expiry refunds
  dispute/       # arbitration; calls back into escrow
  reputation/    # immutable 1–5 star ratings
frontend/        # React 18 + TypeScript + Vite
backend/         # Express + Prisma + Zod
scripts/         # testnet deploy + demo
deployments/     # deployed contract IDs (testnet)
docs/            # testnet notes; wave-issues/ = design notes for issues #2-#18
```

---

## Architecture

Three contracts interact. `escrow` holds the funds; `dispute` can only change
them through a call that `escrow` has authorized; `reputation` reads escrow
state to verify a job really completed.

```
        create / fund / release_milestone / reclaim_expired
Client ───────────────────────────────────────────────► EscrowContract
   ▲                                                         │  ▲
   │ reward / refund                                         │  │ resolve(client_share,
   │                                                         │  │         freelancer_share)
   │                    open_dispute (either party)          │  │ (only the registered
Freelancer ──────────────────────────────────────────────────┘  │  dispute contract may call)
   ▲                                                              │
   │                                    raise() ── verify ──────►│  (escrow must be Disputed;
   │                                              ── cross-call ──┘   caller must be a party)
DisputeContract ◄── approve()* ── Arbitrator panel
                      arbitrate() (needs M-of-N approvals)

Client / Freelancer ── submit(rater, ratee, escrow_id, score) ── verify completed + participants ──► ReputationContract
```

State machine (escrow):

```
Created ──fund──► Active ──release all──► Completed
                    │
                    ├──open_dispute──► Disputed ──resolve──► Completed
                    │                     └──(past dispute deadline)──► Refunded
                    └──(past expiry)──► Refunded
```

Details of the dispute panel and timelock are in
[`docs/DISPUTES.md`](./docs/DISPUTES.md).

### Contract reference

| Contract | Function | Notes |
|----------|----------|-------|
| escrow | `init(admin, dispute_contract)` | one-time; admin can rotate the dispute contract |
| escrow | `set_dispute_contract(dispute_contract)` | admin-only; rotates the dispute contract |
| escrow | `create(client, freelancer, token, milestones, expiry)` | validates amounts/expiry; returns id |
| escrow | `update_milestones(escrow_id, milestones)` | client-only, while still `Created` (before funding); re-validates and recomputes the total |
| escrow | `fund(escrow_id)` | client deposits the total |
| escrow | `release_milestone(escrow_id, milestone_index)` | client-only; completes the job on the last one |
| escrow | `release_partial(escrow_id, milestone_index, amount)` | client-only; pays part of a milestone and tracks `released_amount` |
| escrow | `open_dispute(escrow_id, initiator)` | either party; freezes the escrow and starts the dispute timelock |
| escrow | `resolve(escrow_id, client_share, freelancer_share)` | **dispute contract only**; shares must sum to the funds held |
| escrow | `reclaim_expired(escrow_id)` | client-only refund of the unreleased remainder after expiry; earlier releases are not clawed back |
| escrow | `reclaim_after_dispute_timeout(escrow_id)` | client refund from `Disputed` once the dispute deadline passes |
| escrow | `get(escrow_id)` / `dispute_contract()` / `dispute_deadline(escrow_id)` | views |
| dispute | `init(arbitrators, threshold)` | one-time; every panel member authorizes |
| dispute | `raise(escrow_id, escrow_contract, raised_by, reason)` | verifies escrow is Disputed and caller is a party |
| dispute | `approve(dispute_id, arbitrator, client_share, freelancer_share)` | panel-only; records an approval of a specific split |
| dispute | `arbitrate(dispute_id, client_share, freelancer_share)` | needs `threshold` matching approvals; cross-calls `escrow.resolve` |
| dispute | `get` / `dispute_for` / `arbitrators` / `threshold` | views |
| reputation | `init(admin, escrow_contract)` | one-time |
| reputation | `submit(rater, ratee, escrow_id, score)` | verified against escrow; 1–5 |
| reputation | `get_aggregate(address)` / `get_rating(rater, escrow_id)` | views; aggregate is amount-weighted (see `docs/REPUTATION.md`) |

The code is canonical: `contracts/*/src/lib.rs` is the source of truth for this
table and for the one in `README.md`. If a table and the code disagree, trust the
code and update the table — the PR checklist asks every PR to re-verify both
copies against the contract source.

All fallible functions return a typed `Result<_, _Error>` (see the `interface`
crate for `EscrowError`). **No `assert!`/`unwrap` in production paths.**

All contracts extend storage TTL on read and write so live state never archives
unexpectedly, and emit `#[contractevent]` events for the indexer.

### Why an `interface` crate?

`dispute` and `reputation` need to call/read `escrow`. Depending on the escrow
*crate* directly makes the wasm linker fail (`symbol multiply defined`, because
each contract crate exports ABI entry points). `interface` is a plain `rlib`
holding shared types and a `#[contractclient]` trait, so contracts depend on it
without exporting one another's symbols. Contract crates are pulled in only as
**dev-dependencies** for tests.

---

## Testing

```bash
# Contracts: 86 tests — every state transition and failure path + 3 integration
cd contracts
cargo test
cargo test -p escrow                    # one contract
cargo test -p dispute --test full_flow  # cross-contract integration test

# Frontend
cd frontend
npm run lint
npx tsc --noEmit

# Backend (ESLint + typecheck)
cd ../backend
npm run lint
npx tsc --noEmit
```

Cross-contract tests live in `contracts/dispute/tests/full_flow.rs` and deploy
real instances of all three contracts in the Soroban test environment. Every new
contract function must ship with tests for both its success and failure paths.

### Before opening a PR

```bash
cd contracts && cargo fmt --all && cargo clippy --all-targets -- -D warnings && cargo test
cd ../frontend && npm run lint && npx tsc --noEmit && npm test && npm run build
cd ../backend && npx prisma generate && npm run lint && npx tsc --noEmit && npm test
```

That is exactly what CI runs. The test steps are not optional: the frontend
suite no longer passes `--passWithNoTests`, so a broken or emptied suite fails
the build instead of reporting success on nothing.

---

## Conventions

- **Checks-Effects-Interactions:** validate state, write storage, then transfer
  tokens. Never transfer before recording the state change.
- **Typed errors, not panics:** return `Result<_, ContractError>` from every
  fallible function; reserve panics for authorization failures.
- **TTL:** extend storage TTL whenever you read or write a persistent entry.
- **Events:** emit a `#[contractevent]` for every state change so the indexer
  can follow the chain.
- **Typed ScVal arguments:** build contract-call arguments with the helpers in
  `backend/src/lib/scval.ts` (`scAddress`/`scU32`/`scU64`/`scI128`), never a bare
  `nativeToScVal(value)` — the SDK infers `u64`/`i64` for a plain number or
  bigint, and Soroban rejects a mismatched argument type before the function
  body runs. Mirrors `frontend/src/lib/stellar.ts`.
- **One PR per concern:** keep contract changes and frontend changes separate
  where practical.
- Keep contract interfaces small and explicit — add a new function rather than
  overloading an existing one.

### Branches and commits

- Branch from `main`: `feat/short-description`, `fix/short-description`,
  `docs/short-description`.
- Small, focused commits with imperative messages
  (`feat(escrow): reject zero-amount milestones`).
- Open a PR against `main`; fill in the PR template and link the issue.
- CI must be green before review.

---

## How issues map to Wave complexity

Issues are labelled by the effort a single contributor needs (one week or less).
When picking up an issue, keep the change inside that band — split anything
larger into a new issue instead of growing the PR.

| Level | Scope | Examples |
|-------|-------|----------|
| **Trivial** | Docs, test coverage for existing behaviour, input-validation messages, small UI polish, error handling. No interface changes. | Add a unit test for a failure path; improve a validation message |
| **Medium** | One focused feature touching one or two files, with tests. May add a contract function. | Milestone editing before funding; partial release; event emission for indexing |
| **High** | Cross-cutting change across contracts and/or backend, or a design decision that needs care. | Multi-arbitrator / timelocked disputes; supporting assets beyond USDC; backend event indexer |

Anything that would need a security audit to merge safely should be raised as a
design issue first rather than a ready-to-merge task.

Scoped work lives in the [issue tracker](https://github.com/vatal-system/Decentralized-Freelance-Payment-Platform/issues);
the design notes behind issues #2-#18 live in
[`docs/wave-issues/`](./docs/wave-issues/).

---

## Dependency security

Three lockfiles are committed (`backend/package-lock.json`,
`frontend/package-lock.json`, `contracts/Cargo.lock`), so a version only moves
when something bumps it. Version updates are **manual** — Dependabot is
intentionally not configured (`.github/dependabot.yml` was removed) — so a bump
happens when someone runs `npm audit fix` / `cargo update` or lands a PR that
changes a manifest. One mechanism guards that:

- **The `Dependencies – vulnerability scan` job** runs
  `npm audit --audit-level=high --omit=dev` for both packages and
  `cargo audit` for the contracts on every push and PR.

**The scan is advisory today, not blocking.** Both lockfiles carry known
high/critical advisories that need a dependency bump, not a CI change, so the
steps use `continue-on-error: true`: the report is visible in the run (and in the
check's annotations) without failing every unrelated PR. Make it blocking —
delete `continue-on-error` — once `npm audit --audit-level=high --omit=dev` and
`cargo audit` are both clean.

`--omit=dev` deliberately audits only what ships. Build/test tooling (vite,
vitest, eslint, tsx) is not scanned there because it never runs in production;
`cargo audit` does cover the workspace's dev-dependencies, because the contract
tests compile the same crates the wasm build does.

Handling a new advisory:

1. Prefer a bump: `npm audit fix` for a non-breaking fix, or a small PR that
   changes the manifest and the lockfile together.
2. If the finding is in a production dependency, treat it as a bug rather than
   noise — the backend verifies wallet signatures and holds JWTs, so a parsing or
   network flaw in one of its dependencies is reachable from the internet.
3. Only after 1 and 2 have been tried, and only with a link to the upstream
   advisory plus a tracking issue, pin or override the affected version.
4. Never silence a finding by removing the step or lowering `--audit-level` in a
   pull request.

---

## Security

Read [`SECURITY.md`](./SECURITY.md) before reporting a vulnerability. The
contracts are unaudited and testnet-only; do not deploy to mainnet or move real
funds. Never commit secrets — Freighter signs in the browser, and `stellar-cli`
keeps testnet keys outside the repo.
