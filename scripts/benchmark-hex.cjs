// Compare compiled Piscina parent/candidate builds in fresh processes, alternating order.
// node scripts/benchmark-hex.cjs <parent-dist> <candidate-dist> [repetitions=10]
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { resolve } = require('node:path');
const { performance } = require('node:perf_hooks');
const { ABI, Serializer } = require('@wharfkit/antelope');

if (process.argv[2] === '--sample') {
    const [, , , directory, scenario] = process.argv;
    const { deserializeEosioType } = require(resolve(directory));
    const abi = ABI.from({
        version: 'eosio::abi/1.1',
        structs: [
            {
                name: 'row',
                base: '',
                fields: [
                    { name: 'owner', type: 'name' },
                    { name: 'weight', type: 'float64' },
                    { name: 'serial', type: 'uint64' },
                    { name: 'memo', type: 'string' },
                ],
            },
        ],
    });
    const large = scenario === 'large-hex';
    const object = { owner: 'alice', weight: 92.13924923, serial: 42, memo: large ? 'a'.repeat(16384) : 'payment' };
    const bytes = Serializer.encode({ object, type: 'row', abi }).array;
    const data = scenario === 'binary-control' ? bytes : Buffer.from(bytes).toString('hex');
    assert.deepEqual(deserializeEosioType('row', data, abi), object);
    const iterations = large ? 10000 : 100000;
    let sum = 0;
    for (let i = 0; i < 5000; i++) sum += deserializeEosioType('row', data, abi).serial;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) sum += deserializeEosioType('row', data, abi).serial;
    const elapsedMs = performance.now() - start;
    assert.equal(sum, (5000 + iterations) * 42);
    process.stdout.write(JSON.stringify({ elapsedMs, iterations, bytes: bytes.length, node: process.version }));
} else {
    const [, , parent, candidate, repetitions = '10'] = process.argv;
    assert(parent && candidate, 'Provide parent and candidate dist directories');
    const count = Number(repetitions);
    assert(Number.isInteger(count) && count >= 4, 'At least four repetitions are required');
    const results = {};
    for (const scenario of ['small-hex', 'large-hex', 'binary-control']) {
        const samples = { parent: [], candidate: [] };
        for (let i = 0; i < count; i++) {
            for (const kind of i % 2 ? ['candidate', 'parent'] : ['parent', 'candidate']) {
                const sample = JSON.parse(
                    execFileSync(
                        process.execPath,
                        [__filename, '--sample', kind === 'parent' ? parent : candidate, scenario],
                        { encoding: 'utf8' },
                    ),
                );
                samples[kind].push(sample);
            }
        }
        const summarize = (values) => {
            const sorted = values.map((v) => v.elapsedMs).sort((a, b) => a - b);
            const quantile = (p) => {
                const index = (sorted.length - 1) * p;
                return sorted[Math.floor(index)] + (sorted[Math.ceil(index)] - sorted[Math.floor(index)]) * (index % 1);
            };
            return {
                medianMs: quantile(0.5),
                q1Ms: quantile(0.25),
                q3Ms: quantile(0.75),
                minMs: sorted[0],
                maxMs: sorted.at(-1),
            };
        };
        const summary = { parent: summarize(samples.parent), candidate: summarize(samples.candidate) };
        results[scenario] = {
            samples,
            summary,
            medianTimeReductionPercent: (1 - summary.candidate.medianMs / summary.parent.medianMs) * 100,
        };
    }
    process.stdout.write(JSON.stringify({ node: process.version, repetitions: count, results }, null, 2) + '\n');
}
