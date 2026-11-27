These are hand-authored, synthetic conversations, not recorded meetings. No raw audio or real personal data is included.

`conversations.json` is replayed by `../cue-engine.test.mjs` using the real cue engine and an injected clock:

- `at` is the local receipt/clock time in milliseconds.
- `startMs`/`endMs` are ASR audio-timeline positions, distinct from local time. The harness defaults `startMs` to `at` for these point-in-time examples.
- `isFinal` defaults to true. An omitted `speaker` is intentionally unknown.
- `shows`, `retracts`, and `commitments` are independent expected annotations. Commitment strings must match verbatim. With multiple clauses, each recognized undertaking uses its own exact source clause and date, rather than borrowing text or dates from neighboring clauses. A single-clause quote retains its original surrounding whitespace.
- Profiles, wearer identity, and speaker focus are optional scenario controls. A missing `lang` selects English; one fixture exercises basic Japanese.

Run from the repository root:

```sh
node --test even/src/fieldglass/cue-engine.test.mjs
```

The test file also exercises clock boundaries, EOU settlement, transcript corrections, stale/out-of-order results, scoped resolutions, persistent ratings, and reset/privacy behavior. No provider, microphone, server, disk-backed store, or live connector is used. Passing these cases is a deterministic regression check, not a measurement of real-world usefulness, coverage, diarization quality, or speech-to-lens latency.

Fix round 1 adds five replays (17 total): personal/scheduling side talk, a named owner answering a question, contractions across unrelated blockers, temporal availability versus accepting a task, and incidental Japanese dates versus a deadline answer. The test file checks intermediate retractions as well as final replay totals, so a premature resolution cannot hide behind the later correct answer. It also covers question marks and question words, common English/Japanese undertakings, clause-local dates, owner wording variants, and short topic heroes with a grid-width fallback.

Fix round 2 adds three replays (20 total): today/tomorrow/next-week availability versus accepting ownership, incidental relative dates versus setting a deadline, and calendar words versus explicit human owners. Unit tests also verify that removing stop words alone cannot authorize an owner resolution, that a commitment can retain a relative due date without interpreting incidental speech as a deadline, and that full names such as June Park remain valid while bare calendar words are treated as ambiguous.
