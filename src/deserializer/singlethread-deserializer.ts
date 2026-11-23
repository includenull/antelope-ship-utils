import { ABI } from '@wharfkit/antelope';
import { isDeepStrictEqual } from 'node:util';

import { deserializeEosioType } from './serialization';
import { IDeserializer } from '../types/ship';

const MAX_CACHED_ABIS = 32;

class PreparedAbi extends ABI {
    private readonly resolvedTypes = new Map<string, ABI.ResolvedType>();

    override resolveType(name: string): ABI.ResolvedType {
        const cached = this.resolvedTypes.get(name);
        if (cached) return cached;
        const resolved = super.resolveType(name);
        if (this.resolvedTypes.size === 64) {
            this.resolvedTypes.delete(this.resolvedTypes.keys().next().value!);
        }
        this.resolvedTypes.set(name, resolved);
        return resolved;
    }
}

export class SingleThreadDeserializer implements IDeserializer {
    waiting: number = 0;

    private readonly shipAbi: ABI;
    private readonly overrideAbis: PreparedAbi[] = [];

    constructor(abi: any) {
        this.shipAbi = ABI.from(abi);
    }

    deserialize(
        param: Array<{ type: string; data: Uint8Array | string; abi?: any } | undefined>,
    ): Promise<Array<{ success: boolean; data: unknown; message?: string }>> {
        const result = [];
        // Calls run synchronously; discard identity shortcuts before callers can mutate inputs.
        let batchAbis: Map<unknown, { abi: ABI; prepared: boolean }> | undefined;

        for (const row of param) {
            try {
                if (!row || !row.data) {
                    throw new Error('Empty data received on deserialize worker');
                }

                if (row.abi) {
                    let rowAbi: ABI;
                    if (param.length === 1 || row.abi instanceof ABI) {
                        rowAbi = ABI.from(row.abi);
                    } else {
                        batchAbis ??= new Map();
                        const cached = batchAbis.get(row.abi);
                        if (cached) {
                            if (!cached.prepared) {
                                cached.abi = this.prepareAbi(row.abi);
                                cached.prepared = true;
                            }
                            rowAbi = cached.abi;
                        } else {
                            // Content comparison/snapshotting only pays off on reused overrides.
                            rowAbi = ABI.from(row.abi);
                            if (batchAbis.size === MAX_CACHED_ABIS) {
                                batchAbis.delete(batchAbis.keys().next().value);
                            }
                            batchAbis.set(row.abi, { abi: rowAbi, prepared: false });
                        }
                    }

                    result.push({
                        success: true,
                        data: deserializeEosioType(row.type, row.data, rowAbi, false),
                    });
                } else {
                    result.push({
                        success: true,
                        data: deserializeEosioType(row.type, row.data, this.shipAbi),
                    });
                }
            } catch (error) {
                result.push({
                    success: false,
                    data: null,
                    message: String(error),
                });
            }
        }

        return Promise.resolve(result);
    }

    private prepareAbi(input: any): ABI {
        const abi = ABI.from(input);
        // ABI.from already has a zero-allocation fast path for live instances.
        if (abi === input) return abi;

        // Only these definitions participate in resolveType; account/block metadata
        // is absent from worker tasks and cannot identify a historical revision.
        try {
            const definitions = { types: abi.types, structs: abi.structs, variants: abi.variants };
            const index = this.overrideAbis.findLastIndex((cached) =>
                isDeepStrictEqual(definitions, {
                    types: cached.types,
                    structs: cached.structs,
                    variants: cached.variants,
                }),
            );
            if (index !== -1) {
                const cached = this.overrideAbis.splice(index, 1)[0]!;
                this.overrideAbis.push(cached);
                return cached;
            }
            const snapshot = structuredClone(definitions);
            // Preserve unusual definitions with custom prototypes/methods via the old path.
            if (!isDeepStrictEqual(definitions, snapshot)) return abi;
            const prepared = new PreparedAbi(snapshot);
            if (this.overrideAbis.length === MAX_CACHED_ABIS) this.overrideAbis.shift();
            this.overrideAbis.push(prepared);
            return prepared;
        } catch {
            return abi;
        }
    }

    terminate(): Promise<void> {
        return Promise.resolve(undefined);
    }
}
