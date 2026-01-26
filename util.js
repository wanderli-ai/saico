const is_mocha = process.env.NODE_ENV == 'test';
const tiktoken = require('tiktoken');

const debug = process.env.DEBUG === '1' || process.env.DEBUG === 'true';

function _log(...args) {
    if (!is_mocha || process.env.VERBOSE)
        console.log(...args);
}

function _lerr(...args) {
    console.error(...args);
}

// Add perr method for error logging with stack trace
_lerr.perr = function(err) {
    if (err instanceof Error) {
        console.error(err.message, err.stack);
    } else {
        console.error(err);
    }
};

function _ldbg(...args) {
    if (debug)
        console.log('[DEBUG]', ...args);
}

function daysSince(timestamp) {
    return (Date.now() - timestamp) / (1000 * 60 * 60 * 24);
}

function minSince(timestamp) {
    return (Date.now() - timestamp) / (1000 * 60);
}

function shallowEqual(obj1, obj2) {
    if (obj1 === obj2) return true;
    if (!obj1 || !obj2) return false;
    const keys1 = Object.keys(obj1);
    const keys2 = Object.keys(obj2);
    if (keys1.length !== keys2.length) return false;
    for (const key of keys1) {
        if (obj1[key] !== obj2[key]) return false;
    }
    return true;
}

function filterArray(arr, predicate) {
    return arr.filter(predicate);
}

function logEvent(event, data) {
    _log(`[EVENT: ${event}]`, data);
}

const lerr = _lerr;

module.exports = {
    countTokens,
    is_mocha,
    _log,
    _lerr,
    lerr,
    _ldbg,
    daysSince,
    minSince,
    shallowEqual,
    filterArray,
    logEvent,
}

function countTokens(messages, model = "gpt-4o") {
	// Load the encoding for the specified model
	const encoding = tiktoken.encoding_for_model(model);
	let bmsg_size = 0;
	let numTokens = 0;

	if (!Array.isArray(messages))
		messages = [messages];
	messages.forEach(message => {
		if (typeof message == 'string')
		{
			numTokens += encoding.encode(message).length;
			if (message.length > bmsg_size)
				bmsg_size = message.length;
		}
		else if (typeof message == 'object')
		{
			numTokens += 4; // Role and other structure overhead
			for (const key in message) {
				if (!message[key])
					continue
				if (typeof message[key] != 'string')
					continue;
				numTokens += encoding.encode(message[key]).length;
				if (message[key].length > bmsg_size)
					bmsg_size = message[key].length;
			}
		}
	});

	// Add 2 tokens for the assistant's reply overhead
	numTokens += 2;
	encoding.free();

	return numTokens;
}


