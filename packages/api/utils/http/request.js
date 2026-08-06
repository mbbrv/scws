import * as cookie from "cookie";
import * as qs from "qs";
import uWS from "uWebSockets.js";

const Request = function (res, req, route) {
	this.res = res;
	this.req = req;
	this.route = route;
	this._bodyBuffer = null;
	this._bodyBufferPromise = null;
	this._body = null;
	this.aborted = false;
	this._abortListeners = new Set();

	if (typeof res.onAborted === "function") {
		res.onAborted(() => {
			this.aborted = true;
			const listeners = [...this._abortListeners];
			this._abortListeners.clear();
			for (const listener of listeners) {
				listener();
			}
		});
	}
};

Request.prototype.addAbortListener = function (handler) {
	if (this.aborted) {
		handler();
		return () => {};
	}

	this._abortListeners.add(handler);
	return () => this._abortListeners.delete(handler);
};

Request.prototype.getBodyBuffer = function (
	maxBytes = Number.POSITIVE_INFINITY,
	timeoutMs = 0,
) {
	if (this._bodyBuffer) {
		return this._bodyBuffer;
	}
	if (this._bodyBufferPromise) {
		return this._bodyBufferPromise;
	}

	this._bodyBufferPromise = new Promise((resolve, reject) => {
		const chunks = [];
		let totalBytes = 0;
		let settled = false;
		let timeout;
		let removeAbortListener = () => {};
		const cleanup = () => {
			if (timeout) clearTimeout(timeout);
			removeAbortListener();
		};
		const rejectBody = (error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};

		if (timeoutMs > 0) {
			timeout = setTimeout(() => {
				const error = new Error(
					`Request body was not received within ${timeoutMs} ms`,
				);
				error.code = "REQUEST_BODY_TIMEOUT";
				error.statusCode = 408;
				rejectBody(error);
			}, timeoutMs);
		}

		removeAbortListener = this.addAbortListener(() => {
			const error = new Error("Request was aborted before the body completed");
			error.code = "REQUEST_ABORTED";
			rejectBody(error);
		});

		this.res.onData((ab, isLast) => {
			if (settled) {
				return;
			}

			// uWebSockets.js only guarantees that the ArrayBuffer is valid for the
			// duration of this callback, so keep an owned copy for later concatenation.
			const chunk = Buffer.from(new Uint8Array(ab));
			totalBytes += chunk.byteLength;
			if (totalBytes > maxBytes) {
				const error = new Error(
					`Request body exceeds the ${maxBytes} byte limit`,
				);
				error.code = "REQUEST_BODY_TOO_LARGE";
				error.maxBytes = maxBytes;
				rejectBody(error);
				return;
			}

			chunks.push(chunk);
			if (isLast) {
				settled = true;
				cleanup();
				this._bodyBuffer = Buffer.concat(chunks, totalBytes);
				resolve(this._bodyBuffer);
			}
		});
	});

	return this._bodyBufferPromise;
};

Request.prototype.getBodyJson = (buffer) => {
	const data = JSON.parse(buffer);
	return data;
};

Request.prototype.getBodyParts = function (buffer, contentType) {
	const data = Object.fromEntries(
		uWS.getParts(buffer, contentType).map((part) => {
			if (part.filename) {
				return [part.name, part];
			}
			if (part.type) {
				return [part.name, this.parse(part.type, Buffer.from(part.data))];
			}
			return [part.name, Buffer.from(part.data).toString()];
		}),
	);

	return data;
};

Request.prototype.getBodyUrlEncoded = (buffer) => qs.parse(buffer.toString());
Request.prototype.getBodyText = (buffer) => buffer.toString();

Request.prototype.parse = async function (contentType, buffer) {
	if (
		contentType.startsWith("application/json") ||
		contentType === "text/json"
	) {
		return this.getBodyJson(buffer);
	}
	if (contentType.startsWith("multipart/")) {
		return this.getBodyParts(buffer, contentType);
	}
	if (contentType === "application/x-www-form-urlencoded") {
		return this.getBodyUrlEncoded(buffer);
	}
	if (contentType.startsWith("text/")) {
		return this.getBodyText(buffer);
	}
};

Object.defineProperty(Request.prototype, "body", {
	get: async function () {
		if (!this._body) {
			this._body = await (async () => {
				try {
					const contentType = this.req.getHeader("content-type");
					const buffer = await this.getBodyBuffer();
					const result = this.parse(contentType, buffer);
					return result;
				} catch (e) {
					return {}; // fallback value
				}
			})();
		}
		return this._body;
	},
});

Request.prototype.getUrl = function () {
	return this.req.getUrl();
};
Request.prototype.getMethod = function () {
	return this.req.getMethod();
};
Request.prototype.getHeader = function (lowerCaseKey) {
	return this.req.getHeader(lowerCaseKey);
};
Request.prototype.forEach = function (cb) {
	return this.req.forEach(cb);
};
Request.prototype.getQuery = function (key) {
	return key !== undefined ? this.req.getQuery(key) : this.req.getQuery();
};
Request.prototype.getUrl = function () {
	return this.req.getUrl();
};
Request.prototype.setYield = function (yieldValue) {
	return this.req.setYield(yieldValue);
};

Object.defineProperty(Request.prototype, "cookies", {
	get: function () {
		if (!(this._flags & 8)) {
			const cookieHeader = this.req.getHeader("cookie");
			if (cookieHeader) {
				const cookies = cookie.parse(cookieHeader);
				if (this._cookies) {
					for (const name in this._cookies) {
						this._cookies[name] = cookies[name];
					}
				} else {
					this._cookies = cookies;
				}
			} else {
				this._cookies = {};
			}
			this._flags |= 8;
		}
		return this._cookies;
	},
});
Request.prototype.hasCookie = function (name) {
	return (
		this.cookies &&
		this.cookies[name] !== undefined &&
		this.cookies[name] !== null
	);
};

Object.defineProperty(Request.prototype, "headers", {
	get: function () {
		// if we have a query schema, map accordingly, otherwise take the whole query string
		if (this._headers) {
			for (const name in this._headers) {
				this._headers[name] = this.req.getHeader(name);
			}
		} else {
			const headers = new Map();
			this.req.forEach((key, value) => {
				headers.set(key, value);
			});
			this._headers = Object.fromEntries(headers.entries());
		}
		this._flags |= 4;
		return this._headers;
	},
});

Request.prototype.get = function (field) {
	return this.headers[field];
};
Request.prototype.header = function (field) {
	return this.headers[field];
};

export default Request;
