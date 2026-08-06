import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { AdbShellService } from "../adb/adb-shell-service.js";
import {
	DEFAULT_MAX_MEDIA_UPLOAD_BYTES,
	MAX_MEDIA_FILES,
	MediaUploadError,
	MediaUploadService,
	acquireMediaUploadSlot,
	classifyMediaFile,
	hasSupportedMediaSignature,
	parseMaxMediaUploadBytes,
	prepareMediaFiles,
	sanitizeMediaFileName,
} from "./media-upload-service.js";

function jpegData(payload = []) {
	return Buffer.from([0xff, 0xd8, 0xff, ...payload]);
}

function mp3Data(payload = []) {
	return Buffer.from([0x49, 0x44, 0x33, ...payload]);
}

function isoMediaData(brand = "isom") {
	const data = Buffer.alloc(24);
	data.writeUInt32BE(24, 0);
	data.write("ftyp", 4, "ascii");
	data.write(brand, 8, "ascii");
	data.write(brand, 16, "ascii");
	return data;
}

test("media upload limit uses a safe default for invalid configuration", () => {
	assert.equal(parseMaxMediaUploadBytes(), DEFAULT_MAX_MEDIA_UPLOAD_BYTES);
	assert.equal(
		parseMaxMediaUploadBytes("invalid"),
		DEFAULT_MAX_MEDIA_UPLOAD_BYTES,
	);
	assert.equal(parseMaxMediaUploadBytes("0"), DEFAULT_MAX_MEDIA_UPLOAD_BYTES);
	assert.equal(parseMaxMediaUploadBytes("4096"), 4096);
});

test("only one memory-buffered media upload can run at a time", () => {
	const release = acquireMediaUploadSlot();
	assert.throws(
		() => acquireMediaUploadSlot(),
		(error) => error instanceof MediaUploadError && error.statusCode === 429,
	);
	release();
	release();
	const releaseAgain = acquireMediaUploadSlot();
	releaseAgain();
});

test("media filenames cannot escape the temporary or Android directory", () => {
	assert.equal(
		sanitizeMediaFileName("../../holiday $(touch).JPG"),
		"holiday_touch.jpg",
	);
	assert.equal(sanitizeMediaFileName("..\\..\\clip.mp4"), "clip.mp4");
	assert.equal(sanitizeMediaFileName("лето 2026.png"), "лето_2026.png");
});

test("media type must match an allowlisted extension", () => {
	assert.deepEqual(classifyMediaFile("photo.jpg", "image/jpeg"), {
		category: "image",
		directory: "/sdcard/Pictures",
		extension: ".jpg",
		mime: "image/jpeg",
	});
	assert.throws(
		() => classifyMediaFile("photo.jpg", "video/mp4"),
		(error) => error instanceof MediaUploadError && error.statusCode === 415,
	);
	assert.throws(
		() => classifyMediaFile("payload.exe", "image/jpeg"),
		(error) => error instanceof MediaUploadError && error.statusCode === 415,
	);
});

test("media contents must match the allowlisted extension", () => {
	assert.equal(hasSupportedMediaSignature("photo.jpg", jpegData()), true);
	assert.equal(
		hasSupportedMediaSignature("photo.jpg", Buffer.from("not an image")),
		false,
	);
	assert.equal(hasSupportedMediaSignature("clip.mp4", isoMediaData()), true);
	assert.throws(
		() =>
			prepareMediaFiles({
				file: {
					filename: "payload.jpg",
					type: "image/jpeg",
					data: Buffer.from("arbitrary payload"),
				},
			}),
		(error) => error instanceof MediaUploadError && error.statusCode === 415,
	);
});

test("media preparation keeps multiple files and assigns unique safe names", () => {
	const files = prepareMediaFiles(
		{
			"files[0]": {
				filename: "photo.jpg",
				type: "image/jpeg",
				data: jpegData([1]),
			},
			"files[1]": {
				filename: "photo.jpg",
				type: "application/octet-stream",
				data: jpegData([2]),
			},
		},
		8,
	);

	assert.deepEqual(
		files.map(({ name, directory }) => ({ name, directory })),
		[
			{ name: "photo.jpg", directory: "/sdcard/Pictures" },
			{ name: "photo_2.jpg", directory: "/sdcard/Pictures" },
		],
	);
	assert.throws(
		() =>
			prepareMediaFiles(
				{ file: { filename: "x.mp3", data: Buffer.alloc(3) } },
				2,
			),
		(error) => error instanceof MediaUploadError && error.statusCode === 413,
	);
});

test("media preparation enforces the file-count limit", () => {
	const parts = Object.fromEntries(
		Array.from({ length: MAX_MEDIA_FILES + 1 }, (_, index) => [
			`files[${index}]`,
			{
				filename: `photo-${index}.jpg`,
				type: "image/jpeg",
				data: jpegData(),
			},
		]),
	);

	assert.throws(
		() => prepareMediaFiles(parts),
		(error) => error instanceof MediaUploadError && error.statusCode === 413,
	);
});

test("ADB media commands are passed as argument arrays and scan failures are warnings", async () => {
	const adb = new AdbShellService();
	const calls = [];
	adb.runAdbCommand = async (args) => {
		calls.push(args);
		if (args.includes("broadcast")) {
			throw new Error("scanner unavailable");
		}
		return { logs: ["ok"], errors: [], finished: true };
	};

	await adb.assertDevice("emulator-5554");
	await adb.ensureRemoteDirectory("emulator-5554", "/sdcard/Pictures");
	const result = await adb.pushMediaFile(
		"emulator-5554",
		"/tmp/local.jpg",
		"/sdcard/Pictures/safe.jpg",
	);

	assert.deepEqual(calls[0], ["-s", "emulator-5554", "get-state"]);
	assert.deepEqual(calls[1], [
		"-s",
		"emulator-5554",
		"shell",
		"mkdir",
		"-p",
		"/sdcard/Pictures",
	]);
	assert.deepEqual(calls[2], [
		"-s",
		"emulator-5554",
		"push",
		"/tmp/local.jpg",
		"/sdcard/Pictures/safe.jpg",
	]);
	assert.deepEqual(calls[3], [
		"-s",
		"emulator-5554",
		"shell",
		"am",
		"broadcast",
		"-a",
		"android.intent.action.MEDIA_SCANNER_SCAN_FILE",
		"-d",
		"file:///sdcard/Pictures/safe.jpg",
	]);
	assert.equal(result.scanned, false);
	assert.match(result.warning, /media library/i);
});

test("temporary media files are removed after a successful device push", async () => {
	let temporaryFile;
	const adbService = {
		assertDevice: async () => undefined,
		ensureRemoteDirectory: async () => undefined,
		pushMediaFile: async (_device, localPath) => {
			temporaryFile = localPath;
			assert.equal(existsSync(localPath), true);
			return { logs: ["pushed"], scanned: true };
		},
	};
	const ids = ["local-id", "remote-id"];
	const service = new MediaUploadService({
		adbService,
		createId: () => ids.shift(),
	});
	const result = await service.upload(
		{
			"files[0]": {
				filename: "song.mp3",
				type: "audio/mpeg",
				data: mp3Data(),
			},
		},
		"emulator-5554",
		1024,
	);

	assert.equal(result.files[0].path, "/sdcard/Music/song_remote-id.mp3");
	assert.equal(result.files[0].sanitizedName, "song.mp3");
	assert.equal(existsSync(temporaryFile), false);
});

test("a later ADB failure returns a partial result without retrying successful files", async () => {
	let pushCount = 0;
	const adbService = {
		assertDevice: async () => undefined,
		ensureRemoteDirectory: async () => undefined,
		pushMediaFile: async () => {
			pushCount += 1;
			if (pushCount === 2) throw new Error("push failed");
			return { logs: ["pushed"], scanned: true };
		},
	};
	const ids = ["local-1", "remote-1", "local-2", "remote-2"];
	const service = new MediaUploadService({
		adbService,
		createId: () => ids.shift(),
	});

	const result = await service.upload(
		{
			"files[0]": {
				filename: "photo.jpg",
				type: "image/jpeg",
				data: jpegData(),
			},
			"files[1]": {
				filename: "song.mp3",
				type: "audio/mpeg",
				data: mp3Data(),
			},
		},
		"emulator-5554",
		1024,
	);

	assert.equal(result.files.length, 1);
	assert.equal(result.files[0].fieldName, "files[0]");
	assert.equal(result.errors.length, 1);
	assert.equal(result.errors[0].fieldName, "files[1]");
});

test("temporary media files are removed after an ADB failure", async () => {
	let temporaryFile;
	const adbService = {
		assertDevice: async () => undefined,
		ensureRemoteDirectory: async () => undefined,
		pushMediaFile: async (_device, localPath) => {
			temporaryFile = localPath;
			throw new Error("push failed");
		},
	};
	const ids = ["local-id", "remote-id"];
	const service = new MediaUploadService({
		adbService,
		createId: () => ids.shift(),
	});

	await assert.rejects(
		service.upload(
			{
				"files[0]": {
					filename: "movie.mp4",
					type: "video/mp4",
					data: isoMediaData(),
				},
			},
			"emulator-5554",
			1024,
		),
		(error) => error instanceof MediaUploadError && error.statusCode === 502,
	);
	assert.equal(existsSync(temporaryFile), false);
});
