const OpenAI = require('openai');

const openai = new OpenAI({
	apiKey: process.env.OPENAI_API_KEY||'test'
});

module.exports = {
	send,
};

async function send(messages, functions, model) {
	let data;
	let retries = 5;
	while (--retries)
	{
		try {
			data = await openai.chat.completions.create({
				model: model || 'gpt-4o', messages, functions, });
			break;
		} catch (error) {
			// Check if the status code is 429
			if (error.status == 429)
			{
				console.error("Error 429: Too Many Requests");
				console.error("Message:", error.message);
				const errorMessage = error.message || '';

				const waitTimeMatch = errorMessage.match(/Please try again in (\d+(\.\d+)?)(ms|s)/);

				if (waitTimeMatch)
				{
					let waitTime = parseFloat(waitTimeMatch[1]);
					if (waitTimeMatch[3] === 's')
						waitTime *= 1000; // Convert seconds to milliseconds
					console.error(`Rate limit reached. Retrying in ${waitTime}ms...`);
					await new Promise(resolve => setTimeout(resolve, waitTime+100));
				} else {
					console.error('Rate limit error encountered, but could not extract wait time. Aborting.');
					console.error('messages:\n', JSON.stringify(messages));
					throw error; // Exit if wait time cannot be extracted
				}
			} else {
				console.error(`Unexpected Error ${error.status}: ${error.message}`);
				throw error;
			}
		}
	}

	if (!data || !data.choices || !data.choices.length)
		return console.error('failed to receive response\n', data);
	return data.choices[0].message;
}


