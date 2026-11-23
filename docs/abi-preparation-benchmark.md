# Repeated row ABI preparation

The cache improves repeated overrides in the focused benchmark, including actual
Piscina messages. It is workload dependent: batches with a new ABI on every task
are slower. Single-row tasks and live ABI instances retain the original path.

Baseline: Piscina parent `963b3af1785593608d35dce8a8fdf07728129a76`, not the main
branch or the former worker pool. Both variants use the same locked dependencies
(@wharfkit/antelope 1.2.0, Piscina 5.3.2), CommonJS and Node 24.18.0. Measurements
were sequential on Windows / Docker Desktop, Ryzen 7 9800X3D, with the shared
exclusive host lock held. No sibling benchmark overlapped these samples.

## What is cached

`ABI.from(instance)` already returns the existing instance; constructing an ABI
from a plain definition is also cheap. The repeated work is `ABI.resolveType()`.
The cache retains detached decoding definitions (`types`, `structs`, `variants`)
and their resolved types. Exact deep contents comparison survives structured
cloning and distinguishes historical revisions without account/revision metadata
or hashing/stringifying every row. Other ABI properties do not participate in
type resolution.

Each batch starts a fresh identity lookup. Only the second use of an override
attempts content lookup/preparation; singletons avoid that cost. Limits are 32
batch identities, 32 retained ABI definitions (LRU), and 64 resolved types per
definition (FIFO). Caller ABIs are not modified. Exceptions/results are not
cached; definitions that cannot be detached faithfully use the existing path.
SHIP ABI initialization and the pool/reconnect lifecycle are unchanged.

## Focused measurement

Nine fresh-process repetitions per variant/scenario, alternating order. Each
process warms 100 batches before timing. Batched cases measure 400 batches of 100
rows; singleton cases measure 3,000 one-row batches. Timings include identical
fixture cloning, batch construction and result assertions, and exclude module
loading/worker bootstrap. The representative definition has 80 structs, an alias,
name/uint64/float64 fields and an integer array; the tiny definition is one uint8.
The worker case uses one real Piscina worker and separately cloned messages.

Elapsed milliseconds, median [minimum, maximum]; lower is better:

| Scenario | Parent | Candidate | Median change |
| --- | ---: | ---: | ---: |
| Repeated plain override, 100 rows | 316.30 [275.40, 361.00] | 277.90 [246.77, 323.81] | -12.14% |
| Repeated tiny override, 100 rows | 86.72 [80.46, 90.69] | 75.69 [71.97, 79.98] | -12.72% |
| Same ABI contents, one row | 441.24 [415.90, 490.80] | 446.15 [428.20, 491.31] | +1.11% |
| New ABI each task, one row | 444.37 [421.54, 508.94] | 443.70 [409.38, 466.02] | -0.15% |
| New ABI each task, 100 rows | 294.46 [269.13, 326.74] | 368.83 [331.34, 388.15] | +25.26% |
| Live ABI instance control, 100 rows | 223.72 [210.99, 231.19] | 223.05 [213.84, 254.63] | -0.30% |
| Repeated override through worker, 100 rows | 456.92 [445.58, 476.20] | 422.63 [414.84, 441.45] | -7.51% |

Singleton/instance differences are small relative to dispersion. The miss-heavy
batched regression is material; this is not a general speedup for arbitrary ABI
traffic. An initial eager version regressed single-row tasks and was replaced by
preparation only on reuse before these final samples.

Reproduce in this measurement worktree using Git Bash. The focused helper,
snapshots, replay helpers and raw results are local ignored artifacts; only this
report is committed. The helper alternates variants across nine subprocesses per
scenario, using the fixtures, batch sizes and warmup described above.

```sh
pnpm install --frozen-lockfile
mkdir -p node_modules/.cache/abi-parent
git archive 963b3af1785593608d35dce8a8fdf07728129a76 |
    tar -xf - -C node_modules/.cache/abi-parent
pnpm exec tsc -p node_modules/.cache/abi-parent/tsconfig.json
pnpm run build
node node_modules/.cache/abi-benchmark/focused.cjs node_modules/.cache/abi-parent/dist
```

## API replay

Pinned API PR250 head `81a9fe22d1a8771e57076c0d08e57e29b96173d9`, rebuilt from
unmodified source with Node 24.18.0. Range `[64104000,64114000)`, ten workers,
atomicassets/delphioracle/atomicmarket/atomictools handlers, `db_group_blocks=100`,
`ship_prefetch_blocks=500`, `ship_ds_queue_size=20`. Each run has a fresh isolated
local database and empty dedicated Redis. Order: parent, candidate, candidate,
parent, parent, candidate. Three runs per variant, no concurrent timing.

Elapsed seconds (three samples per variant):

| Metric | Parent | Candidate |
| --- | ---: | ---: |
| Samples | 5.761, 4.600, 4.373 | 4.888, 4.624, 4.573 |
| Mean / population SD | 4.912 / 0.608 | 4.695 / 0.138 |
| Median | 4.600 | 4.624 |
| Mean CPU seconds | 19.812 | 19.054 |
| Mean maximum RSS MiB | 912.0 | 942.3 |

Mean elapsed is 4.41% lower (4.62% higher throughput); median elapsed is 0.52%
higher. With only three samples and the wide parent dispersion, the API speed
result is **inconclusive**. The focused repeated-worker result is stronger
evidence for that specific workload. No memory improvement is demonstrated.

All six runs processed exactly 10,000 contiguous blocks, 40,000 tasks and 173,868
task rows, with zero processing/task errors and the same three warning messages.
All 55 normalized table checksums and schema versions matched. Normalization
excludes operational `dbinfo` timestamps (schema version checked separately),
aggregates asset counters by business key excluding all-zero groups, excludes
generated sales-filter queue sequence numbers, and excludes the reader's runtime
`updated` timestamp. Business data and pending-work keys/priority remain checked.

All receivers reached committed block 64113999. The existing persisted periodic
reader checkpoint was 64113699 (`1593486088500`, not live) in every run; it was
not advanced artificially for the comparison.

The configured RPC responds from Windows but times out directly from Docker.
Both variants therefore use identical raw TCP relays through
`host.docker.internal`, preserving original RPC/SHIP destinations and paths.
This adds a network timing limitation. Timing starts at first received block and
ends at the final committed block in the receiver, excluding schema initialization
and worker bootstrap.

Helpers/raw samples/logs remain ignored under `node_modules/.cache/abi-benchmark`
and `node_modules/.cache/abi-replay`. The copied replay helper was audited to use
the parent Piscina build, unique Docker labels/names/images/network/volume and
ports, and Redis's own CLI. No shared database was reset.

Cleanup removed this task's eight containers (including attached anonymous
volumes), one named volume, one network and three image tags/images. Subsequent
label-filtered inventories were empty; both relay listeners and the owned lock
were gone. The first setup attempt failed before timing on the copied helper's
Valkey CLI command, cleaned its resources, and was corrected to use `redis-cli`
before the six successful runs. No failed run is included in the samples.

## Validation

Node 22.14.0 and Node 24.18.0 each passed 186 Mocha tests, zero skipped/failed,
including local WebSocket integration, compiled worker and CommonJS subprocess
exit tests. Each also passed build, typecheck, lint, knip and all six release-notes
shell tests. The new tests cover revisions, aliases/variants, different schemas,
mutable definitions, detached old contents, both eviction bounds, malformed ABI
errors/retries, JSON/instance overrides and measured resolution reuse inside the
shipped worker across distinct messages.

A final rerun exposed an existing waiting-count test's scheduling assumption:
several task finalizers can execute before a caller's callback. Its assertion now
checks the valid remaining range, with the initial/final counts still checked;
pool accounting code is unchanged. Both complete matrices were rerun afterward.

Commands, with PATH selecting each Node version (confirmed using `pnpm exec node --version`):

```sh
pnpm run check-types
pnpm run lint
pnpm run build
pnpm exec c8 mocha "src/**/*.test.ts" --reporter dot --no-color
pnpm run knip
bash scripts/release-notes.test.sh
```

The direct Mocha command avoids the package script's quoted-glob problem on
Windows. Remote Ubuntu/GitHub checks are separate from these local results.
