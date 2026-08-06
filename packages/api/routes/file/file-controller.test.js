import assert from "node:assert/strict";
import test from "node:test";
import { acquireMediaUploadSlot } from "../../services/file/media-upload-service.js";
import Request from "../../utils/http/request.js";
import { controller } from "./file-controller.js";

test("an aborted media request releases the global upload slot", async () => {
	let abortHandler;
	const rawResponse = {
		onAborted(handler) {
			abortHandler = handler;
		},
		onData() {},
	};
	const rawRequest = {
		getQuery: () => "emulator-5554",
		getHeader: (name) =>
			name === "content-type" ? "multipart/form-data; boundary=scws-test" : "",
	};
	const request = new Request(rawResponse, rawRequest, {});
	const response = {
		sent: false,
		setStatus() {
			return this;
		},
		send() {
			this.sent = true;
			return this;
		},
	};

	const upload = controller.uploadMedia(response, request);
	abortHandler();
	await upload;

	assert.equal(response.sent, false);
	const release = acquireMediaUploadSlot();
	release();
});
