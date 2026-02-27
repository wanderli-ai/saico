'use strict';

const chai = require('chai');
const sinon = require('sinon');
const expect = chai.expect;

const { Store } = require('../store.js');
const util = require('../util.js');

describe('Store', function () {
    let sandbox;

    beforeEach(() => {
        sandbox = sinon.createSandbox();
        if (process.env.PROD)
            sandbox.stub(console, 'log');
        Store.instance = null;
    });

    afterEach(() => {
        sandbox.restore();
        Store.instance = null;
    });

    describe('constructor', () => {
        it('should create a store with default config', () => {
            const store = new Store();
            expect(store._redis).to.be.null;
        });
    });

    describe('singleton', () => {
        it('should initialize singleton via Store.init', () => {
            const store = Store.init();
            expect(Store.instance).to.equal(store);
        });

        it('should return singleton via Store.instance', () => {
            Store.init();
            expect(Store.instance).to.be.instanceOf(Store);
        });
    });

    describe('generateId', () => {
        it('should generate a hex string of 16 chars', () => {
            const store = new Store();
            const id = store.generateId();
            expect(id).to.be.a('string');
            expect(id).to.have.length(16);
            expect(/^[0-9a-f]+$/.test(id)).to.be.true;
        });

        it('should generate unique IDs', () => {
            const store = new Store();
            const ids = new Set(Array.from({ length: 100 }, () => store.generateId()));
            expect(ids.size).to.equal(100);
        });
    });
});

describe('Compress/Decompress Messages', function () {
    it('should compress and decompress messages', async () => {
        const messages = [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi there!' }
        ];

        const compressed = await util.compressMessages(messages);
        expect(compressed).to.be.a('string');
        expect(compressed.length).to.be.greaterThan(0);

        const decompressed = await util.decompressMessages(compressed);
        expect(decompressed).to.deep.equal(messages);
    });

    it('should pass through arrays', async () => {
        const messages = [{ role: 'user', content: 'Test' }];
        const result = await util.decompressMessages(messages);
        expect(result).to.deep.equal(messages);
    });

    it('should decompress JSON strings', async () => {
        const messages = [{ role: 'user', content: 'Test' }];
        const jsonStr = JSON.stringify(messages);
        const result = await util.decompressMessages(jsonStr);
        expect(result).to.deep.equal(messages);
    });

    it('should throw on invalid data type', async () => {
        try {
            await util.decompressMessages(12345);
            expect.fail('Should have thrown');
        } catch (err) {
            expect(err.message).to.include('unsupported data type');
        }
    });

    it('should throw on invalid string data', async () => {
        try {
            await util.decompressMessages('not-valid-base64-or-json!!!');
            expect.fail('Should have thrown');
        } catch (err) {
            expect(err.message).to.include('unable to decompress');
        }
    });
});
