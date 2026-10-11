# Natalis — rules for anyone building here

**Principle.** The model is the mind and the compute; the host is the body (storage, CPU, network). An entity
must get better when a better model is swapped in, with no code change. Before adding any rule to the body, ask:
would a better model make this rule unnecessary? If yes, it is judgment and belongs to the mind (a tool it can
call, a fact it can see), not to code. Second test: can the mind notice and correct this from inside? If not, the
body owes it: a gate, a meter or a record, never a judgment about what the Lar should do.

The body keeps only: storage and backups, identity continuity, secrets by reference, the creator's privacy list
and stop and forget, the irreversible-act gate, the loop ceiling, the floor duties (AI disclosure, crisis help,
export and delete), and a model-neutral tool protocol. Everything else is the entity's own judgment.

## Code

- TypeScript, strict, ES modules, Node >= 22.13. Storage uses `node:sqlite` and plain files. No other runtime
  dependencies without a reason written in the commit.
- Build against `src/contracts.ts`. Change a contract only on purpose, and say so in the commit.
- Every module gets focused tests beside it (`*.test.ts`, vitest). Tests never use the network, never need a
  real model key, and pass on Windows and Linux (use `path`, temp dirs, no shell-specific commands).
- Fail loudly. A malformed model reply, a refused tool call or a lost event is recorded and shown, never
  silently defaulted.
- Write receipts and messages the entity reads in plain, short English.

## Keeping the repository safe to publish

This repository is private until its owner publishes it, and it must be safe to publish at any time. Never commit
keys, tokens, passwords, platform ids, hostnames, IP addresses or anyone's private data. Test fixtures use invented people
and places. Never write token-shaped literals in tests; build them from parts at runtime.

## Verify

```
npm run typecheck
npm test
```
