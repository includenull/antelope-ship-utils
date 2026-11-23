# Hex decoding allocation experiment

The candidate removes only `Uint8Array.from(...)` around the fresh
`Buffer.from(data, 'hex')` in `deserializeEosioType`. Both variants retain
Piscina. The parent is `963b3af1785593608d35dce8a8fdf07728129a76`, rather than
the pre-Piscina release. No ABI caching is included.

Installed WharfKit 1.2.0 accepts `ArrayBufferView` in `Bytes.from` and constructs
its decoder's `DataView` with the supplied byte offset and length. Keeping
Node's hex conversion preserves its odd-nibble truncation and invalid-pair
behavior. The Buffer is newly allocated from the string; binary inputs keep
their existing ownership semantics.

## Focused benchmark

`scripts/benchmark-hex.cjs` measures the complete public decoding function,
including ABI resolution and conversion to plain JavaScript values. Each
sample runs in a fresh process, checks its result, warms up 5,000 decodes and
then times 100,000 small decodes or 10,000 large decodes. The struct contains
a name, float64, uint64 and memo. The small memo is seven bytes; the large
memo is 16 KiB. An unchanged binary-input case is the control. There are ten
repetitions per variant and scenario, alternating parent-first and
candidate-first order. Setup and encoding are excluded from the timer.

To reproduce in Git Bash from this checkout, build the parent in an ignored
directory without changing branches, then run the same script against both
compiled CommonJS entries:

```sh
pnpm install --frozen-lockfile
mkdir -p node_modules/.cache/hex-parent
git archive 963b3af1785593608d35dce8a8fdf07728129a76 |
  tar -x -C node_modules/.cache/hex-parent
pnpm exec tsc -p node_modules/.cache/hex-parent/tsconfig.json
pnpm run build
node scripts/benchmark-hex.cjs node_modules/.cache/hex-parent/dist dist 10
```

Use the selected Node executable for the last command. Coordinate CPU timing
with an atomic, exclusively created host-local lock. These runs used
`C:/Users/bluso/AppData/Local/Temp/ship-utils-optimization-replay.lock`, with an
owner token and PID and release restricted to the owner. All benchmark
artifacts other than this script and report stay under ignored
`node_modules/.cache/hex-benchmark`.

Measured on 2026-11-23 on Windows, AMD Ryzen 7 9800X3D, 16 logical CPUs.
Times below are milliseconds per timed sample, shown as **median [Q1, Q3]**.
The small payload is 32 bytes; the large payload is 16,411 bytes.

| Node    | Input                        |                  Parent |               Candidate | Median time reduction |
| ------- | ---------------------------- | ----------------------: | ----------------------: | --------------------: |
| 22.14.0 | Small hex, 100k decodes      | 398.51 [396.19, 404.34] | 381.82 [377.68, 390.59] |                 4.19% |
| 22.14.0 | Large hex, 10k decodes       | 316.05 [303.51, 324.42] | 280.36 [267.46, 282.70] |                11.29% |
| 22.14.0 | Binary control, 100k decodes | 357.67 [353.09, 374.71] | 352.79 [335.71, 359.40] |                 1.37% |
| 24.18.0 | Small hex, 100k decodes      | 384.13 [370.64, 389.21] | 368.15 [357.93, 403.58] |                 4.16% |
| 24.18.0 | Large hex, 10k decodes       | 182.56 [180.06, 192.08] | 151.30 [146.29, 152.23] |                17.12% |
| 24.18.0 | Binary control, 100k decodes | 330.00 [326.90, 339.67] | 336.83 [334.77, 343.23] |                -2.07% |

The removed copy helps the isolated hex path, most clearly for large input.
Small-input improvement is modest and the Node 24 small-input IQRs overlap.
The binary path is unchanged; its variation indicates background timing noise.
The initial Node 24 timing was excluded because its start overlapped the end
of local validation. The reported Node 24 sample is a clean repeat after the
API runs, under the same exclusive lock, with no builds or tests overlapping.

## API replay method

The API source is pinned to
`81a9fe22d1a8771e57076c0d08e57e29b96173d9`
([API PR #250](https://github.com/atomicassets/atomicassets-api/pull/250)).
Build its unmodified Dockerfile with `NODE_VERSION=24.18.0`, then overlay each
complete library `dist` with the same manifest and frozen production
dependencies into separate images. No consumer source is edited.

Request WAX blocks **[64,104,000, 64,114,000)** with all four handlers
(AtomicAssets, DelphiOracle, AtomicMarket and AtomicTools), ten workers,
`db_group_blocks=100`, `ship_prefetch_blocks=500`, `ship_ds_queue_size=20`.
Use PostgreSQL 16 Alpine and Valkey 8 in a dedicated network, with no database
ports exposed to the host. Each run initializes a fresh database and clears only the dedicated
Valkey. Run order is parent, candidate, candidate, parent, repeated twice.
Containers, images, network and volume use task `ship-hex-473aab7f`.

The original RPC was reachable from Windows but timed out from Docker. The
initial network-failed attempt is excluded. Successful replays use host-local
raw TCP relays for RPC and SHIP, listening on loopback ports 18883 and 18884;
the containers connect through `host.docker.internal`. The same relay, source
node, configuration and container image base serve both variants. The relay
preserves the TCP byte stream and backpressure and performs no decoding. It
adds network overhead and limits generalization to a direct deployment.

Identical observational hooks time from the first receiver `consume()` call
through the final block's processing and commit. Image builds, schema and
handler startup are excluded, as is the initial block's deserialization
before that first consume call. Check consecutive block processing, task
errors, committed-block position, durable reader checkpoint and all indexed
table hashes. As in the parent experiment, omit `contract_readers.updated`,
compare asset counters by logical sums across dirty/aggregated rows, and
exclude `dbinfo` migration timestamps while comparing its schema version.
Keep raw logs and table hashes locally. Stop and remove only task-labelled
containers, including anonymous volumes, then remove the task's named volume,
network and image tags and release only its own lock.

## API replay results

Four repetitions per variant completed. Each submitted 40,000 tasks containing
173,868 rows and committed 10,000 consecutive blocks through 64,113,999.

| Measurement                                |    Piscina parent |         Candidate |
| ------------------------------------------ | ----------------: | ----------------: |
| Run 1 elapsed                              |         5.16916 s |         4.61880 s |
| Run 2 elapsed, reversed order              |         4.92333 s |         5.33286 s |
| Run 3 elapsed                              |         4.63806 s |         4.45469 s |
| Run 4 elapsed, reversed order              |         4.91025 s |         4.91752 s |
| Mean elapsed                               |         4.91020 s |         4.83097 s |
| Median elapsed                             |         4.91679 s |         4.76816 s |
| Elapsed range                              | 4.63806–5.16916 s | 4.45469–5.33286 s |
| Elapsed standard deviation (population)    |         0.18794 s |         0.33391 s |
| Throughput from mean elapsed               | 2,036.58 blocks/s | 2,069.98 blocks/s |
| Mean worker-process CPU, including threads |         20.1223 s |         19.1989 s |
| Mean peak process RSS                      |        944.83 MiB |        910.76 MiB |

Mean elapsed was **1.61% lower**, corresponding to **1.64% higher throughput**.
The 79 ms mean difference is small relative to dispersion, and the candidate
lost one pair and was effectively tied in another. This is **inconclusive for
an end-to-end speed improvement**. The focused large-input gain does not
translate into a demonstrated practical replay gain in this sample.

All eight runs matched across **55 normalized tables**, with the same schema
version `2.0.13`, 19 populated tables and 100 indexed assets. There were no
processing errors, task errors, warnings or block discontinuities. Every
durable checkpoint was 64,113,699; the existing periodic checkpoint policy
lags the final committed batch identically in both variants.

Only four runs per variant, a short early-contract range, live source/cache
effects, the relay and ordinary host noise limit interpretation. A busy modern
mint/drop range was not measured. No deployment-wide speed or memory reduction
is claimed. This experiment does not compare worker pools.

## Validation and cleanup

Both Node **22.14.0** and **24.18.0** passed, after the final source/test edits:

- `pnpm run build`
- `pnpm run check-types`
- `pnpm run lint`
- `pnpm run knip`
- `pnpm exec c8 mocha "src/**/*.test.ts" --reporter dot --no-color`:
  **179 passing, 0 failures, 0 skipped/pending** on each version.
- `bash scripts/release-notes.test.sh`: **6/6 passing** on each version, using
  `C:/Program Files/Git/bin/bash.exe`.

`pnpm install --frozen-lockfile` and `git diff --check` also passed. Node 22 was
selected by prepending `C:/Users/bluso/AppData/Local/nvm/v22.14.0` to PATH.
The full Mocha suite includes local SHIP websocket integration, packaging,
compiled CommonJS worker execution, natural process exit, ABI overrides,
fallback/reconnect behavior, numeric floats and little-endian names. New cases
cover hex/binary equivalence, offset Buffer views and ownership, odd/malformed/
truncated hex behavior, floats and hex overrides in compiled workers.

On Windows, the existing `pnpm test` single-quoted glob does not expand. The
equivalent direct command above runs the complete suite. There is no separate
integration/e2e command in this repository. Hosted CI must still pass at the
feature head; local success and replay results do not replace that gate.

Cleanup verified no task-labelled containers, volumes, networks or images
remained: ten replay/service containers, anonymous volumes, the dedicated
PostgreSQL volume, network and three image tags were removed. Both loopback
relay listeners were stopped and the owned timing lock was released. No shared
database, image, network, sibling worktree or parent branch was changed.
