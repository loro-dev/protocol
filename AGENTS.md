# AGENTS.md

This file provides guidance to ai agents when working with code in this repository.

## Project Overview

Loro Protocol is a transport‑agnostic synchronization protocol for collaborative CRDTs. This monorepo contains a TypeScript implementation (protocol, WebSocket client/server, adaptors) and Rust counterparts. It supports Loro, Yjs, and other CRDT systems over WebSocket and P2P connections. An optional end‑to‑end encrypted flow for Loro documents ("%ELO") is included.

## Common Development Commands

```bash
# Install dependencies
pnpm install

# Run development watch mode
pnpm dev

# Run tests
pnpm test

# Build all packages
pnpm build

# Type checking
pnpm typecheck

# Linting
pnpm lint

# Clean build artifacts
pnpm clean
```

## Architecture

### Monorepo Structure

- **packages/loro-protocol**: Protocol types and binary encoders/decoders, bytes utilities, and `%ELO` container/crypto helpers (TypeScript). Key files: `src/{protocol,encoding,bytes,e2ee}.ts` with tests under `src/`.
- **packages/loro-websocket**: WebSocket client and a `SimpleServer` (TypeScript).
  - Features: message fragmentation/reassembly (≤256 KiB), connection‑scoped keepalive frames (`"ping"/"pong"` text), permission hooks, optional persistence hooks.
- **packages/loro-adaptors**: Adaptors that connect the WebSocket client to `loro-crdt` (`LoroAdaptor`, `LoroEphemeralAdaptor`) and `%ELO` (`EloAdaptor`).
- **examples/excalidraw-example**: React demo using `SimpleServer`; syncs a Loro doc and ephemeral presence.
- **rust/**: Rust workspace mirroring the TS packages:
  - `rust/loro-protocol`: Encoder/decoder parity with JS (snapshot tests included).
  - `rust/loro-websocket-client`: Minimal client.
  - `rust/loro-websocket-server`: Async server with workspace isolation, auth hooks, and persistence example (see `examples/simple-server.rs`).

### Protocol Overview

- **CRDT magic bytes**: `%LOR` (Loro), `%EPH` (Ephemeral), `%YJS`, `%YAW`, `%ELO` (E2EE Loro).
- **Messages**: JoinRequest/JoinResponseOk/JoinError, DocUpdate, DocUpdateFragmentHeader/Fragment, UpdateError, Leave.
- **Limits**: 256 KiB max per message; large payloads are fragmented and reassembled.
- **Keepalive**: Text frames `"ping"`/`"pong"` are connection‑scoped and bypass the envelope.
- **%ELO**: DocUpdate payload is a container of encrypted records (DeltaSpan/Snapshot). Each record has a plaintext header (peer/version metadata, `keyId`, 12‑byte IV) and AES‑GCM ciphertext (`ct||tag`). Servers route/broadcast without decrypting.

### Testing

- **TypeScript**: `vitest` across packages via `vitest.workspace.ts` (unit + e2e in `packages/loro-websocket`).
- **Rust**: `cargo test` in each crate; server/client e2e and auth tests under `rust/loro-websocket-server/tests`.

## Important Design Documents

**When implementation behavior doesn't match expectations, these documents are the source of truth:**

- `/protocol.md`: Wire protocol specification - defines message formats and syncing process
- `/protocol-e2ee.md`: End-to-end encryption protocol

These documents represent the ground truth design. If there are inconsistencies between code and these specs, follow the specifications.

# Development Guidelines

## Philosophy

### Core Beliefs

- **Incremental progress over big bangs** - Small changes that compile and pass tests
- **Learning from existing code** - Study and plan before implementing
- **Pragmatic over dogmatic** - Adapt to project reality
- **Clear intent over clever code** - Be boring and obvious

### Simplicity Means

- Single responsibility per function/class
- Avoid premature abstractions
- No clever tricks - choose the boring solution
- If you need to explain it, it's too complex
- Avoid over-engineering, don't write low-value docs/comments/tests. They'll increase the maintenance cost and make code review harder.
- Your changes should be easy to review. Please address the part that you want human to focus on by adding `TODO: REVIEW [reason]`.
- Don't test obvious things.

## Process

### 1. Planning & Staging

Break complex work into 3-5 stages. Document in `IMPLEMENTATION_PLAN.md`:

```markdown
## Stage N: [Name]

**Goal**: [Specific deliverable]
**Success Criteria**: [Testable outcomes]
**Tests**: [Specific test cases]
**Status**: [Not Started|In Progress|Complete]
```

- Update status as you progress
- Remove file when all stages are done

### 2. Implementation Flow

1. **Understand** - Study existing patterns in codebase
2. **Test** - Write test first (red)
3. **Implement** - Minimal code to pass (green)
4. **Refactor** - Clean up with tests passing
5. **Commit** - With clear message linking to plan

### 3. When Stuck (After 3 Attempts)

**CRITICAL**: Maximum 3 attempts per issue, then STOP.

1. **Document what failed**:
   - What you tried
   - Specific error messages
   - Why you think it failed

2. **Research alternatives**:
   - Find 2-3 similar implementations
   - Note different approaches used

3. **Question fundamentals**:
   - Is this the right abstraction level?
   - Can this be split into smaller problems?
   - Is there a simpler approach entirely?

4. **Try different angle**:
   - Different library/framework feature?
   - Different architectural pattern?
   - Remove abstraction instead of adding?

## Technical Standards

### Architecture Principles

- **Composition over inheritance** - Use dependency injection
- **Interfaces over singletons** - Enable testing and flexibility
- **Explicit over implicit** - Clear data flow and dependencies
- **Test-driven when possible** - Never disable tests, fix them

### Code Quality

- **Every commit must**:
  - Compile successfully
  - Pass all existing tests
  - Include tests for new functionality
  - Follow project formatting/linting

- **Before committing**:
  - Run formatters/linters
  - Self-review changes
  - Ensure commit message explains "why"

### Error Handling

- Fail fast with descriptive messages
- Include context for debugging
- Handle errors at appropriate level
- Never silently swallow exceptions

## Decision Framework

When multiple valid approaches exist, choose based on:

1. **Testability** - Can I easily test this?
2. **Readability** - Will someone understand this in 6 months?
3. **Consistency** - Does this match project patterns?
4. **Simplicity** - Is this the simplest solution that works?
5. **Reversibility** - How hard to change later?

## Project Integration

### Learning the Codebase

- Find 3 similar features/components
- Identify common patterns and conventions
- Use same libraries/utilities when possible
- Follow existing test patterns

### Tooling

- Use project's existing build system
- Use project's test framework
- Use project's formatter/linter settings
- Don't introduce new tools without strong justification

## Quality Gates

### Definition of Done

- [ ] Tests written and passing
- [ ] Code follows project conventions
- [ ] No linter/formatter warnings
- [ ] Commit messages are clear
- [ ] Implementation matches plan
- [ ] No TODOs without issue numbers

### Test Guidelines

- Test behavior, not implementation
- One assertion per test when possible
- Clear test names describing scenario
- Use existing test utilities/helpers
- Tests should be deterministic

## Important Reminders

**NEVER**:

- Use `--no-verify` to bypass commit hooks
- Disable tests instead of fixing them
- Commit code that doesn't compile
- Make assumptions - verify with existing code

**ALWAYS**:

- Commit working code incrementally
- Update plan documentation as you go
- Learn from existing implementations
- Stop after 3 failed attempts and reassess
