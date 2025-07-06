const redis = require('redis');
let rclient;
let debug = false;

module.exports = {
	init,
	createObservableForRedis,
};

function logDebug(...args) {
    if (debug)
        console.log(...args);
}

async function init() {
	rclient = redis.createClient({ url: 'redis://localhost:6379' });
	module.exports.rclient = rclient;

	rclient.on('connect', () => {
		console.log('Connected to Redis');
	});

	rclient.on('error', (err) => {
		console.error('Redis connection error:', err);
	});

	await rclient.connect();
}

function debounce(func, delay) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => func(...args), delay);
    };
}

function createObservableForRedis(key, obj) {
    let lastSavedObject = null; // Cache for the last-saved sanitized object
    let lastSavedTimestamp = null; // Timestamp of the last save to Redis

    const saveToRedis = debounce(() => {
        const sanitizedObj = sanitizeObject(obj);

        // Compare sanitized object with the last-saved object
        if (serialize(sanitizedObj) === serialize(lastSavedObject)) {
            logDebug("No changes detected, skipping save.");
            return;
        }

        lastSavedObject = sanitizedObj;
        lastSavedTimestamp = Date.now(); // Update the last saved timestamp
		sanitizedObj.lastSave = lastSavedTimestamp;
        rclient.set(key, serialize(sanitizedObj));
        logDebug("Saved to Redis:", key, `at ${lastSavedTimestamp}`);
    }, 1000);

    const handler = {
        get(target, prop, receiver) {
            if (prop === "lastMod") {
                // Expose the last saved timestamp as a method
                return () => lastSavedTimestamp;
			}
			if (prop in target) {
				const value = Reflect.get(target, prop, receiver);
				if (typeof value === 'function') {
					// Bind the method to the original target to preserve `this`
					return value.bind(target);
				}
				return value;
			}
			return Reflect.get(target, prop, receiver);
        },
        set(target, prop, value) {
            if (String(prop).startsWith('_')) {
                target[prop] = value; // Allow setting but do not trigger save
                logDebug(`Ignored saving property '${prop}'`);
                return true;
            }

            // Wrap new objects with the Proxy
            if (typeof value === 'object' && value !== null) {
                value = new Proxy(value, handler);
            }

            target[prop] = value;
            saveToRedis(); // Trigger save for the root object
            return true;
        },
        deleteProperty(target, prop) {
            if (String(prop).startsWith('_')) {
                delete target[prop]; // Allow deletion without triggering save
                logDebug(`Ignored deletion of property '${prop}'`);
                return true;
            }

            delete target[prop];
            saveToRedis(); // Trigger save for the root object
            return true;
        },
    };

    function serialize(obj) {
		if (typeof obj == 'object' && typeof obj?.serialize == 'function')
			return obj.serialize();
        return JSON.stringify(obj);
	}

    function sanitizeObject(obj) {
        if (typeof obj !== 'object' || obj === null || typeof obj.serialize == 'function')
			return obj;
        const sanitized = Array.isArray(obj) ? [] : {};
        for (const key in obj) {
            if (!key.startsWith('_')) {
                sanitized[key] = sanitizeObject(obj[key]);
            }
        }
        return sanitized;
    }

    return new Proxy(obj, handler);
}

