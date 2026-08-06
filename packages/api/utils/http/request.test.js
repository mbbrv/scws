import assert from "node:assert/strict";
import test from "node:test";
import Request from "./request.js";

function createRequest(chunks) {
	const response = {
		onAborted(handler) {
			this.abortHandler = handler;
		},
		abort() {
			this.abortHandler?.();
		},
		onData(handler) {
			queueMicrotask(() => {
				chunks.forEach((chunk, index) => {
					handler(chunk, index === chunks.length - 1);
				});
			});
		},
	};
	return new Request(response, {}, {});
}

test("request body buffering concatenates chunks once", async () => {
	const request = createRequest([Buffer.from("hello "), Buffer.from("world")]);
	const body = await request.getBodyBuffer(32);
	assert.equal(body.toString(), "hello world");
	assert.equal(request.getBodyBuffer(32), body);
});

test("request body buffering owns copies of transient uWebSockets chunks", async () => {
	const response = {
		onAborted(handler) {
			this.abortHandler = handler;
		},
		onData(handler) {
			queueMicrotask(() => {
				const transient = new Uint8Array([104, 105]);
				handler(transient.buffer, false);
				transient.fill(0);
				handler(new Uint8Array([33]).buffer, true);
			});
		},
	};
	const request = new Request(response, {}, {});

	const body = await request.getBodyBuffer(32);
	assert.equal(body.toString(), "hi!");
});

test("request body buffering rejects when the client aborts before isLast", async () => {
	const request = createRequest([]);
	const bodyPromise = request.getBodyBuffer(32, 1000);
	request.res.abort();

	await assert.rejects(
		bodyPromise,
		(error) => error.code === "REQUEST_ABORTED",
	);
});

test("request body buffering rejects when the read deadline expires", async () => {
	const request = createRequest([]);
	await assert.rejects(
		request.getBodyBuffer(32, 20),
		(error) =>
			error.code === "REQUEST_BODY_TIMEOUT" && error.statusCode === 408,
	);
});

test("multipart parsing preserves independently named media files", async () => {
	const boundary = "scws-media-test";
	const multipartBody = Buffer.concat([
		Buffer.from(
			`--${boundary}\r\nContent-Disposition: form-data; name="files[0]"; filename="one.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`,
		),
		Buffer.from([0xff, 0xd8, 0xff]),
		Buffer.from(
			`\r\n--${boundary}\r\nContent-Disposition: form-data; name="files[1]"; filename="two.mp3"\r\nContent-Type: audio/mpeg\r\n\r\nID3\r\n--${boundary}--\r\n`,
		),
	]);
	const request = createRequest([multipartBody]);
	const body = await request.getBodyBuffer(1024);
	const parts = request.getBodyParts(
		body,
		`multipart/form-data; boundary=${boundary}`,
	);

	assert.deepEqual(Object.keys(parts), ["files[0]", "files[1]"]);
	assert.equal(parts["files[0]"].filename, "one.jpg");
	assert.deepEqual(
		Buffer.from(parts["files[0]"].data),
		Buffer.from([0xff, 0xd8, 0xff]),
	);
	assert.equal(parts["files[1]"].filename, "two.mp3");
	assert.equal(Buffer.from(parts["files[1]"].data).toString(), "ID3");
});

test("request body buffering rejects while reading when the limit is exceeded", async () => {
	const request = createRequest([Buffer.alloc(4), Buffer.alloc(4)]);
	await assert.rejects(
		request.getBodyBuffer(7),
		(error) => error.code === "REQUEST_BODY_TOO_LARGE" && error.maxBytes === 7,
	);
});
