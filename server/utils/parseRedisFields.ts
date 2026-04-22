/**
 * Safely parse a JSON string, returning the original value if parsing fails
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type ParsedRedisFields = Record<string, unknown>;

export function safeJsonParse(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

/**
 * Convert Redis fields array to JavaScript object or redis object to JavaScript object
 *
 * @returns ParsedRedisFields - always returns an object, never an array.
 * If your use case expects an array (e.g. LRANGE results), do not use this
 * function — handle parsing in the caller instead.
 *
 * Empty input (empty array, empty object, empty string) returns {}.
 * String input type returns {}
 * Callers should guard against empty results as needed.
 */
function parseRedisFields(
	fields: string[] | Record<string, string> | string,
): ParsedRedisFields {
	const obj: ParsedRedisFields = {};

	if (Array.isArray(fields)) {
		if (fields.length === 0) return {};

		// HGETALL returns an array like [key1, val1, key2, val2, ...]
		for (let i = 0; i + 1 < fields.length; i += 2) {
			const key = fields[i];
			const value = fields[i + 1];
			if (typeof key !== 'string' || typeof value !== 'string') continue;

			obj[key] = safeJsonParse(value);
		}
	} else if (typeof fields === 'object' && fields !== null) {
		// Some Redis clients return an object directly { key: value, ... }
		for (const [key, value] of Object.entries(fields)) {
			if (Array.isArray(value)) {
				// Handle arrays of JSON strings (from Lua scripts)
				obj[key] = value.map((item) => safeJsonParse(item));
			} else {
				obj[key] = safeJsonParse(value);
			}
		}
	} else if (typeof fields === 'string') {
		const parsed = safeJsonParse(fields);
		if (isRecord(parsed)) {
			return parsed as ParsedRedisFields;
		}
		return {};
	}

	return obj;
}

export { parseRedisFields };
