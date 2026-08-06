import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join, posix } from "node:path";
import { service as adbShellService } from "../adb/adb-shell-service.js";

// Keep the complete multipart request below Cloudflare Free/Pro's 100 MB cap.
export const DEFAULT_MAX_MEDIA_UPLOAD_BYTES = 94 * 1024 * 1024;
export const MAX_MEDIA_FILES = 20;

const MEDIA_RULES = [
	{
		category: "image",
		directory: "/sdcard/Pictures",
		extensions: new Set([
			"jpg",
			"jpeg",
			"png",
			"gif",
			"webp",
			"bmp",
			"heic",
			"heif",
			"avif",
		]),
	},
	{
		category: "video",
		directory: "/sdcard/Movies",
		extensions: new Set([
			"mp4",
			"m4v",
			"mkv",
			"webm",
			"mov",
			"avi",
			"3gp",
			"3g2",
			"mpeg",
			"mpg",
		]),
	},
	{
		category: "audio",
		directory: "/sdcard/Music",
		extensions: new Set([
			"mp3",
			"m4a",
			"aac",
			"wav",
			"ogg",
			"oga",
			"flac",
			"opus",
			"amr",
			"wma",
		]),
	},
];

const ISO_BASE_MEDIA_EXTENSIONS = new Set(["mp4", "m4v", "m4a", "3gp", "3g2"]);
const HEIF_BRANDS = new Set([
	"heic",
	"heix",
	"hevc",
	"hevx",
	"heim",
	"heis",
	"mif1",
	"msf1",
]);
const AVIF_BRANDS = new Set(["avif", "avis"]);
const ASF_HEADER = Buffer.from([
	0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00,
	0x62, 0xce, 0x6c,
]);
let mediaUploadActive = false;

export class MediaUploadError extends Error {
	constructor(statusCode, message) {
		super(message);
		this.name = "MediaUploadError";
		this.statusCode = statusCode;
	}
}

export function acquireMediaUploadSlot() {
	if (mediaUploadActive) {
		throw new MediaUploadError(
			429,
			"Another media upload is already in progress",
		);
	}

	mediaUploadActive = true;
	let released = false;
	return () => {
		if (!released) {
			released = true;
			mediaUploadActive = false;
		}
	};
}

export function parseMaxMediaUploadBytes(value) {
	if (value === undefined || value === null || value === "") {
		return DEFAULT_MAX_MEDIA_UPLOAD_BYTES;
	}
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0
		? parsed
		: DEFAULT_MAX_MEDIA_UPLOAD_BYTES;
}

export const MAX_MEDIA_UPLOAD_BYTES = parseMaxMediaUploadBytes(
	process.env.MAX_MEDIA_UPLOAD_BYTES,
);
export const MAX_MEDIA_REQUEST_BYTES = MAX_MEDIA_UPLOAD_BYTES + 1024 * 1024;
const configuredBodyTimeout = Number(process.env.MEDIA_UPLOAD_BODY_TIMEOUT_MS);
export const MEDIA_UPLOAD_BODY_TIMEOUT_MS =
	Number.isSafeInteger(configuredBodyTimeout) && configuredBodyTimeout > 0
		? configuredBodyTimeout
		: 10 * 60 * 1000;

export function isValidDeviceSerial(device) {
	return Boolean(device && /^[\p{L}\p{N}._:-]{1,128}$/u.test(String(device)));
}

function trimToUtf8Bytes(value, maxBytes) {
	const characters = [...value];
	while (
		characters.length > 0 &&
		Buffer.byteLength(characters.join("")) > maxBytes
	) {
		characters.pop();
	}
	return characters.join("");
}

export function sanitizeMediaFileName(fileName) {
	const leafName = basename(String(fileName ?? "").replaceAll("\\", "/"))
		.normalize("NFKC")
		.trim();
	const extension = extname(leafName).toLowerCase();
	const rawStem = extension ? leafName.slice(0, -extension.length) : leafName;
	const safeStem = trimToUtf8Bytes(
		rawStem.replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/^[._-]+|[._-]+$/g, ""),
		180,
	);

	if (!safeStem || !extension) {
		throw new MediaUploadError(400, "Each media file must have a valid name");
	}

	return `${safeStem}${extension}`;
}

export function classifyMediaFile(fileName, mimeType = "") {
	const extension = extname(fileName).slice(1).toLowerCase();
	const rule = MEDIA_RULES.find(({ extensions }) => extensions.has(extension));
	if (!rule) {
		throw new MediaUploadError(
			415,
			`Unsupported media extension: .${extension || "unknown"}`,
		);
	}

	const normalizedMime = String(mimeType).split(";", 1)[0].trim().toLowerCase();
	if (
		normalizedMime &&
		normalizedMime !== "application/octet-stream" &&
		!normalizedMime.startsWith(`${rule.category}/`)
	) {
		throw new MediaUploadError(
			415,
			`Media type ${normalizedMime} does not match .${extension}`,
		);
	}

	return {
		category: rule.category,
		directory: rule.directory,
		extension: `.${extension}`,
		mime: normalizedMime || "application/octet-stream",
	};
}

function startsWithBytes(data, signature) {
	return (
		data.byteLength >= signature.length &&
		signature.every((byte, index) => data[index] === byte)
	);
}

function hasRiffType(data, type) {
	return (
		data.byteLength >= 12 &&
		data.subarray(0, 4).toString("ascii") === "RIFF" &&
		data.subarray(8, 12).toString("ascii") === type
	);
}

function hasIsoBaseMediaHeader(data) {
	return (
		data.byteLength >= 12 && data.subarray(4, 8).toString("ascii") === "ftyp"
	);
}

function hasIsoBrand(data, allowedBrands) {
	if (!hasIsoBaseMediaHeader(data)) {
		return false;
	}

	const declaredSize = data.readUInt32BE(0);
	const boxEnd = Math.min(
		data.byteLength,
		declaredSize >= 16 ? declaredSize : data.byteLength,
		128,
	);
	for (let offset = 8; offset + 4 <= boxEnd; offset += 4) {
		if (
			allowedBrands.has(data.subarray(offset, offset + 4).toString("ascii"))
		) {
			return true;
		}
	}
	return false;
}

export function hasSupportedMediaSignature(fileName, value) {
	const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
	const extension = extname(fileName).slice(1).toLowerCase();

	if (ISO_BASE_MEDIA_EXTENSIONS.has(extension)) {
		return hasIsoBaseMediaHeader(data);
	}

	switch (extension) {
		case "jpg":
		case "jpeg":
			return startsWithBytes(data, [0xff, 0xd8, 0xff]);
		case "png":
			return startsWithBytes(
				data,
				[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
			);
		case "gif":
			return ["GIF87a", "GIF89a"].includes(
				data.subarray(0, 6).toString("ascii"),
			);
		case "webp":
			return hasRiffType(data, "WEBP");
		case "bmp":
			return data.subarray(0, 2).toString("ascii") === "BM";
		case "heic":
		case "heif":
			return hasIsoBrand(data, HEIF_BRANDS);
		case "avif":
			return hasIsoBrand(data, AVIF_BRANDS);
		case "mkv":
		case "webm":
			return startsWithBytes(data, [0x1a, 0x45, 0xdf, 0xa3]);
		case "mov":
			return (
				hasIsoBaseMediaHeader(data) ||
				["moov", "mdat", "wide"].includes(data.subarray(4, 8).toString("ascii"))
			);
		case "avi":
			return hasRiffType(data, "AVI ");
		case "mpeg":
		case "mpg":
			return startsWithBytes(data, [0x00, 0x00, 0x01]) || data[0] === 0x47;
		case "mp3":
			return (
				data.subarray(0, 3).toString("ascii") === "ID3" ||
				(data[0] === 0xff && (data[1] & 0xe0) === 0xe0)
			);
		case "aac":
			return (
				data.subarray(0, 4).toString("ascii") === "ADIF" ||
				(data[0] === 0xff && (data[1] & 0xf6) === 0xf0)
			);
		case "wav":
			return hasRiffType(data, "WAVE");
		case "ogg":
		case "oga":
		case "opus":
			return data.subarray(0, 4).toString("ascii") === "OggS";
		case "flac":
			return data.subarray(0, 4).toString("ascii") === "fLaC";
		case "amr":
			return ["#!AMR\n", "#!AMR-WB\n"].some((header) =>
				data.subarray(0, header.length).equals(Buffer.from(header)),
			);
		case "wma":
			return data.subarray(0, ASF_HEADER.length).equals(ASF_HEADER);
		default:
			return false;
	}
}

function makeUniqueFileName(fileName, usedNames) {
	const extension = extname(fileName);
	const stem = fileName.slice(0, -extension.length);
	let candidate = fileName;
	let sequence = 2;
	while (usedNames.has(candidate.toLowerCase())) {
		candidate = `${stem}_${sequence}${extension}`;
		sequence += 1;
	}
	usedNames.add(candidate.toLowerCase());
	return candidate;
}

export function prepareMediaFiles(parts, maxBytes = MAX_MEDIA_UPLOAD_BYTES) {
	const fileParts = Object.entries(parts ?? {}).filter(
		([, part]) =>
			part && typeof part === "object" && part.filename !== undefined,
	);
	if (fileParts.length === 0) {
		throw new MediaUploadError(400, "Select at least one media file");
	}
	if (fileParts.length > MAX_MEDIA_FILES) {
		throw new MediaUploadError(
			413,
			`A maximum of ${MAX_MEDIA_FILES} files can be uploaded at once`,
		);
	}

	let totalBytes = 0;
	const usedNames = new Set();
	return fileParts.map(([fieldName, part]) => {
		if (part.data === undefined || part.data === null) {
			throw new MediaUploadError(400, "A media file has no data");
		}
		const data = Buffer.from(part.data);
		if (data.byteLength === 0) {
			throw new MediaUploadError(400, "Empty media files are not supported");
		}
		totalBytes += data.byteLength;
		if (totalBytes > maxBytes) {
			throw new MediaUploadError(
				413,
				`Media upload exceeds the ${maxBytes} byte limit`,
			);
		}

		const originalName = String(part.filename);
		const sanitizedName = sanitizeMediaFileName(originalName);
		const name = makeUniqueFileName(sanitizedName, usedNames);
		const media = classifyMediaFile(name, part.type);
		if (!hasSupportedMediaSignature(name, data)) {
			throw new MediaUploadError(
				415,
				`File contents do not match the media format for ${name}`,
			);
		}
		return {
			...media,
			data,
			fieldName,
			name,
			originalName,
			size: data.byteLength,
		};
	});
}

export class MediaUploadService {
	constructor({ adbService = adbShellService, createId = randomUUID } = {}) {
		this.adbService = adbService;
		this.createId = createId;
	}

	async upload(parts, device, maxBytes = MAX_MEDIA_UPLOAD_BYTES) {
		if (!isValidDeviceSerial(device)) {
			throw new MediaUploadError(400, "Select a valid Android device");
		}

		const files = prepareMediaFiles(parts, maxBytes);
		try {
			await this.adbService.assertDevice(device);
		} catch {
			throw new MediaUploadError(
				404,
				`Android device '${device}' is not connected`,
			);
		}

		const temporaryDirectory = await mkdtemp(join(tmpdir(), "scws-media-"));
		const preparedDirectories = new Set();
		const failedDirectories = new Set();
		const uploadedFiles = [];
		const errors = [];
		const logs = [];

		try {
			for (const file of files) {
				if (failedDirectories.has(file.directory)) {
					errors.push({
						fieldName: file.fieldName,
						name: file.name,
						originalName: file.originalName,
						error: `Could not prepare ${file.directory} on the Android device`,
					});
					continue;
				}
				if (!preparedDirectories.has(file.directory)) {
					try {
						await this.adbService.ensureRemoteDirectory(device, file.directory);
					} catch {
						failedDirectories.add(file.directory);
						errors.push({
							fieldName: file.fieldName,
							name: file.name,
							originalName: file.originalName,
							error: `Could not prepare ${file.directory} on the Android device`,
						});
						continue;
					}
					preparedDirectories.add(file.directory);
				}

				const localPath = join(
					temporaryDirectory,
					`${this.createId()}${file.extension}`,
				);
				const extension = extname(file.name);
				const stem = file.name.slice(0, -extension.length);
				const remoteName = `${stem}_${this.createId()}${extension}`;
				const remotePath = posix.join(file.directory, remoteName);
				await writeFile(localPath, file.data, { flag: "wx" });

				let pushResult;
				try {
					pushResult = await this.adbService.pushMediaFile(
						device,
						localPath,
						remotePath,
					);
				} catch {
					errors.push({
						fieldName: file.fieldName,
						name: file.name,
						originalName: file.originalName,
						error: `Could not copy ${file.name} to the Android device`,
					});
					continue;
				}

				logs.push(...(pushResult.logs ?? []));
				if (pushResult.warning) {
					logs.push(pushResult.warning);
				}
				uploadedFiles.push({
					fieldName: file.fieldName,
					name: remoteName,
					sanitizedName: file.name,
					originalName: file.originalName,
					mime: file.mime,
					size: file.size,
					path: remotePath,
					scanned: pushResult.scanned,
					...(pushResult.warning ? { warning: pushResult.warning } : {}),
				});
			}

			if (uploadedFiles.length === 0 && errors.length > 0) {
				throw new MediaUploadError(502, errors[0].error);
			}

			return { files: uploadedFiles, errors, logs };
		} finally {
			await rm(temporaryDirectory, { recursive: true, force: true });
		}
	}
}

export const service = new MediaUploadService();
