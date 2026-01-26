'use strict';

const chai = require('chai');
const sinon = require('sinon');
const expect = chai.expect;

const saico = require('../index.js');
const { Itask, Context, Sid, createTask, createSid, createContext, createQ } = saico;
const openai = require('../openai.js');
const util = require('../util.js');

describe('Integration Tests', function () {
    let sandbox;
    let mockToolHandler;

    beforeEach(() => {
        sandbox = sinon.createSandbox();
        if (process.env.PROD)
            sandbox.stub(console, 'log');
        sandbox.stub(util, 'countTokens').callsFake((msgs) => {
            if (Array.isArray(msgs)) return msgs.length * 10;
            return 10;
        });
        sandbox.stub(openai, 'send').resolves({ content: 'AI response' });
        mockToolHandler = sandbox.stub().resolves({ content: 'tool result', functions: null });
        Itask.root.clear();
    });

    afterEach(() => {
        sandbox.restore();
        Itask.root.clear();
    });

    describe('Module exports', () => {
        it('should export all core classes', () => {
            expect(Itask).to.be.a('function');
            expect(Context).to.be.a('function');
            expect(Sid).to.be.a('function');
        });

        it('should export factory functions', () => {
            expect(createTask).to.be.a('function');
            expect(createSid).to.be.a('function');
            expect(createContext).to.be.a('function');
            expect(createQ).to.be.a('function');
        });

        it('should export utilities', () => {
            expect(saico.util).to.exist;
            expect(saico.openai).to.exist;
            expect(saico.redis).to.exist;
        });

        it('should wire up Context reference in Itask', () => {
            expect(Itask.Context).to.equal(Context);
        });
    });

    describe('Hierarchical Message Flow', () => {
        it('should aggregate messages from task hierarchy', async () => {
            // Create root session
            const session = createSid({
                name: 'session',
                prompt: 'You are a helpful assistant.'
            });

            // Add summary to session context
            session.context.pushSummary('Previous conversation summary');

            // Create child task with context
            const childTask = session.spawnTaskWithContext({
                name: 'subtask',
                prompt: 'You are handling a specific subtask.'
            }, []);

            // Send message from child - should include parent context
            await childTask.sendMessage('user', 'Working on subtask');

            const sentArgs = openai.send.getCall(0).args[0];

            // Verify hierarchy order
            expect(sentArgs[0]).to.deep.equal({ role: 'system', content: 'You are a helpful assistant.' });
            expect(sentArgs.some(m => m.content?.includes('Previous conversation summary'))).to.be.true;
            expect(sentArgs.some(m => m.content === 'You are handling a specific subtask.')).to.be.true;
            expect(sentArgs.some(m => m.content === 'Working on subtask')).to.be.true;
        });

        it('should aggregate functions from hierarchy', async () => {
            const parentFunc = { name: 'parent_func', description: 'Parent function' };
            const childFunc = { name: 'child_func', description: 'Child function' };

            const session = createSid({
                name: 'session',
                prompt: 'Root prompt',
                functions: [parentFunc]
            });

            const childTask = session.spawnTaskWithContext({
                name: 'child',
                prompt: 'Child prompt',
                functions: [childFunc]
            }, []);

            await childTask.sendMessage('user', 'Test message');

            const sentFunctions = openai.send.getCall(0).args[1];
            expect(sentFunctions).to.exist;
            expect(sentFunctions).to.have.length(2);
            const funcNames = sentFunctions.map(f => f.name);
            expect(funcNames).to.include('parent_func');
            expect(funcNames).to.include('child_func');
        });

        it('should handle multi-level hierarchy', async () => {
            const root = createSid({
                name: 'root',
                prompt: 'Level 0'
            });

            const level1 = root.spawnTaskWithContext({
                name: 'level1',
                prompt: 'Level 1'
            }, []);

            const level2Task = new Itask({
                name: 'level2',
                async: true,
                spawn_parent: level1
            }, []);
            const level2Ctx = new Context('Level 2', level2Task, {});
            level2Task.setContext(level2Ctx);

            await level2Task.sendMessage('user', 'Deep message');

            const sentArgs = openai.send.getCall(0).args[0];

            // Verify all three levels are present
            const systemPrompts = sentArgs.filter(m => m.role === 'system');
            expect(systemPrompts.map(m => m.content)).to.include.members([
                'Level 0', 'Level 1', 'Level 2'
            ]);
        });
    });

    describe('Task without Context', () => {
        it('should use ancestor context for sendMessage', async () => {
            const session = createSid({
                name: 'session',
                prompt: 'Session prompt'
            });

            // Spawn a task WITHOUT its own context
            const simpleTask = session.spawnTask({
                name: 'simple'
            }, [
                async function() {
                    // This should use the session's context
                    return await this.sendMessage('user', 'Simple task message');
                }
            ]);

            await simpleTask;

            expect(openai.send.calledOnce).to.be.true;
            const sentArgs = openai.send.getCall(0).args[0];
            expect(sentArgs[0].content).to.equal('Session prompt');
        });
    });

    describe('Tool Calls with Hierarchy', () => {
        it('should execute tool calls in hierarchical context', async () => {
            const session = createSid({
                name: 'session',
                prompt: 'Session prompt',
                tool_handler: mockToolHandler
            });

            const toolCallReply = {
                content: 'Calling tool',
                tool_calls: [{
                    id: 'call_123',
                    type: 'function',
                    function: {
                        name: 'test_tool',
                        arguments: JSON.stringify({ action: 'test' })
                    }
                }]
            };

            openai.send.onFirstCall().resolves(toolCallReply);
            openai.send.onSecondCall().resolves({ content: 'Tool processed' });

            const reply = await session.sendMessage('user', 'Use a tool');

            expect(mockToolHandler.calledOnce).to.be.true;
            expect(reply.content).to.include('Calling tool');
        });

        it('should inherit tool handler from parent', async () => {
            const session = createSid({
                name: 'session',
                prompt: 'Session prompt',
                tool_handler: mockToolHandler
            });

            const child = session.spawnTaskWithContext({
                name: 'child',
                prompt: 'Child prompt'
                // No tool_handler specified - should inherit from session
            }, []);

            const toolCallReply = {
                content: 'Calling tool',
                tool_calls: [{
                    id: 'call_456',
                    type: 'function',
                    function: {
                        name: 'child_tool',
                        arguments: '{}'
                    }
                }]
            };

            openai.send.onFirstCall().resolves(toolCallReply);
            openai.send.onSecondCall().resolves({ content: 'Done' });

            await child.sendMessage('user', 'Use tool from child');

            expect(mockToolHandler.calledOnce).to.be.true;
        });
    });

    describe('Legacy createQ Compatibility', () => {
        it('should work with createQ factory function', async () => {
            const ctx = createQ('Test prompt', null, 'test-tag', 1000, null, mockToolHandler);

            expect(ctx.prompt).to.equal('Test prompt');
            expect(ctx.tag).to.equal('test-tag');

            const reply = await ctx.sendMessage('user', 'Hello');
            expect(reply.content).to.equal('AI response');
        });

        it('should maintain backward compatible API', () => {
            const ctx = createQ('Test', null, 'tag');

            // Test array-like access
            ctx.push({ role: 'user', content: 'Hi' });
            expect(ctx[0]).to.deep.equal({ role: 'user', content: 'Hi' });
            expect(ctx.length).to.equal(1);

            // Test methods
            expect(typeof ctx.sendMessage).to.equal('function');
            expect(typeof ctx.close).to.equal('function');
            expect(typeof ctx.serialize).to.equal('function');
        });
    });

    describe('Context Close and Summary Bubbling', () => {
        it('should bubble summary to parent when closing', async () => {
            const session = createSid({
                name: 'session',
                prompt: 'Session prompt'
            });

            const child = session.spawnTaskWithContext({
                name: 'child',
                prompt: 'Child prompt'
            }, []);

            // Add some conversation to child
            child.context._msgs.push({
                msg: { role: 'user', content: 'Hello from child' },
                opts: {},
                replied: 1
            });
            child.context._msgs.push({
                msg: { role: 'assistant', content: 'Hi there!' },
                opts: {},
                replied: 3
            });

            // Close child context
            await child.context.close();

            // Check that summary was added to session context
            const sessionSummaries = session.context.getSummaries();
            expect(sessionSummaries.length).to.be.greaterThan(0);
        });
    });

    describe('Serialization Round-Trip', () => {
        it('should preserve state through serialization', () => {
            const original = createSid({
                name: 'test-session',
                prompt: 'Test prompt',
                userData: { userId: '123', preferences: { theme: 'dark' } }
            });

            original.context.push({ role: 'user', content: 'Hello' });
            original.context.push({ role: 'assistant', content: 'Hi!' });
            original.context.pushSummary('Previous summary');

            const serialized = original.serialize();
            const restored = Sid.deserialize(serialized);

            expect(restored.name).to.equal(original.name);
            expect(restored.prompt).to.equal(original.prompt);
            expect(restored.id).to.equal(original.id);
            expect(restored.userData).to.deep.equal(original.userData);
            expect(restored.context.length).to.equal(original.context.length);
        });
    });

    describe('createTask Factory', () => {
        it('should create task with context when prompt provided', () => {
            const task = createTask({
                name: 'test-task',
                prompt: 'Task prompt',
                functions: [{ name: 'func1' }]
            }, []);

            expect(task).to.be.instanceOf(Itask);
            expect(task.context).to.exist;
            expect(task.context.prompt).to.equal('Task prompt');
        });

        it('should create task without context when no prompt', () => {
            const task = createTask({
                name: 'simple-task'
            }, []);

            expect(task).to.be.instanceOf(Itask);
            expect(task.context).to.be.null;
        });
    });

    describe('Concurrent Operations', () => {
        it('should handle multiple concurrent sendMessage calls', async () => {
            const session = createSid({
                name: 'session',
                prompt: 'Session prompt'
            });

            openai.send.resolves({ content: 'Response' });

            // Send multiple messages concurrently
            const promises = [
                session.sendMessage('user', 'Message 1'),
                session.sendMessage('user', 'Message 2'),
                session.sendMessage('user', 'Message 3')
            ];

            const results = await Promise.all(promises);

            expect(results).to.have.length(3);
            // Note: Due to queueing, some may be queued
            expect(results.filter(r => r.content === 'Response' || r.queued).length).to.equal(3);
        });

        it('should handle multiple child tasks', async () => {
            const session = createSid({
                name: 'session',
                prompt: 'Session prompt'
            });

            const children = [];
            for (let i = 0; i < 3; i++) {
                children.push(session.spawnTask({
                    name: `child-${i}`,
                    async: true
                }, [
                    function() { return this.name; }
                ]));
            }

            // Start all children
            children.forEach(c => c._run());

            const results = await Promise.all(children);

            expect(results).to.deep.equal(['child-0', 'child-1', 'child-2']);
            expect(session.child.size).to.equal(0); // All should have completed
        });
    });

    describe('Error Handling', () => {
        it('should handle sendMessage errors gracefully', async () => {
            const session = createSid({
                name: 'session',
                prompt: 'Session prompt'
            });

            openai.send.rejects(new Error('API Error'));

            try {
                await session.sendMessage('user', 'Hello');
                expect.fail('Should have thrown');
            } catch (err) {
                expect(err.message).to.equal('API Error');
            }
        });

        it('should handle tool handler errors', async () => {
            const errorHandler = sandbox.stub().rejects(new Error('Tool failed'));

            const session = createSid({
                name: 'session',
                prompt: 'Session prompt',
                tool_handler: errorHandler
            });

            const toolCallReply = {
                content: 'Calling tool',
                tool_calls: [{
                    id: 'call_err',
                    type: 'function',
                    function: { name: 'failing_tool', arguments: '{}' }
                }]
            };

            openai.send.onFirstCall().resolves(toolCallReply);
            openai.send.onSecondCall().resolves({ content: 'Handled error' });

            const reply = await session.sendMessage('user', 'Use failing tool');

            // Should have continued with error message
            expect(reply).to.exist;
        });
    });
});
