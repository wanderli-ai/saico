const is_mocha = process.env.NODE_ENV == 'test';
const tiktoken = require('tiktoken');

module.exports = {
    countTokens,
    is_mocha,
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


