import assert from "node:assert/strict";
import test from "node:test";
import Request from "./request.js";
import Response from "./response.js";

test("request and response abort listeners share one uWebSockets handler", () => {
	let rawAbortHandler;
	const rawResponse = {
		onAborted(handler) {
			rawAbortHandler = handler;
		},
	};
	const request = new Request(rawResponse, {}, {});
	const response = new Response(rawResponse, {}, request, {});
	let additionalListenerCalled = false;
	response.onAborted(() => {
		additionalListenerCalled = true;
	});

	rawAbortHandler();

	assert.equal(request.aborted, true);
	assert.equal(response.aborted, true);
	assert.equal(additionalListenerCalled, true);
});
