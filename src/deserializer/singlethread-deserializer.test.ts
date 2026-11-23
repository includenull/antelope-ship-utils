import { ABI } from '@wharfkit/antelope';
import { expect } from 'chai';
import * as sinon from 'sinon';

import { SingleThreadDeserializer } from './singlethread-deserializer';
import { deserializeEosioType } from './serialization';

function definition(field = 'value'): any {
    return {
        structs: [{ name: 'sample', base: '', fields: [{ name: field, type: 'uint8' }] }],
    };
}

function row(abi: any, type = 'sample'): { abi: any; type: string; data: Uint8Array } {
    return { abi, type, data: new Uint8Array([7]) };
}

function repeated(abi: any, type = 'sample'): ReturnType<typeof row>[] {
    return [row(abi, type), row(abi, type)];
}

describe('row ABI preparation', () => {
    afterEach(() => sinon.restore());

    it('reuses contents across cloned tasks and preserves historical revisions and different ABIs', async () => {
        const decoder = new SingleThreadDeserializer({});
        const abi = definition();
        const resolve = sinon.spy(ABI.prototype, 'resolveType');
        expect(await decoder.deserialize([row(abi), row(abi)])).to.deep.equal([
            { success: true, data: { value: 7 } },
            { success: true, data: { value: 7 } },
        ]);
        expect(resolve.callCount).to.equal(2);
        await decoder.deserialize(repeated(structuredClone(abi)));
        expect(resolve.callCount).to.equal(3);
        expect(
            await decoder.deserialize([
                ...repeated(definition('new')),
                ...repeated(definition('other')),
                ...repeated(abi),
            ]),
        ).to.deep.equal([
            { success: true, data: { new: 7 } },
            { success: true, data: { new: 7 } },
            { success: true, data: { other: 7 } },
            { success: true, data: { other: 7 } },
            { success: true, data: { value: 7 } },
            { success: true, data: { value: 7 } },
        ]);
        expect(resolve.callCount).to.equal(8);
    });

    it('observes nested mutations between calls without contaminating cached old contents', async () => {
        const decoder = new SingleThreadDeserializer({});
        const abi = definition();
        const old = structuredClone(abi);
        await decoder.deserialize(repeated(abi));
        abi.structs[0].fields[0].name = 'changed';
        expect(await decoder.deserialize([...repeated(abi), ...repeated(old)])).to.deep.equal([
            { success: true, data: { changed: 7 } },
            { success: true, data: { changed: 7 } },
            { success: true, data: { value: 7 } },
            { success: true, data: { value: 7 } },
        ]);
        abi.structs[0].fields[0].type = 'uint16';
        expect((await decoder.deserialize([row(abi)]))[0]!.success).to.equal(false);
        abi.structs[0].fields[0].type = 'uint8';
        expect((await decoder.deserialize([row(abi)]))[0]!.success).to.equal(true);
    });

    it('keeps live ABI instances on their existing fast path and observes their mutations', async () => {
        const decoder = new SingleThreadDeserializer({});
        const abi = ABI.from(definition());
        const resolve = sinon.spy(abi, 'resolveType');
        await decoder.deserialize([row(abi), row(abi)]);
        expect(resolve.callCount).to.equal(2);
        abi.structs[0]!.fields[0]!.name = 'changed';
        expect(await decoder.deserialize([row(abi)])).to.deep.equal([{ success: true, data: { changed: 7 } }]);
    });

    it('includes alias and variant definitions in the contents identity', async () => {
        const decoder = new SingleThreadDeserializer({});
        for (const abi of [
            { types: [{ new_type_name: 'sample', type: 'uint8' }] },
            { variants: [{ name: 'sample', types: ['uint8', 'uint16'] }] },
        ]) {
            const old = structuredClone(abi);
            const input = (): ReturnType<typeof row>[] =>
                repeated(abi).map((r) => ({ ...r, data: new Uint8Array([0, 1, 2]) }));
            const before = await decoder.deserialize(input());
            if (abi.types) abi.types[0]!.type = 'uint16';
            if (abi.variants) abi.variants[0]!.types.reverse();
            expect(await decoder.deserialize(input())).not.to.deep.equal(before);
            Object.assign(abi, old);
            expect(await decoder.deserialize(input())).to.deep.equal(before);
        }
    });

    it('evicts the least recently used revision after 32 entries', async () => {
        const decoder = new SingleThreadDeserializer({});
        const resolve = sinon.spy(ABI.prototype, 'resolveType');
        for (let i = 0; i < 32; i++) await decoder.deserialize(repeated(definition(`value${i}`)));
        await decoder.deserialize(repeated(definition('value0')));
        expect(resolve.callCount).to.equal(65);
        await decoder.deserialize([...repeated(definition('value32')), ...repeated(definition('value0'))]);
        expect(resolve.callCount).to.equal(68);
        await decoder.deserialize(repeated(definition('value1')));
        expect(resolve.callCount).to.equal(70);
    });

    it('bounds resolved types within a revision', async () => {
        const decoder = new SingleThreadDeserializer({});
        const abi = {
            structs: Array.from({ length: 65 }, (_, i) => ({
                name: `sample${i}`,
                base: '',
                fields: [{ name: 'value', type: 'uint8' }],
            })),
        };
        const resolve = sinon.spy(ABI.prototype, 'resolveType');
        for (let i = 0; i < 65; i++) await decoder.deserialize(repeated(abi, `sample${i}`));
        await decoder.deserialize(repeated(abi, 'sample64'));
        expect(resolve.callCount).to.equal(131);
        await decoder.deserialize(repeated(abi, 'sample0'));
        expect(resolve.callCount).to.equal(133);
    });

    it('preserves malformed ABI errors and retries after repair without caching an error', async () => {
        const decoder = new SingleThreadDeserializer({});
        const malformed = definition();
        malformed.structs[0].fields = null;
        for (const abi of ['{', malformed, { types: true }, { structs: [null] }]) {
            let message: string | undefined;
            try {
                deserializeEosioType('sample', new Uint8Array([7]), ABI.from(abi as any), false);
            } catch (error) {
                message = String(error);
            }
            expect(message).to.be.a('string');
            for (let i = 0; i < 2; i++) {
                expect(await decoder.deserialize(repeated(abi))).to.deep.equal([
                    { success: false, data: null, message },
                    { success: false, data: null, message },
                ]);
            }
        }
        malformed.structs[0].fields = [{ name: 'fixed', type: 'uint8' }];
        expect(await decoder.deserialize(repeated(malformed))).to.deep.equal([
            { success: true, data: { fixed: 7 } },
            { success: true, data: { fixed: 7 } },
        ]);
    });

    it('supports JSON overrides and falls back for definitions that cannot be cloned', async () => {
        const decoder = new SingleThreadDeserializer({});
        const abi = definition();
        abi.structs[0].ignored = () => undefined;
        const custom = definition();
        class Field {
            name = 'value';
            type = 'uint8';
        }
        custom.structs[0].fields = [new Field()];
        expect(
            await decoder.deserialize([
                ...repeated(abi),
                ...repeated(JSON.stringify(definition())),
                ...repeated(custom),
            ]),
        ).to.deep.equal([
            { success: true, data: { value: 7 } },
            { success: true, data: { value: 7 } },
            { success: true, data: { value: 7 } },
            { success: true, data: { value: 7 } },
            { success: true, data: { value: 7 } },
            { success: true, data: { value: 7 } },
        ]);
    });
});
