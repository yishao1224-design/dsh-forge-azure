function failure(code, message, status) {
	return {
		ok: false,
		failure: {
			code,
			message
		},
		status
	};
}
/** Message Azure DevOps put in an error body, or undefined when the body carries none. */
function serverMessage(text) {
	try {
		const parsed = JSON.parse(text);
		if (typeof parsed === "object" && parsed !== null && "message" in parsed && typeof parsed.message === "string") return parsed.message;
	} catch {}
}
/** Sends GET requests with the personal access token as HTTP Basic credentials; never writes. */
var AzureApi = class {
	token;
	config;
	fetcher;
	/**
	* @param token - reads the personal access token.
	* @param config - request limits.
	* @param fetcher - HTTP client, the global `fetch` by default.
	*/
	constructor(token, config, fetcher = async (url, init) => await fetch(url, init)) {
		this.token = token;
		this.config = config;
		this.fetcher = fetcher;
	}
	/**
	* Read one JSON resource.
	* @param url - absolute `https://dev.azure.com/...` address without `api-version`.
	* @param signal - cancellation of the read.
	* @param version - API version, for resources that exist only as a preview.
	* @returns the parsed body, or the failure. A missing or rejected token is `unauthenticated`.
	*/
	async get(url, signal, version = "7.1") {
		if (!url.startsWith("https://dev.azure.com/")) throw new Error(`forge-azure: refusing to request ${JSON.stringify(url)}`);
		const token = (await this.token())?.trim();
		if (token === void 0 || token === "") return failure("unauthenticated", "no Azure DevOps personal access token is configured", null);
		const address = `${url}${url.includes("?") ? "&" : "?"}api-version=${version}`;
		const deadline = AbortSignal.timeout(this.config.timeoutMs);
		const combined = AbortSignal.any([signal, deadline]);
		let response;
		let text;
		try {
			response = await this.fetcher(address, {
				method: "GET",
				headers: {
					Authorization: `Basic ${Buffer.from(`:${token}`).toString("base64")}`,
					Accept: "application/json",
					"X-TFS-FedAuthRedirect": "Suppress"
				},
				signal: combined,
				redirect: "manual"
			});
			if (Number(response.headers.get("content-length") ?? "0") > this.config.maxResponseBytes) return failure("too-large", "the Azure DevOps response exceeds maxResponseBytes", response.status);
			text = await response.text();
		} catch (error) {
			if (signal.aborted) throw signal.reason;
			if (deadline.aborted) return failure("unavailable", `Azure DevOps did not answer within ${this.config.timeoutMs}ms`, null);
			return failure("unavailable", `Azure DevOps could not be reached: ${error instanceof Error ? error.message : String(error)}`, null);
		}
		if (Buffer.byteLength(text) > this.config.maxResponseBytes) return failure("too-large", "the Azure DevOps response exceeds maxResponseBytes", response.status);
		const status = response.status;
		if (status === 401 || status === 203 || status >= 300 && status < 400) return failure("unauthenticated", "Azure DevOps rejected the personal access token", status);
		if (status === 404) return failure("not-found", serverMessage(text) ?? "Azure DevOps does not expose the resource", status);
		if (status === 429) return failure("rate-limited", serverMessage(text) ?? "Azure DevOps refused the read under its rate limit", status);
		if (status === 403) return failure("unavailable", serverMessage(text) ?? "the personal access token may not read the resource", status);
		if (status < 200 || status >= 300) return failure("unavailable", serverMessage(text) ?? `Azure DevOps answered HTTP ${status}`, status);
		try {
			return {
				ok: true,
				body: JSON.parse(text)
			};
		} catch {
			return failure("unavailable", "Azure DevOps answered with a body that is not JSON", status);
		}
	}
};
/** `value` as an object, or an empty object. */
function object(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}
/** `value` as an array of objects; other values and elements are dropped. */
function objects(value) {
	return Array.isArray(value) ? value.filter((item) => typeof item === "object" && item !== null && !Array.isArray(item)) : [];
}
/** `value` when it is a non-empty string. */
function text(value) {
	return typeof value === "string" && value !== "" ? value : void 0;
}
/** `value` when it is a finite number. */
function numeric(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
/** Run `task` on every item, at most `limit` at a time; settles once every task settled, then rejects with the first rejection. */
async function pool(items, limit, task) {
	let next = 0;
	const errors = [];
	const worker = async () => {
		while (next < items.length && errors.length === 0) {
			const item = items[next++];
			try {
				await task(item);
			} catch (error) {
				errors.push(error);
			}
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
	if (errors.length > 0) throw errors[0];
}
// node_modules/diff/libesm/diff/base.js
var Diff = class {
	diff(oldStr, newStr, options = {}) {
		let callback;
		if (typeof options === "function") {
			callback = options;
			options = {};
		} else if ("callback" in options) callback = options.callback;
		const oldString = this.castInput(oldStr, options);
		const newString = this.castInput(newStr, options);
		const oldTokens = this.removeEmpty(this.tokenize(oldString, options));
		const newTokens = this.removeEmpty(this.tokenize(newString, options));
		return this.diffWithOptionsObj(oldTokens, newTokens, options, callback);
	}
	diffWithOptionsObj(oldTokens, newTokens, options, callback) {
		var _a;
		const done = (value) => {
			value = this.postProcess(value, options);
			if (callback) {
				setTimeout(function() {
					callback(value);
				}, 0);
				return;
			} else return value;
		};
		const newLen = newTokens.length, oldLen = oldTokens.length;
		let editLength = 1;
		let maxEditLength = newLen + oldLen;
		if (options.maxEditLength != null) maxEditLength = Math.min(maxEditLength, options.maxEditLength);
		const maxExecutionTime = (_a = options.timeout) !== null && _a !== void 0 ? _a : Infinity;
		const abortAfterTimestamp = Date.now() + maxExecutionTime;
		const bestPath = [{
			oldPos: -1,
			lastComponent: void 0
		}];
		let newPos = this.extractCommon(bestPath[0], newTokens, oldTokens, 0, options);
		if (bestPath[0].oldPos + 1 >= oldLen && newPos + 1 >= newLen) return done(this.buildValues(bestPath[0].lastComponent, newTokens, oldTokens));
		let minDiagonalToConsider = -Infinity, maxDiagonalToConsider = Infinity;
		const execEditLength = () => {
			for (let diagonalPath = Math.max(minDiagonalToConsider, -editLength); diagonalPath <= Math.min(maxDiagonalToConsider, editLength); diagonalPath += 2) {
				let basePath;
				const removePath = bestPath[diagonalPath - 1], addPath = bestPath[diagonalPath + 1];
				if (removePath) bestPath[diagonalPath - 1] = void 0;
				let canAdd = false;
				if (addPath) {
					const addPathNewPos = addPath.oldPos - diagonalPath;
					canAdd = addPath && 0 <= addPathNewPos && addPathNewPos < newLen;
				}
				const canRemove = removePath && removePath.oldPos + 1 < oldLen;
				if (!canAdd && !canRemove) {
					bestPath[diagonalPath] = void 0;
					continue;
				}
				if (!canRemove || canAdd && removePath.oldPos < addPath.oldPos) basePath = this.addToPath(addPath, true, false, 0, options);
				else basePath = this.addToPath(removePath, false, true, 1, options);
				newPos = this.extractCommon(basePath, newTokens, oldTokens, diagonalPath, options);
				if (basePath.oldPos + 1 >= oldLen && newPos + 1 >= newLen) return done(this.buildValues(basePath.lastComponent, newTokens, oldTokens)) || true;
				else {
					bestPath[diagonalPath] = basePath;
					if (basePath.oldPos + 1 >= oldLen) maxDiagonalToConsider = Math.min(maxDiagonalToConsider, diagonalPath - 1);
					if (newPos + 1 >= newLen) minDiagonalToConsider = Math.max(minDiagonalToConsider, diagonalPath + 1);
				}
			}
			editLength++;
		};
		if (callback) (function exec() {
			setTimeout(function() {
				if (editLength > maxEditLength || Date.now() > abortAfterTimestamp) return callback(void 0);
				if (!execEditLength()) exec();
			}, 0);
		})();
		else while (editLength <= maxEditLength && Date.now() <= abortAfterTimestamp) {
			const ret = execEditLength();
			if (ret) return ret;
		}
	}
	addToPath(path, added, removed, oldPosInc, options) {
		const last = path.lastComponent;
		if (last && !options.oneChangePerToken && last.added === added && last.removed === removed) return {
			oldPos: path.oldPos + oldPosInc,
			lastComponent: {
				count: last.count + 1,
				added,
				removed,
				previousComponent: last.previousComponent
			}
		};
		else return {
			oldPos: path.oldPos + oldPosInc,
			lastComponent: {
				count: 1,
				added,
				removed,
				previousComponent: last
			}
		};
	}
	extractCommon(basePath, newTokens, oldTokens, diagonalPath, options) {
		const newLen = newTokens.length, oldLen = oldTokens.length;
		let oldPos = basePath.oldPos, newPos = oldPos - diagonalPath, commonCount = 0;
		while (newPos + 1 < newLen && oldPos + 1 < oldLen && this.equals(oldTokens[oldPos + 1], newTokens[newPos + 1], options)) {
			newPos++;
			oldPos++;
			commonCount++;
			if (options.oneChangePerToken) basePath.lastComponent = {
				count: 1,
				previousComponent: basePath.lastComponent,
				added: false,
				removed: false
			};
		}
		if (commonCount && !options.oneChangePerToken) basePath.lastComponent = {
			count: commonCount,
			previousComponent: basePath.lastComponent,
			added: false,
			removed: false
		};
		basePath.oldPos = oldPos;
		return newPos;
	}
	equals(left, right, options) {
		if (options.comparator) return options.comparator(left, right);
		else return left === right || !!options.ignoreCase && left.toLowerCase() === right.toLowerCase();
	}
	removeEmpty(array) {
		const ret = [];
		for (let i = 0; i < array.length; i++) if (array[i]) ret.push(array[i]);
		return ret;
	}
	castInput(value, options) {
		return value;
	}
	tokenize(value, options) {
		return Array.from(value);
	}
	join(chars) {
		return chars.join("");
	}
	postProcess(changeObjects, options) {
		return changeObjects;
	}
	get useLongestToken() {
		return false;
	}
	buildValues(lastComponent, newTokens, oldTokens) {
		const components = [];
		let nextComponent;
		while (lastComponent) {
			components.push(lastComponent);
			nextComponent = lastComponent.previousComponent;
			delete lastComponent.previousComponent;
			lastComponent = nextComponent;
		}
		components.reverse();
		const componentLen = components.length;
		let componentPos = 0, newPos = 0, oldPos = 0;
		for (; componentPos < componentLen; componentPos++) {
			const component = components[componentPos];
			if (!component.removed) {
				if (!component.added && this.useLongestToken) {
					let value = newTokens.slice(newPos, newPos + component.count);
					value = value.map(function(value, i) {
						const oldValue = oldTokens[oldPos + i];
						return oldValue.length > value.length ? oldValue : value;
					});
					component.value = this.join(value);
				} else component.value = this.join(newTokens.slice(newPos, newPos + component.count));
				newPos += component.count;
				if (!component.added) oldPos += component.count;
			} else {
				component.value = this.join(oldTokens.slice(oldPos, oldPos + component.count));
				oldPos += component.count;
			}
		}
		return components;
	}
};
// node_modules/diff/libesm/diff/character.js
var CharacterDiff = class extends Diff {};
new CharacterDiff();
// node_modules/diff/libesm/util/string.js
function longestCommonPrefix(str1, str2) {
	let i = 0;
	for (; i < str1.length && i < str2.length; i++) if (str1[i] != str2[i]) return str1.slice(0, i);
	return str1.slice(0, i);
}
function longestCommonSuffix(str1, str2) {
	let i;
	if (!str1 || !str2 || str1[str1.length - 1] != str2[str2.length - 1]) return "";
	for (i = 0; i < str1.length && i < str2.length; i++) if (str1[str1.length - (i + 1)] != str2[str2.length - (i + 1)]) return str1.slice(-i);
	return str1.slice(-i);
}
function replacePrefix(string, oldPrefix, newPrefix) {
	if (string.slice(0, oldPrefix.length) != oldPrefix) throw Error(`string ${JSON.stringify(string)} doesn't start with prefix ${JSON.stringify(oldPrefix)}; this is a bug`);
	return newPrefix + string.slice(oldPrefix.length);
}
function replaceSuffix(string, oldSuffix, newSuffix) {
	if (!oldSuffix) return string + newSuffix;
	if (string.slice(-oldSuffix.length) != oldSuffix) throw Error(`string ${JSON.stringify(string)} doesn't end with suffix ${JSON.stringify(oldSuffix)}; this is a bug`);
	return string.slice(0, -oldSuffix.length) + newSuffix;
}
function removePrefix(string, oldPrefix) {
	return replacePrefix(string, oldPrefix, "");
}
function removeSuffix(string, oldSuffix) {
	return replaceSuffix(string, oldSuffix, "");
}
function maximumOverlap(string1, string2) {
	return string2.slice(0, overlapCount(string1, string2));
}
function overlapCount(a, b) {
	let startA = 0;
	if (a.length > b.length) startA = a.length - b.length;
	let endB = b.length;
	if (a.length < b.length) endB = a.length;
	const map = Array(endB);
	let k = 0;
	map[0] = 0;
	for (let j = 1; j < endB; j++) {
		if (b[j] == b[k]) map[j] = map[k];
		else map[j] = k;
		while (k > 0 && b[j] != b[k]) k = map[k];
		if (b[j] == b[k]) k++;
	}
	k = 0;
	for (let i = startA; i < a.length; i++) {
		while (k > 0 && a[i] != b[k]) k = map[k];
		if (a[i] == b[k]) k++;
	}
	return k;
}
/**
* Split a string into segments using a word segmenter, merging consecutive
* segments if they are both whitespace segments. Whitespace segments can
* appear adjacent to one another for two reasons:
* - newlines always get their own segment
* - where a diacritic is attached to a whitespace character in the text, the
*   segment ends after the diacritic, so e.g. " \u0300 " becomes two segments.
* This function therefore runs the segmenter's .segment() method and then
* merges consecutive segments of whitespace into a single part.
*/
function segment(string, segmenter) {
	const parts = [];
	for (const segmentObj of Array.from(segmenter.segment(string))) {
		const segment = segmentObj.segment;
		if (parts.length && /\s/.test(parts[parts.length - 1]) && /\s/.test(segment)) parts[parts.length - 1] += segment;
		else parts.push(segment);
	}
	return parts;
}
function trailingWs(string, segmenter) {
	if (segmenter) return leadingAndTrailingWs(string, segmenter)[1];
	let i;
	for (i = string.length - 1; i >= 0; i--) if (!string[i].match(/\s/)) break;
	return string.substring(i + 1);
}
function leadingWs(string, segmenter) {
	if (segmenter) return leadingAndTrailingWs(string, segmenter)[0];
	const match = string.match(/^\s*/);
	return match ? match[0] : "";
}
function leadingAndTrailingWs(string, segmenter) {
	if (!segmenter) return [leadingWs(string), trailingWs(string)];
	if (segmenter.resolvedOptions().granularity != "word") throw new Error("The segmenter passed must have a granularity of \"word\"");
	const segments = segment(string, segmenter);
	const firstSeg = segments[0];
	const lastSeg = segments[segments.length - 1];
	return [/\s/.test(firstSeg) ? firstSeg : "", /\s/.test(lastSeg) ? lastSeg : ""];
}
// node_modules/diff/libesm/diff/word.js
const extendedWordChars = "a-zA-Z0-9_\\u{AD}\\u{C0}-\\u{D6}\\u{D8}-\\u{F6}\\u{F8}-\\u{2C6}\\u{2C8}-\\u{2D7}\\u{2DE}-\\u{2FF}\\u{1E00}-\\u{1EFF}";
const tokenizeIncludingWhitespace = new RegExp(`[${extendedWordChars}]+|\\s+|[^${extendedWordChars}]`, "ug");
var WordDiff = class extends Diff {
	equals(left, right, options) {
		if (options.ignoreCase) {
			left = left.toLowerCase();
			right = right.toLowerCase();
		}
		return left.trim() === right.trim();
	}
	tokenize(value, options = {}) {
		let parts;
		if (options.intlSegmenter) {
			const segmenter = options.intlSegmenter;
			if (segmenter.resolvedOptions().granularity != "word") throw new Error("The segmenter passed must have a granularity of \"word\"");
			parts = segment(value, segmenter);
		} else parts = value.match(tokenizeIncludingWhitespace) || [];
		const tokens = [];
		let prevPart = null;
		parts.forEach((part) => {
			if (/\s/.test(part)) {
				if (prevPart == null) tokens.push(part);
				else tokens.push(tokens.pop() + part);
			} else if (prevPart != null && /\s/.test(prevPart)) {
				if (tokens[tokens.length - 1] == prevPart) tokens.push(tokens.pop() + part);
				else tokens.push(prevPart + part);
			} else tokens.push(part);
			prevPart = part;
		});
		return tokens;
	}
	join(tokens) {
		return tokens.map((token, i) => {
			if (i == 0) return token;
			else return token.replace(/^\s+/, "");
		}).join("");
	}
	postProcess(changes, options) {
		if (!changes || options.oneChangePerToken) return changes;
		let lastKeep = null;
		let insertion = null;
		let deletion = null;
		changes.forEach((change) => {
			if (change.added) insertion = change;
			else if (change.removed) deletion = change;
			else {
				if (insertion || deletion) dedupeWhitespaceInChangeObjects(lastKeep, deletion, insertion, change, options.intlSegmenter);
				lastKeep = change;
				insertion = null;
				deletion = null;
			}
		});
		if (insertion || deletion) dedupeWhitespaceInChangeObjects(lastKeep, deletion, insertion, null, options.intlSegmenter);
		return changes;
	}
};
new WordDiff();
function dedupeWhitespaceInChangeObjects(startKeep, deletion, insertion, endKeep, segmenter) {
	if (deletion && insertion) {
		const [oldWsPrefix, oldWsSuffix] = leadingAndTrailingWs(deletion.value, segmenter);
		const [newWsPrefix, newWsSuffix] = leadingAndTrailingWs(insertion.value, segmenter);
		if (startKeep) {
			const commonWsPrefix = longestCommonPrefix(oldWsPrefix, newWsPrefix);
			startKeep.value = replaceSuffix(startKeep.value, newWsPrefix, commonWsPrefix);
			deletion.value = removePrefix(deletion.value, commonWsPrefix);
			insertion.value = removePrefix(insertion.value, commonWsPrefix);
		}
		if (endKeep) {
			const commonWsSuffix = longestCommonSuffix(oldWsSuffix, newWsSuffix);
			endKeep.value = replacePrefix(endKeep.value, newWsSuffix, commonWsSuffix);
			deletion.value = removeSuffix(deletion.value, commonWsSuffix);
			insertion.value = removeSuffix(insertion.value, commonWsSuffix);
		}
	} else if (insertion) {
		if (startKeep) {
			const ws = leadingWs(insertion.value, segmenter);
			insertion.value = insertion.value.substring(ws.length);
		}
		if (endKeep) {
			const ws = leadingWs(endKeep.value, segmenter);
			endKeep.value = endKeep.value.substring(ws.length);
		}
	} else if (startKeep && endKeep) {
		const newWsFull = leadingWs(endKeep.value, segmenter), [delWsStart, delWsEnd] = leadingAndTrailingWs(deletion.value, segmenter);
		const newWsStart = longestCommonPrefix(newWsFull, delWsStart);
		deletion.value = removePrefix(deletion.value, newWsStart);
		const newWsEnd = longestCommonSuffix(removePrefix(newWsFull, newWsStart), delWsEnd);
		deletion.value = removeSuffix(deletion.value, newWsEnd);
		endKeep.value = replacePrefix(endKeep.value, newWsFull, newWsEnd);
		startKeep.value = replaceSuffix(startKeep.value, newWsFull, newWsFull.slice(0, newWsFull.length - newWsEnd.length));
	} else if (endKeep) {
		const endKeepWsPrefix = leadingWs(endKeep.value, segmenter);
		const overlap = maximumOverlap(trailingWs(deletion.value, segmenter), endKeepWsPrefix);
		deletion.value = removeSuffix(deletion.value, overlap);
	} else if (startKeep) {
		const overlap = maximumOverlap(trailingWs(startKeep.value, segmenter), leadingWs(deletion.value, segmenter));
		deletion.value = removePrefix(deletion.value, overlap);
	}
}
var WordsWithSpaceDiff = class extends Diff {
	tokenize(value) {
		const regex = new RegExp(`(\\r?\\n)|[${extendedWordChars}]+|[^\\S\\n\\r]+|[^${extendedWordChars}]`, "ug");
		return value.match(regex) || [];
	}
};
new WordsWithSpaceDiff();
// node_modules/diff/libesm/diff/line.js
var LineDiff = class extends Diff {
	constructor() {
		super(...arguments);
		this.tokenize = tokenize;
	}
	equals(left, right, options) {
		if (options.ignoreWhitespace) {
			if (!options.newlineIsToken || !left.includes("\n")) left = left.trim();
			if (!options.newlineIsToken || !right.includes("\n")) right = right.trim();
		} else if (options.ignoreNewlineAtEof && !options.newlineIsToken) {
			if (left.endsWith("\n")) left = left.slice(0, -1);
			if (right.endsWith("\n")) right = right.slice(0, -1);
		}
		return super.equals(left, right, options);
	}
};
const lineDiff = new LineDiff();
function diffLines(oldStr, newStr, options) {
	return lineDiff.diff(oldStr, newStr, options);
}
function tokenize(value, options) {
	if (options.stripTrailingCr) value = value.replace(/\r\n/g, "\n");
	const retLines = [], linesAndNewlines = value.split(/(\n|\r\n)/);
	if (!linesAndNewlines[linesAndNewlines.length - 1]) linesAndNewlines.pop();
	for (let i = 0; i < linesAndNewlines.length; i++) {
		const line = linesAndNewlines[i];
		if (i % 2 && !options.newlineIsToken) retLines[retLines.length - 1] += line;
		else retLines.push(line);
	}
	return retLines;
}
// node_modules/diff/libesm/diff/sentence.js
function isSentenceEndPunct(char) {
	return char == "." || char == "!" || char == "?";
}
var SentenceDiff = class extends Diff {
	tokenize(value) {
		var _a;
		const result = [];
		let tokenStartI = 0;
		for (let i = 0; i < value.length; i++) {
			if (i == value.length - 1) {
				result.push(value.slice(tokenStartI));
				break;
			}
			if (isSentenceEndPunct(value[i]) && value[i + 1].match(/\s/)) {
				result.push(value.slice(tokenStartI, i + 1));
				i = tokenStartI = i + 1;
				while ((_a = value[i + 1]) === null || _a === void 0 ? void 0 : _a.match(/\s/)) i++;
				result.push(value.slice(tokenStartI, i + 1));
				tokenStartI = i + 1;
			}
		}
		return result;
	}
};
new SentenceDiff();
// node_modules/diff/libesm/diff/css.js
var CssDiff = class extends Diff {
	tokenize(value) {
		return value.split(/([{}:;,]|\s+)/);
	}
};
new CssDiff();
// node_modules/diff/libesm/diff/json.js
var JsonDiff = class extends Diff {
	constructor() {
		super(...arguments);
		this.tokenize = tokenize;
	}
	get useLongestToken() {
		return true;
	}
	castInput(value, options) {
		const { undefinedReplacement, stringifyReplacer = (k, v) => typeof v === "undefined" ? undefinedReplacement : v } = options;
		return typeof value === "string" ? value : JSON.stringify(canonicalize(value, null, null, stringifyReplacer), null, "  ");
	}
	equals(left, right, options) {
		return super.equals(left.replace(/,([\r\n])/g, "$1"), right.replace(/,([\r\n])/g, "$1"), options);
	}
};
new JsonDiff();
function canonicalize(obj, stack, replacementStack, replacer, key) {
	stack = stack || [];
	replacementStack = replacementStack || [];
	if (replacer) obj = replacer(key === void 0 ? "" : key, obj);
	let i = 0;
	for (; i < stack.length; i += 1) if (stack[i] === obj) return replacementStack[i];
	let canonicalizedObj;
	if ("[object Array]" === Object.prototype.toString.call(obj)) {
		stack.push(obj);
		canonicalizedObj = new Array(obj.length);
		replacementStack.push(canonicalizedObj);
		for (i = 0; i < obj.length; i += 1) canonicalizedObj[i] = canonicalize(obj[i], stack, replacementStack, replacer, String(i));
		stack.pop();
		replacementStack.pop();
		return canonicalizedObj;
	}
	if (obj && obj.toJSON) obj = obj.toJSON();
	if (typeof obj === "object" && obj !== null) {
		stack.push(obj);
		canonicalizedObj = {};
		replacementStack.push(canonicalizedObj);
		const sortedKeys = [];
		let key;
		for (key in obj)
 /* istanbul ignore else */
		if (Object.prototype.hasOwnProperty.call(obj, key)) sortedKeys.push(key);
		sortedKeys.sort();
		for (i = 0; i < sortedKeys.length; i += 1) {
			key = sortedKeys[i];
			canonicalizedObj[key] = canonicalize(obj[key], stack, replacementStack, replacer, key);
		}
		stack.pop();
		replacementStack.pop();
	} else canonicalizedObj = obj;
	return canonicalizedObj;
}
// node_modules/diff/libesm/diff/array.js
var ArrayDiff = class extends Diff {
	tokenize(value) {
		return value.slice();
	}
	join(value) {
		return value;
	}
	removeEmpty(value) {
		return value;
	}
};
new ArrayDiff();
// node_modules/diff/libesm/patch/create.js
function structuredPatch(oldFileName, newFileName, oldStr, newStr, oldHeader, newHeader, options) {
	let optionsObj;
	if (!options) optionsObj = {};
	else if (typeof options === "function") optionsObj = { callback: options };
	else optionsObj = options;
	if (typeof optionsObj.context === "undefined") optionsObj.context = 4;
	const context = optionsObj.context;
	if (optionsObj.newlineIsToken) throw new Error("newlineIsToken may not be used with patch-generation functions, only with diffing functions");
	if (!optionsObj.callback) return diffLinesResultToPatch(diffLines(oldStr, newStr, optionsObj));
	else {
		const { callback } = optionsObj;
		diffLines(oldStr, newStr, Object.assign(Object.assign({}, optionsObj), { callback: (diff) => {
			const patch = diffLinesResultToPatch(diff);
			callback(patch);
		} }));
	}
	function diffLinesResultToPatch(diff) {
		if (!diff) return;
		diff.push({
			value: "",
			lines: []
		});
		function contextLines(lines) {
			return lines.map(function(entry) {
				return " " + entry;
			});
		}
		const hunks = [];
		let oldRangeStart = 0, newRangeStart = 0, curRange = [], oldLine = 1, newLine = 1;
		for (let i = 0; i < diff.length; i++) {
			const current = diff[i], lines = current.lines || splitLines(current.value);
			current.lines = lines;
			if (current.added || current.removed) {
				if (!oldRangeStart) {
					const prev = diff[i - 1];
					oldRangeStart = oldLine;
					newRangeStart = newLine;
					if (prev) {
						curRange = context > 0 ? contextLines(prev.lines.slice(-context)) : [];
						oldRangeStart -= curRange.length;
						newRangeStart -= curRange.length;
					}
				}
				for (const line of lines) curRange.push((current.added ? "+" : "-") + line);
				if (current.added) newLine += lines.length;
				else oldLine += lines.length;
			} else {
				if (oldRangeStart) {
					if (lines.length <= context * 2 && i < diff.length - 2) for (const line of contextLines(lines)) curRange.push(line);
					else {
						const contextSize = Math.min(lines.length, context);
						for (const line of contextLines(lines.slice(0, contextSize))) curRange.push(line);
						const hunk = {
							oldStart: oldRangeStart,
							oldLines: oldLine - oldRangeStart + contextSize,
							newStart: newRangeStart,
							newLines: newLine - newRangeStart + contextSize,
							lines: curRange
						};
						hunks.push(hunk);
						oldRangeStart = 0;
						newRangeStart = 0;
						curRange = [];
					}
				}
				oldLine += lines.length;
				newLine += lines.length;
			}
		}
		for (const hunk of hunks) for (let i = 0; i < hunk.lines.length; i++) if (hunk.lines[i].endsWith("\n")) hunk.lines[i] = hunk.lines[i].slice(0, -1);
		else {
			hunk.lines.splice(i + 1, 0, "\\ No newline at end of file");
			i++;
		}
		return {
			oldFileName,
			newFileName,
			oldHeader,
			newHeader,
			hunks
		};
	}
}
/**
* Split `text` into an array of lines, including the trailing newline character (where present)
*/
function splitLines(text) {
	const hasTrailingNl = text.endsWith("\n");
	const result = text.split("\n").map((line) => line + "\n");
	if (hasTrailingNl) result.pop();
	else result.push(result.pop().slice(0, -1));
	return result;
}
// src/urls.ts
/** The one host this provider serves; legacy `<org>.visualstudio.com` addresses are read as this host. */
const AZURE_HOST = "dev.azure.com";
/** Forge family name stored in every repository this provider returns. */
const AZURE_FORGE = "azure";
const SEGMENT = /^[^/\\?#]+$/;
function decoded(segment) {
	try {
		const value = decodeURIComponent(segment);
		return SEGMENT.test(value) ? value : void 0;
	} catch {
		return;
	}
}
function location(organization, project, repository) {
	if (organization === void 0 || project === void 0 || repository === void 0) return void 0;
	const parts = [
		decoded(organization),
		decoded(project),
		decoded(repository.replace(/\.git$/, ""))
	];
	if (parts.some((part) => part === void 0 || part === "")) return void 0;
	return {
		organization: parts[0],
		project: parts[1],
		repository: parts[2]
	};
}
/**
* Split the path of an HTTPS address into organization, project, and what follows `_git/<repository>`.
* `dev.azure.com/<org>/<project>/_git/<repo>` and `<org>.visualstudio.com[/DefaultCollection]/<project>/_git/<repo>`
* are both accepted; a repository named after its project may omit the project (`<org>/_git/<repo>`).
*/
function parseHttps(url) {
	const host = url.hostname.toLowerCase();
	let segments = url.pathname.split("/").filter((segment) => segment !== "");
	let organization;
	if (host === "dev.azure.com") {
		organization = segments[0];
		segments = segments.slice(1);
	} else if (host.endsWith(".visualstudio.com") && host !== "vs-ssh.visualstudio.com") {
		organization = host.slice(0, -17);
		if (segments[0]?.toLowerCase() === "defaultcollection") segments = segments.slice(1);
	} else return;
	const git = segments.indexOf("_git");
	if (git < 0 || git > 1) return void 0;
	const repository = segments[git + 1];
	const found = location(organization, git === 1 ? segments[0] : repository, repository);
	return found === void 0 ? void 0 : {
		location: found,
		rest: segments.slice(git + 2)
	};
}
/**
* Read a Git remote URL as an Azure Repos repository.
* @param url - HTTPS or SSH remote, such as `https://org@dev.azure.com/org/project/_git/repo` or
* `git@ssh.dev.azure.com:v3/org/project/repo`.
* @returns the repository's location, or undefined when the URL is not an Azure Repos remote.
*/
function parseRemoteUrl(url) {
	const ssh = /^(?:ssh:\/\/)?[^@/\s]+@(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com)(?::\d+)?[:/]v3\/([^/\s]+)\/([^/\s]+)\/([^/\s]+?)\/?$/i.exec(url.trim());
	if (ssh !== null) return location(ssh[1], ssh[2], ssh[3]);
	let parsed;
	try {
		parsed = new URL(url.trim());
	} catch {
		return;
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return void 0;
	const found = parseHttps(parsed);
	return found === void 0 || found.rest.length > 0 ? void 0 : found.location;
}
/**
* Read a pull request web URL.
* @param url - page address, such as `https://dev.azure.com/org/project/_git/repo/pullrequest/12`.
* @returns the repository's location and the pull request number, or undefined for any other URL.
*/
function parsePullRequestUrl(url) {
	let parsed;
	try {
		parsed = new URL(url.trim());
	} catch {
		return;
	}
	if (parsed.protocol !== "https:") return void 0;
	const found = parseHttps(parsed);
	if (found === void 0 || found.rest.length !== 2 || found.rest[0]?.toLowerCase() !== "pullrequest") return void 0;
	const digits = found.rest[1] ?? "";
	if (!/^[1-9]\d{0,14}$/.test(digits)) return void 0;
	return {
		...found.location,
		number: Number(digits)
	};
}
/** The forge repository of a location: the owner is `<organization>/<project>`. */
function repositoryOf(found) {
	return {
		forge: AZURE_FORGE,
		host: AZURE_HOST,
		owner: `${found.organization}/${found.project}`,
		name: found.repository
	};
}
/**
* The location a forge repository names.
* @throws when the owner is not `<organization>/<project>`.
*/
function locationOf(repository) {
	const slash = repository.owner.indexOf("/");
	if (slash <= 0 || slash === repository.owner.length - 1 || repository.owner.includes("/", slash + 1) || repository.name === "") throw new Error(`forge-azure: invalid repository ${JSON.stringify(`${repository.owner}/${repository.name}`)}`);
	return {
		organization: repository.owner.slice(0, slash),
		project: repository.owner.slice(slash + 1),
		repository: repository.name
	};
}
const encode = encodeURIComponent;
/** Web page of a repository. */
function repositoryUrl(found) {
	return `https://${AZURE_HOST}/${encode(found.organization)}/${encode(found.project)}/_git/${encode(found.repository)}`;
}
/** Canonical web page of a pull request. */
function pullRequestUrl(ref) {
	return `${repositoryUrl(locationOf(ref.repository))}/pullrequest/${ref.number}`;
}
/** REST base of an organization: `https://dev.azure.com/<org>/_apis`. */
function organizationApi(organization) {
	return `https://${AZURE_HOST}/${encode(organization)}/_apis`;
}
/** REST base of a project: `https://dev.azure.com/<org>/<project>/_apis`. */
function projectApi(found) {
	return `https://${AZURE_HOST}/${encode(found.organization)}/${encode(found.project)}/_apis`;
}
/** REST base of a repository's Git resources. */
function repositoryApi(found) {
	return `${projectApi(found)}/git/repositories/${encode(found.repository)}`;
}
/** REST base of one pull request. */
function pullRequestApi(ref) {
	return `${repositoryApi(locationOf(ref.repository))}/pullrequests/${ref.number}`;
}
/** Whether `value` is a full SHA-1 object name. */
function isCommit(value) {
	return /^[0-9a-f]{40}$/.test(value);
}
/** Strip `refs/heads/` from a branch ref name. */
function branchName(ref) {
	return ref.startsWith("refs/heads/") ? ref.slice(11) : ref;
}
// src/diff.ts
/** Changed paths one `diffs/commits` page asks for. */
const PAGE = 100;
const relative = (path) => path.replace(/^\/+/, "");
/**
* List the files that differ between two commits.
* @param api - Azure DevOps reads.
* @param ref - pull request whose repository holds both commits.
* @param base - full object name of the old commit.
* @param head - full object name of the new commit.
* @param common - true to compare `head` with its merge base with `base`, as a pull request does.
* @param limit - most files to list; more is a `too-large` failure.
* @param signal - cancellation of the read.
* @returns the files in path order and the old side's commit, or why Azure DevOps did not list them.
*/
async function changedFiles(api, ref, base, head, common, limit, signal) {
	const files = /* @__PURE__ */ new Map();
	let oldCommit = base;
	for (let skip = 0;; skip += PAGE) {
		const read = await api.get(`${repositoryApi(locationOf(ref.repository))}/diffs/commits?baseVersion=${base}&baseVersionType=commit&targetVersion=${head}&targetVersionType=commit&diffCommonCommit=${common}&$top=${PAGE}&$skip=${skip}`, signal);
		if (!read.ok) return read.failure;
		const body = object(read.body);
		if (common) {
			const merged = text(body.commonCommit);
			if (merged === void 0 || !isCommit(merged)) return {
				code: "unavailable",
				message: "Azure DevOps named no merge base commit"
			};
			oldCommit = merged;
		}
		const changes = objects(body.changes);
		for (const change of changes) {
			const item = object(change.item);
			if (item.isFolder === true || (text(item.gitObjectType) ?? "blob") !== "blob") continue;
			const path = text(item.path);
			if (path === void 0) continue;
			const type = (text(change.changeType) ?? "edit").toLowerCase();
			const original = text(change.sourceServerItem) ?? text(change.originalPath);
			const kind = type.includes("delete") ? "delete" : type.includes("add") ? "add" : type.includes("rename") ? "rename" : "edit";
			files.set(path, {
				path: relative(path),
				oldPath: relative(kind === "rename" && original !== void 0 ? original : path),
				kind
			});
			if (files.size > limit) return {
				code: "too-large",
				message: `the change touches more than ${limit} files`
			};
		}
		if (body.allChangesIncluded !== false || changes.length === 0) break;
	}
	const sorted = [...files.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
	return {
		base: oldCommit,
		files: sorted
	};
}
/**
* Read one file at a commit.
* @param api - Azure DevOps reads.
* @param ref - pull request whose repository holds the file.
* @param commit - full object name of the commit.
* @param path - repository-relative path.
* @param signal - cancellation of the read.
* @returns the text, a binary marker, or why Azure DevOps did not return the file.
*/
async function readFile(api, ref, commit, path, signal) {
	const read = await api.get(`${repositoryApi(locationOf(ref.repository))}/items?path=${encodeURIComponent(`/${relative(path)}`)}&versionDescriptor.version=${commit}&versionDescriptor.versionType=commit&includeContent=true&includeContentMetadata=true&$format=json`, signal);
	if (!read.ok) return read.failure;
	const body = object(read.body);
	if (object(body.contentMetadata).isBinary === true) return { binary: true };
	if (typeof body.content !== "string") return (numeric(body.size) ?? 0) === 0 ? { text: "" } : {
		code: "unavailable",
		message: `Azure DevOps returned no content for ${path}`
	};
	return body.content.includes("\0") ? { binary: true } : { text: body.content };
}
/**
* Hunks of a text change in unified format with three lines of context.
* @param oldName - old side's name, such as `a/<path>` or `/dev/null`.
* @param newName - new side's name.
* @param before - old text.
* @param after - new text.
* @returns the `---`/`+++` header and hunks, ending with a newline; empty when the texts are equal.
*/
function textPatch(oldName, newName, before, after) {
	const patch = structuredPatch(oldName, newName, before, after, "", "", { context: 3 });
	if (patch.hunks.length === 0) return "";
	const start = (line, count) => count === 0 ? line - 1 : line;
	return `--- ${oldName}\n+++ ${newName}\n${patch.hunks.map((hunk) => `@@ -${start(hunk.oldStart, hunk.oldLines)},${hunk.oldLines} +${start(hunk.newStart, hunk.newLines)},${hunk.newLines} @@\n${hunk.lines.join("\n")}\n`).join("")}`;
}
/** One file's section of a Git patch. */
function filePatch(file, before, after) {
	const header = [`diff --git a/${file.oldPath} b/${file.path}`];
	if (file.kind === "add") header.push("new file mode 100644");
	else if (file.kind === "delete") header.push("deleted file mode 100644");
	else if (file.kind === "rename") header.push(`rename from ${file.oldPath}`, `rename to ${file.path}`);
	const oldName = file.kind === "add" ? "/dev/null" : `a/${file.oldPath}`;
	const newName = file.kind === "delete" ? "/dev/null" : `b/${file.path}`;
	if (before !== null && "binary" in before || after !== null && "binary" in after) return `${header.join("\n")}\nBinary files ${oldName} and ${newName} differ\n`;
	const beforeText = before !== null && "text" in before ? before.text : "";
	const afterText = after !== null && "text" in after ? after.text : "";
	return `${header.join("\n")}\n${textPatch(oldName, newName, beforeText, afterText)}`;
}
/**
* Build the patch between two commits as one unified patch with `a/` and `b/` prefixes.
* @param api - Azure DevOps reads.
* @param ref - pull request whose repository holds both commits.
* @param base - full object name of the old commit.
* @param head - full object name of the new commit.
* @param common - true to compare `head` with its merge base with `base`.
* @param limits - bounds of the patch.
* @param signal - cancellation of the read.
* @returns the patch, empty when nothing differs, or why it could not be built.
*/
async function buildPatch(api, ref, base, head, common, limits, signal) {
	const listed = await changedFiles(api, ref, base, head, common, limits.maxDiffFiles, signal);
	if ("code" in listed) return listed;
	const sections = /* @__PURE__ */ new Map();
	let bytes = 0;
	let failed;
	const local = new AbortController();
	const combined = AbortSignal.any([signal, local.signal]);
	const fail = (failure) => {
		failed ??= failure;
		local.abort();
	};
	try {
		await pool(listed.files, limits.maxConcurrentRequests, async (file) => {
			if (failed !== void 0) return;
			const [before, after] = await Promise.all([file.kind === "add" ? null : readFile(api, ref, listed.base, file.oldPath, combined), file.kind === "delete" ? null : readFile(api, ref, head, file.path, combined)]);
			for (const side of [before, after]) {
				if (side === null) continue;
				if ("code" in side) return fail(side.code === "not-found" ? {
					code: "unavailable",
					message: side.message
				} : side);
				if ("text" in side) bytes += Buffer.byteLength(side.text);
			}
			if (bytes > limits.maxDiffBytes) return fail({
				code: "too-large",
				message: "the changed files exceed maxDiffBytes"
			});
			sections.set(file, filePatch(file, before, after));
		});
	} catch (error) {
		if (failed === void 0) throw error;
	}
	if (signal.aborted) throw signal.reason;
	if (failed !== void 0) return failed;
	const patch = listed.files.map((file) => sections.get(file) ?? "").join("");
	return Buffer.byteLength(patch) > limits.maxDiffBytes ? {
		code: "too-large",
		message: "the patch exceeds maxDiffBytes"
	} : patch;
}
// src/status.ts
/** Lifecycle state from the pull request's `status`. */
function stateOf(pullRequest) {
	const status = text(pullRequest.status);
	return status === "completed" ? "merged" : status === "abandoned" ? "closed" : "open";
}
/** Conflict status from `mergeStatus`; anything but a finished merge check is unknown. */
function mergeabilityOf(pullRequest) {
	const status = text(pullRequest.mergeStatus);
	return status === "succeeded" ? "mergeable" : status === "conflicts" ? "conflicting" : "unknown";
}
/** How readers know an identity: its sign-in name, else its display name. */
function loginOf(identity) {
	const value = object(identity);
	return text(value.uniqueName) ?? text(value.displayName) ?? null;
}
/**
* A reviewer's verdict from their vote: 10 approves, 5 approves with suggestions, -5 waits for the author, -10 rejects.
* Both negative votes read as changes requested; no vote is null.
*/
function verdictOf(vote) {
	const value = numeric(vote) ?? 0;
	return value > 0 ? "approved" : value < 0 ? "changes-requested" : null;
}
/** The reviewers of a pull request without its author. */
function reviewersOf(pullRequest) {
	const author = text(object(pullRequest.createdBy).id);
	const reviewers = [];
	for (const reviewer of objects(pullRequest.reviewers)) {
		const login = loginOf(reviewer);
		if (login === null || author !== void 0 && text(reviewer.id) === author) continue;
		const verdict = verdictOf(reviewer.vote);
		reviewers.push({
			kind: reviewer.isContainer === true ? "team" : "user",
			login,
			avatarUrl: null,
			requested: verdict === null,
			codeOwner: false,
			verdict,
			reviewedSha: null
		});
	}
	return reviewers;
}
/**
* Aggregate review outcome: changes requested once any reviewer waits or rejects; else review required while a required
* reviewer has not voted; else approved once anyone approved.
*/
function reviewDecisionOf(pullRequest) {
	const reviewers = objects(pullRequest.reviewers);
	const votes = reviewers.map((reviewer) => numeric(reviewer.vote) ?? 0);
	if (votes.some((vote) => vote < 0)) return "changes-requested";
	if (reviewers.some((reviewer) => reviewer.isRequired === true && (numeric(reviewer.vote) ?? 0) === 0)) return "review-required";
	return votes.some((vote) => vote > 0) ? "approved" : "none";
}
const STATUS_STATES = {
	succeeded: "success",
	failed: "failure",
	error: "failure",
	pending: "pending",
	notApplicable: "skipped",
	notSet: "pending"
};
const POLICY_STATES = {
	approved: "success",
	rejected: "failure",
	broken: "failure",
	running: "pending",
	queued: "pending",
	notApplicable: "skipped"
};
/**
* Checks from pull request statuses, the newest of each context, then from policy evaluations (build validation,
* required reviewers and the other branch policies).
* @param statuses - `pullrequests/{id}/statuses` values.
* @param evaluations - `policy/evaluations` values.
*/
function checksOf(statuses, evaluations) {
	const newest = /* @__PURE__ */ new Map();
	for (const status of statuses) {
		const context = object(status.context);
		const name = text(context.name);
		if (name === void 0) continue;
		const key = `${text(context.genre) ?? ""}/${name}`;
		const kept = newest.get(key);
		if (kept === void 0 || (numeric(status.id) ?? 0) >= (numeric(kept.id) ?? 0)) newest.set(key, status);
	}
	const checks = [];
	for (const status of newest.values()) {
		const context = object(status.context);
		const state = STATUS_STATES[text(status.state) ?? ""] ?? "neutral";
		const at = text(status.updatedDate) ?? text(status.creationDate) ?? null;
		checks.push({
			name: text(status.description) ?? text(context.name),
			state,
			url: text(status.targetUrl) ?? null,
			workflow: text(context.genre) ?? null,
			startedAt: text(status.creationDate) ?? null,
			completedAt: state === "pending" ? null : at,
			rerun: null
		});
	}
	for (const evaluation of evaluations) {
		const configuration = object(evaluation.configuration);
		if (configuration.isEnabled === false || configuration.isDeleted === true) continue;
		const type = text(object(configuration.type).displayName);
		const name = text(object(configuration.settings).displayName) ?? type;
		if (name === void 0) continue;
		const state = POLICY_STATES[text(evaluation.status) ?? ""] ?? "neutral";
		checks.push({
			name,
			state: state === "failure" && configuration.isBlocking === false ? "neutral" : state,
			url: null,
			workflow: type ?? null,
			startedAt: text(evaluation.startedDate) ?? null,
			completedAt: state === "pending" ? null : text(evaluation.completedDate) ?? null,
			rerun: null
		});
	}
	return checks;
}
/** Combined outcome of the checks. */
function rollupOf(checks) {
	if (checks.some((check) => check.state === "failure")) return "failure";
	if (checks.some((check) => check.state === "pending")) return "pending";
	return checks.some((check) => check.state === "success") ? "success" : "none";
}
/** Whether a thread is a discussion people wrote, not a deleted thread or a system message such as a vote or a push. */
function isDiscussion(thread) {
	if (thread.isDeleted === true) return false;
	return objects(thread.comments).some((comment) => comment.isDeleted !== true && (text(comment.commentType) ?? "text") === "text");
}
const RESOLVED = /* @__PURE__ */ new Set([
	"fixed",
	"wontFix",
	"closed",
	"byDesign"
]);
/** Whether a discussion thread is resolved; a thread without a status, as a plain comment, counts as resolved. */
function isResolved(thread) {
	const status = text(thread.status);
	return status === void 0 || RESOLVED.has(status);
}
/**
* Build the snapshot of a pull request. This provider is read-only, so the snapshot offers no merge, branch update,
* review request or rerun. Azure DevOps reports neither changed line counts nor an update time: the counts are 0, and
* the update time is the newest of the creation time, the close time, and the times of threads and statuses.
*/
function snapshotOf(parts) {
	const { ref, pullRequest } = parts;
	const state = stateOf(pullRequest);
	const checks = checksOf(parts.statuses, parts.evaluations);
	const discussions = (parts.threads ?? []).filter(isDiscussion);
	const times = [
		text(pullRequest.creationDate),
		text(pullRequest.closedDate),
		...(parts.threads ?? []).map((thread) => text(thread.lastUpdatedDate)),
		...parts.statuses.map((status) => text(status.updatedDate) ?? text(status.creationDate))
	].filter((time) => time !== void 0 && !Number.isNaN(Date.parse(time)));
	const updatedAt = times.reduce((latest, time) => Date.parse(time) > Date.parse(latest) ? time : latest, times[0] ?? (/* @__PURE__ */ new Date(0)).toISOString());
	const baseSha = text(object(pullRequest.lastMergeTargetCommit).commitId);
	return {
		ref,
		url: pullRequestUrl(ref),
		title: text(pullRequest.title) ?? `Pull request ${ref.number}`,
		state,
		draft: pullRequest.isDraft === true,
		author: loginOf(pullRequest.createdBy),
		headBranch: branchName(text(pullRequest.sourceRefName) ?? ""),
		headSha: text(object(pullRequest.lastMergeSourceCommit).commitId) ?? "",
		baseBranch: branchName(text(pullRequest.targetRefName) ?? ""),
		...baseSha === void 0 ? {} : { baseSha },
		additions: 0,
		deletions: 0,
		mergeability: state === "open" ? mergeabilityOf(pullRequest) : "unknown",
		mergeReady: false,
		mergeMethods: [],
		branchUpdates: [],
		reviewDecision: reviewDecisionOf(pullRequest),
		reviewers: reviewersOf(pullRequest),
		reviewersTruncated: false,
		canRequestReviews: false,
		checks,
		checksRollup: rollupOf(checks),
		checksTruncated: false,
		canRerunChecks: false,
		unresolvedThreads: discussions.filter((thread) => !isResolved(thread)).length,
		threadsTruncated: parts.threads === null,
		closingIssues: [],
		closingIssuesTruncated: false,
		updatedAt,
		closedAt: state === "open" ? null : text(pullRequest.closedDate) ?? null
	};
}
// src/review.ts
/** Read `pullrequests/{id}/iterations` values as iteration id to source commit. */
function iterationCommits(iterations) {
	const commits = /* @__PURE__ */ new Map();
	for (const iteration of iterations) {
		const id = numeric(iteration.id);
		const commit = text(object(iteration.sourceRefCommit).commitId);
		if (id !== void 0 && commit !== void 0 && isCommit(commit)) commits.set(id, commit);
	}
	return commits;
}
function lines(start, end) {
	const first = numeric(object(start).line);
	const last = numeric(object(end).line) ?? first;
	if (first === void 0 || last === void 0 || first < 1 || last < first) return void 0;
	return {
		startLine: first,
		endLine: last
	};
}
/** The side and lines of a thread position, or undefined for a position on the whole file. */
function position(context, prefix) {
	const key = (name) => prefix === "" ? name : `${prefix}${name[0]?.toUpperCase()}${name.slice(1)}`;
	const right = lines(context[key("rightFileStart")], context[key("rightFileEnd")]);
	if (right !== void 0) return {
		side: "R",
		...right
	};
	const left = lines(context[key("leftFileStart")], context[key("leftFileEnd")]);
	return left === void 0 ? void 0 : {
		side: "L",
		...left
	};
}
/**
* Map one discussion thread on a file. A thread written on the newest iteration, or one Azure DevOps tracked to it, is
* placed on the head commit; any other is outdated and keeps only the position it was written at.
* @param ref - pull request the thread belongs to.
* @param thread - one `threads` value that {@link isDiscussion} accepts.
* @param headSha - head commit of the read.
* @param iterations - source commit of each iteration.
* @returns the thread, or undefined for a discussion on the pull request as a whole, which has no file to show it on.
*/
function threadOf(ref, thread, headSha, iterations) {
	const id = numeric(thread.id);
	const context = object(thread.threadContext);
	const path = text(context.filePath)?.replace(/^\/+/, "");
	if (id === void 0 || path === void 0) return void 0;
	const latest = Math.max(0, ...iterations.keys());
	const pullRequestContext = object(thread.pullRequestThreadContext);
	const written = numeric(object(pullRequestContext.iterationContext).secondComparingIteration);
	const tracking = object(pullRequestContext.trackingCriteria);
	const tracked = numeric(tracking.secondComparingIteration);
	const now = position(context, "");
	const then = position(tracking, "orig") ?? now;
	const writtenCommit = written === void 0 ? void 0 : iterations.get(written);
	const onHead = written === void 0 || written === latest || tracked === latest;
	const anchor = (commit, at) => commit === void 0 || at === void 0 ? null : {
		commit,
		startLine: at.startLine,
		endLine: at.endLine
	};
	const url = `${pullRequestUrl(ref)}?discussionId=${id}`;
	const comments = [];
	for (const comment of objects(thread.comments)) {
		if (comment.isDeleted === true || (text(comment.commentType) ?? "text") !== "text") continue;
		const login = loginOf(comment.author);
		comments.push({
			id: `${id}:${numeric(comment.id) ?? comments.length + 1}`,
			author: login === null ? null : {
				login,
				avatarUrl: null,
				bot: false
			},
			body: typeof comment.content === "string" ? comment.content : "",
			createdAt: text(comment.publishedDate) ?? text(comment.lastUpdatedDate) ?? (/* @__PURE__ */ new Date(0)).toISOString(),
			pending: false,
			url,
			viewerCanEdit: false,
			viewerCanDelete: false
		});
	}
	if (comments.length === 0) return void 0;
	return {
		id: String(id),
		path,
		side: (onHead ? now : then)?.side ?? "R",
		subject: now === void 0 && then === void 0 ? "file" : "line",
		current: onHead ? anchor(headSha, now) : null,
		original: anchor(writtenCommit ?? (onHead ? headSha : void 0), then),
		diffHunk: null,
		resolved: isResolved(thread),
		viewerCanReply: false,
		viewerCanResolve: false,
		comments
	};
}
/**
* Map the threads of a pull request read at one head commit. The provider is read-only, so no thread or comment can be
* written and there is no pending review.
* @param ref - pull request.
* @param threads - `threads` values.
* @param iterations - `iterations` values.
* @param headSha - head commit of the read.
* @param viewer - login the provider read as, or null.
* @param limit - most threads returned.
*/
function reviewDataOf(ref, threads, iterations, headSha, viewer, limit) {
	const commits = iterationCommits(iterations);
	const mapped = [];
	for (const thread of threads) {
		if (!isDiscussion(thread)) continue;
		const found = threadOf(ref, thread, headSha, commits);
		if (found !== void 0) mapped.push(found);
	}
	return {
		headSha,
		viewer,
		threads: mapped.slice(0, limit),
		truncated: mapped.length > limit,
		pendingReview: null,
		viewerCanReview: false,
		reviewEvents: []
	};
}
// src/viewer.ts
/** The lists this provider reads, which never share a pull request. */
const VIEWER_FILTERS = /* @__PURE__ */ new Set([
	"review-requested",
	"authored",
	"involved"
]);
/**
* Read who the token belongs to in an organization.
* @param api - Azure DevOps reads.
* @param organization - organization name.
* @param signal - cancellation of the read.
*/
async function readViewer(api, organization, signal) {
	const read = await api.get(`${organizationApi(organization)}/connectionData`, signal, "7.1-preview.1");
	if (!read.ok) return read.failure;
	const user = object(object(read.body).authenticatedUser);
	const id = text(user.id);
	const login = text(object(object(user.properties).Account).$value) ?? text(user.providerDisplayName);
	if (id === void 0 || login === void 0 || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(id)) return {
		code: "unauthenticated",
		message: `Azure DevOps did not say who the token belongs to in ${organization}`
	};
	return {
		id,
		login
	};
}
/**
* Map one pull request of a search to a summary. Azure DevOps reports no update time and no checks in a search, so
* the summary's update time is the creation time and its checks read as none.
*/
function summaryOf(pullRequest, viewer) {
	const repository = object(pullRequest.repository);
	const project = text(object(repository.project).name);
	const name = text(repository.name);
	const number = numeric(pullRequest.pullRequestId);
	const organization = /^https:\/\/dev\.azure\.com\/([^/]+)\//.exec(text(repository.url) ?? text(pullRequest.url) ?? "")?.[1];
	if (project === void 0 || name === void 0 || number === void 0 || organization === void 0) return void 0;
	const ref = {
		repository: {
			forge: AZURE_FORGE,
			host: AZURE_HOST,
			owner: `${decodeURIComponent(organization)}/${project}`,
			name
		},
		number
	};
	const mine = objects(pullRequest.reviewers).find((reviewer) => text(reviewer.id) === viewer.id);
	const verdict = mine === void 0 ? null : verdictOf(mine.vote);
	const author = loginOf(pullRequest.createdBy);
	const createdAt = text(pullRequest.creationDate) ?? (/* @__PURE__ */ new Date(0)).toISOString();
	return {
		created: Date.parse(createdAt) || 0,
		summary: {
			ref,
			url: pullRequestUrl(ref),
			title: text(pullRequest.title) ?? `Pull request ${number}`,
			draft: pullRequest.isDraft === true,
			author: author === null ? null : {
				login: author,
				avatarUrl: null,
				bot: false
			},
			headSha: text(object(pullRequest.lastMergeSourceCommit).commitId) ?? "",
			checksRollup: "none",
			reviewDecision: reviewDecisionOf(pullRequest),
			viewerReview: verdict === null ? null : {
				verdict,
				reviewedSha: null
			},
			viewerRequest: mine !== void 0 && verdict === null ? { team: null } : null,
			closingIssues: [],
			closingIssuesTruncated: false,
			updatedAt: createdAt
		}
	};
}
/**
* Read one list across the scope, newest first.
*
* `authored` searches by creator. `review-requested` and `involved` both search by reviewer, without the user's own
* pull requests: the first keeps those the user has not voted on, the second those the user voted on. Reviews asked of
* a team the user belongs to are not listed, because the search matches only the user's own identity.
* @param api - Azure DevOps reads.
* @param scope - organizations or the one repository to search.
* @param filter - the list.
* @param max - most pull requests one search returns.
* @param signal - cancellation of the read.
* @returns every match up to `max` per organization, and the login read as; or the first failure.
*/
async function readViewerList(api, scope, filter, max, signal) {
	const organizations = scope.repository === null ? scope.organizations : [locationOf(scope.repository).organization];
	const listed = [];
	let login = "";
	for (const organization of organizations) {
		const viewer = await readViewer(api, organization, signal);
		if ("code" in viewer) return viewer;
		login ||= viewer.login;
		const base = scope.repository === null ? `${organizationApi(organization)}/git/pullrequests` : `${repositoryApi(locationOf(scope.repository))}/pullrequests`;
		const who = filter === "authored" ? `searchCriteria.creatorId=${viewer.id}` : `searchCriteria.reviewerId=${viewer.id}`;
		const read = await api.get(`${base}?searchCriteria.status=active&${who}&$top=${max}`, signal);
		if (!read.ok) return read.failure;
		for (const pullRequest of objects(object(read.body).value)) {
			const authored = text(object(pullRequest.createdBy).id) === viewer.id;
			if (filter !== "authored" && authored) continue;
			const item = summaryOf(pullRequest, viewer);
			if (item === void 0) continue;
			if (filter === "review-requested" && item.summary.viewerRequest === null) continue;
			if (filter === "involved" && item.summary.viewerRequest !== null) continue;
			listed.push(item);
		}
	}
	listed.sort((a, b) => b.created - a.created);
	return {
		viewer: login,
		items: listed.map((item) => item.summary)
	};
}
/** Read one list as a page of at most `limit` pull requests. */
async function viewerPage(api, scope, filter, limit, max, signal) {
	const read = await readViewerList(api, scope, filter, max, signal);
	if ("code" in read) return read;
	return {
		viewer: read.viewer,
		items: read.items.slice(0, limit),
		total: read.items.length
	};
}
// src/provider.ts
/** Open pull requests a head lookup returns. */
const HEAD_LOOKUP = 20;
/** Labels one description lists. */
const LABELS = 50;
const READ_ONLY = "forge-azure is read-only: do this on the pull request page in Azure DevOps";
/**
* Canonical identity of a change request, spelled as the forge registry's `changeRequestKey` spells it; this package
* imports nothing from the registry at run time.
*/
function changeRequestKey(ref) {
	const { forge, host, owner, name } = ref.repository;
	return `${forge}:${host}/${owner}/${name}#${ref.number}`.toLowerCase();
}
/** Reads Azure Repos pull requests on dev.azure.com; every write is refused. */
var AzureProvider = class {
	api;
	organizations;
	limits;
	forge = AZURE_FORGE;
	hosts = [AZURE_HOST];
	label = "Azure DevOps";
	changeRequestNoun = "pull-request";
	viewer;
	/**
	* @param api - Azure DevOps reads.
	* @param organizations - organizations whose pull requests the viewer lists read.
	* @param limits - read bounds.
	*/
	constructor(api, organizations, limits) {
		this.api = api;
		this.organizations = organizations;
		this.limits = limits;
		this.viewer = {
			hosts: this.hosts,
			filters: VIEWER_FILTERS,
			maxItems: limits.maxViewerItems
		};
	}
	repositoryFromRemote(url) {
		const found = parseRemoteUrl(url);
		return found === void 0 ? void 0 : repositoryOf(found);
	}
	changeRequestFromUrl(url) {
		const found = parsePullRequestUrl(url);
		return found === void 0 ? void 0 : {
			repository: repositoryOf(found),
			number: found.number
		};
	}
	changeRequestUrl(ref) {
		return pullRequestUrl(ref);
	}
	async fetch(refs, signal) {
		const results = /* @__PURE__ */ new Map();
		await pool(refs, this.limits.maxConcurrentRequests, async (ref) => {
			results.set(changeRequestKey(ref), await this.snapshot(ref, signal));
		});
		return results;
	}
	async findByHead(repository, branch, signal) {
		const refused = this.hostFailure(repository.host);
		if (refused !== void 0) throw new Error(refused.message);
		const base = repositoryApi(locationOf(repository));
		const [settings, listing] = await Promise.all([this.api.get(base, signal), this.api.get(`${base}/pullrequests?searchCriteria.status=active&searchCriteria.sourceRefName=${encodeURIComponent(`refs/heads/${branch}`)}&$top=${HEAD_LOOKUP}`, signal)]);
		if (!settings.ok) throw new Error(`forge-azure: head branch lookup failed: ${settings.failure.message}`);
		if (!listing.ok) throw new Error(`forge-azure: head branch lookup failed: ${listing.failure.message}`);
		if (branchName(text(object(settings.body).defaultBranch) ?? "") === branch) return [];
		const found = [];
		for (const pullRequest of objects(object(listing.body).value)) {
			const number = pullRequest.pullRequestId;
			if (typeof number === "number" && pullRequest.forkSource == null) found.push({
				repository,
				number
			});
		}
		return found;
	}
	async readiness(host, signal) {
		const refused = this.hostFailure(host);
		if (refused !== void 0) return {
			state: "unavailable",
			message: refused.message,
			signIn: null
		};
		const organization = this.organizations[0];
		const read = organization === void 0 ? await this.api.get(`https://${AZURE_HOST}/_apis/resourceAreas`, signal, "7.1-preview.1") : await readViewer(this.api, organization, signal);
		const failure = "ok" in read ? read.ok ? void 0 : read.failure : "code" in read ? read : void 0;
		if (failure === void 0) return {
			state: "ready",
			message: null,
			signIn: null
		};
		return {
			state: failure.code === "unauthenticated" ? "unauthenticated" : "unavailable",
			message: failure.message,
			signIn: null
		};
	}
	async markReady() {
		return {
			code: "failed",
			message: READ_ONLY
		};
	}
	async merge() {
		return {
			code: "failed",
			message: READ_ONLY
		};
	}
	/**
	* Build the patch from the merge base of the target branch's commit and `headSha` to `headSha`, the comparison a
	* pull request page shows. `base` is not needed: the pull request names its own target commit.
	*/
	async diff(ref, headSha, signal) {
		const refused = this.hostFailure(ref.repository.host);
		if (refused !== void 0) return refused;
		if (!isCommit(headSha)) throw new Error(`forge-azure: invalid head commit ${JSON.stringify(headSha)}`);
		const at = await this.pullRequestAt(ref, headSha, signal);
		if ("failure" in at) return at.failure;
		const target = text(object(at.pullRequest.lastMergeTargetCommit).commitId);
		if (target === void 0 || !isCommit(target)) return {
			code: "unavailable",
			message: "Azure DevOps named no target commit for the pull request"
		};
		return await buildPatch(this.api, ref, target, headSha, true, this.limits, signal);
	}
	async compare(ref, base, head, signal) {
		const refused = this.hostFailure(ref.repository.host);
		if (refused !== void 0) return refused;
		if (!isCommit(base) || !isCommit(head)) throw new Error(`forge-azure: invalid commits ${JSON.stringify(`${base}..${head}`)}`);
		return await buildPatch(this.api, ref, base, head, false, this.limits, signal);
	}
	async mergeBase(ref, base, head, signal) {
		const refused = this.hostFailure(ref.repository.host);
		if (refused !== void 0) return refused;
		if (!isCommit(base) || !isCommit(head)) throw new Error(`forge-azure: invalid commits ${JSON.stringify(`${base}..${head}`)}`);
		const listed = await changedFiles(this.api, ref, base, head, true, Number.MAX_SAFE_INTEGER, signal);
		return "code" in listed ? listed : listed.base;
	}
	async fileText(ref, commit, path, signal) {
		const refused = this.hostFailure(ref.repository.host);
		if (refused !== void 0) return refused;
		if (!isCommit(commit)) throw new Error(`forge-azure: invalid commit ${JSON.stringify(commit)}`);
		const read = await readFile(this.api, ref, commit, path, signal);
		if ("code" in read) return read;
		return "text" in read ? read.text : {
			code: "unavailable",
			message: `${path} is a binary file`
		};
	}
	fileUrl(ref, commit, path) {
		return `${repositoryUrl(locationOf(ref.repository))}?path=${encodeURIComponent(`/${path.replace(/^\/+/, "")}`)}&version=GC${commit}`;
	}
	async readDescription(ref, signal) {
		const refused = this.hostFailure(ref.repository.host);
		if (refused !== void 0) return refused;
		const [pullRequest, labels] = await Promise.all([this.api.get(pullRequestApi(ref), signal), this.api.get(`${pullRequestApi(ref)}/labels`, signal)]);
		if (!pullRequest.ok) return pullRequest.failure;
		const body = object(pullRequest.body);
		const listed = (labels.ok ? objects(object(labels.body).value).filter((label) => label.active !== false).map((label) => text(label.name)) : []).filter((name) => name !== void 0);
		return {
			body: typeof body.description === "string" ? body.description : "",
			labels: listed.slice(0, LABELS).map((name) => ({
				name,
				color: null
			})),
			labelsTruncated: listed.length > LABELS || !labels.ok,
			images: {},
			imagesExpireAt: null,
			createdAt: text(body.creationDate) ?? (/* @__PURE__ */ new Date(0)).toISOString()
		};
	}
	async readReview(ref, headSha, signal) {
		const refused = this.hostFailure(ref.repository.host);
		if (refused !== void 0) return refused;
		if (!isCommit(headSha)) throw new Error(`forge-azure: invalid head commit ${JSON.stringify(headSha)}`);
		const at = await this.pullRequestAt(ref, headSha, signal);
		if ("failure" in at) return at.failure;
		const [threads, iterations] = await Promise.all([this.api.get(`${pullRequestApi(ref)}/threads`, signal), this.api.get(`${pullRequestApi(ref)}/iterations`, signal)]);
		if (!threads.ok) return threads.failure;
		if (!iterations.ok) return iterations.failure;
		return reviewDataOf(ref, objects(object(threads.body).value), objects(object(iterations.body).value), headSha, null, this.limits.maxReviewThreads);
	}
	async listForViewer(query, signal) {
		const refused = this.viewerFailure(query.host, query.repository !== null);
		if (refused !== void 0) return refused;
		if (!VIEWER_FILTERS.has(query.filter)) return {
			code: "unsupported",
			message: `forge-azure reads no ${query.filter} list`
		};
		if (!Number.isSafeInteger(query.limit) || query.limit <= 0 || query.limit > this.limits.maxViewerItems) throw new Error(`forge-azure: viewer list limit must be a positive integer no greater than ${this.limits.maxViewerItems}`);
		const scope = {
			organizations: this.organizations,
			repository: query.repository
		};
		return await viewerPage(this.api, scope, query.filter, query.limit, this.limits.maxViewerItems, signal);
	}
	async countForViewer(host, signal) {
		const refused = this.viewerFailure(host, false);
		if (refused !== void 0) return refused;
		const counts = /* @__PURE__ */ new Map();
		for (const filter of VIEWER_FILTERS) {
			const read = await readViewerList(this.api, {
				organizations: this.organizations,
				repository: null
			}, filter, this.limits.maxViewerItems, signal);
			if ("code" in read) return read;
			counts.set(filter, read.items.length);
		}
		return counts;
	}
	/** Read one pull request with its statuses, policy evaluations and threads; only the pull request itself must be readable. */
	async snapshot(ref, signal) {
		const refused = this.hostFailure(ref.repository.host);
		if (refused !== void 0) return refused;
		const read = await this.api.get(pullRequestApi(ref), signal);
		if (!read.ok) return read.failure;
		const pullRequest = object(read.body);
		const project = text(object(object(pullRequest.repository).project).id);
		const artifact = project === void 0 ? void 0 : encodeURIComponent(`vstfs:///CodeReview/CodeReviewId/${project}/${ref.number}`);
		const [statuses, threads, evaluations] = await Promise.all([
			this.api.get(`${pullRequestApi(ref)}/statuses`, signal),
			this.api.get(`${pullRequestApi(ref)}/threads`, signal),
			artifact === void 0 ? void 0 : this.api.get(`${projectApi(locationOf(ref.repository))}/policy/evaluations?artifactId=${artifact}`, signal, "7.1-preview.1")
		]);
		const values = (result) => result?.ok === true ? objects(object(result.body).value) : [];
		return snapshotOf({
			ref,
			pullRequest,
			statuses: values(statuses),
			evaluations: values(evaluations),
			threads: threads.ok ? values(threads) : null
		});
	}
	/** Read the pull request once its head is `headSha`; a different head is a `stale` failure. */
	async pullRequestAt(ref, headSha, signal) {
		const read = await this.api.get(pullRequestApi(ref), signal);
		if (!read.ok) return { failure: read.failure };
		const pullRequest = object(read.body);
		if (text(object(pullRequest.lastMergeSourceCommit).commitId) !== headSha) return { failure: {
			code: "stale",
			message: `the head of pull request ${ref.number} is no longer ${headSha}`
		} };
		return { pullRequest };
	}
	viewerFailure(host, oneRepository) {
		const refused = this.hostFailure(host);
		if (refused !== void 0) return {
			code: "unsupported",
			message: refused.message
		};
		if (!oneRepository && this.organizations.length === 0) return {
			code: "unsupported",
			message: "forge-azure lists pull requests only for the organizations named in its `organizations` setting"
		};
	}
	hostFailure(host) {
		return host.toLowerCase() === "dev.azure.com" ? void 0 : {
			code: "unavailable",
			message: `forge-azure serves only ${AZURE_HOST}, not ${host}`
		};
	}
};
// src/index.ts
const name = "forge-azure";
const inject = ["forge"];
/** Defaults of every setting. */
const DEFAULTS = {
	organizations: [],
	tokenEnv: ["DSH_OKF_AZURE_TOKEN", "DSH_OKF_GIT_TOKEN"],
	timeoutMs: 3e4,
	maxResponseBytes: 16777216,
	maxConcurrentRequests: 6,
	maxDiffFiles: 300,
	maxDiffBytes: 4194304,
	maxReviewThreads: 500,
	maxViewerItems: 100
};
const ORGANIZATION = /^[a-z0-9]([a-z0-9-]{0,48}[a-z0-9])?$/i;
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
* Apply defaults and reject settings the provider cannot run with.
* @throws with the setting's name when a value is invalid.
*/
function resolveConfig(config) {
	const resolved = {
		...DEFAULTS,
		...Object.fromEntries(Object.entries(config ?? {}).filter(([, value]) => value !== void 0 && value !== null))
	};
	if (!Array.isArray(resolved.organizations) || resolved.organizations.some((item) => typeof item !== "string" || !ORGANIZATION.test(item))) throw new Error("forge-azure: organizations must list Azure DevOps organization names");
	if (!Array.isArray(resolved.tokenEnv) || resolved.tokenEnv.length === 0 || resolved.tokenEnv.some((item) => typeof item !== "string" || !VARIABLE.test(item))) throw new Error("forge-azure: tokenEnv must list at least one environment variable name");
	for (const key of [
		"timeoutMs",
		"maxResponseBytes",
		"maxConcurrentRequests",
		"maxDiffFiles",
		"maxDiffBytes",
		"maxReviewThreads",
		"maxViewerItems"
	]) if (!Number.isSafeInteger(resolved[key]) || resolved[key] <= 0) throw new Error(`forge-azure: ${key} must be a positive safe integer`);
	if (resolved.timeoutMs > 2147483647) throw new Error("forge-azure: timeoutMs is too large");
	return resolved;
}
/**
* Build the token lookup: the first named variable that holds a value, read at each request so a rotated token applies
* to the next one. The token is never logged, stored, or put in a URL.
*/
function tokenFrom(names, env = process.env) {
	return async () => {
		for (const variable of names) {
			const value = env[variable]?.trim();
			if (value !== void 0 && value !== "") return value;
		}
	};
}
/**
* Build the provider from settings.
* @param config - settings before defaults.
* @param fetcher - HTTP client for tests; the global `fetch` otherwise.
* @param env - environment the token is read from.
*/
function createProvider(config, fetcher, env) {
	const resolved = resolveConfig(config);
	return new AzureProvider(new AzureApi(tokenFrom(resolved.tokenEnv, env), resolved, fetcher), resolved.organizations, resolved);
}
function apply(ctx, config) {
	ctx.forge.register(createProvider(config));
}
export { DEFAULTS, apply, createProvider, inject, name, resolveConfig, tokenFrom };
