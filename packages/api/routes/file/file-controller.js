import { service as fileService } from "../../services/file/file-service.js";
import {
	MAX_MEDIA_REQUEST_BYTES,
	MAX_MEDIA_UPLOAD_BYTES,
	MEDIA_UPLOAD_BODY_TIMEOUT_MS,
	acquireMediaUploadSlot,
	isValidDeviceSerial,
	service as mediaUploadService,
} from "../../services/file/media-upload-service.js";
import { logger } from "../../services/logger.js";

class FileController {
	async upload(res, req) {
		const body = await req.body;
		try {
			const result = await fileService.upload(body);
			res.send(result);
		} catch (ex) {
			logger.error(ex);
			res.setStatus("500").send(ex);
		}
	}

	async uploadMedia(res, req) {
		const device = req.getQuery("device");
		if (!isValidDeviceSerial(device)) {
			res.setStatus("400").send({ error: "Select a valid Android device" });
			return;
		}

		const contentType = req.getHeader("content-type") ?? "";
		if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
			res
				.setStatus("415")
				.send({ error: "Media upload requires multipart/form-data" });
			return;
		}

		const contentLength = Number.parseInt(
			req.getHeader("content-length") ?? "",
			10,
		);
		if (contentLength === 0) {
			res.setStatus("400").send({ error: "Select at least one media file" });
			return;
		}
		if (
			Number.isFinite(contentLength) &&
			contentLength > MAX_MEDIA_REQUEST_BYTES
		) {
			res.setStatus("413").send({
				error: `Media upload exceeds the ${MAX_MEDIA_UPLOAD_BYTES} byte limit`,
			});
			return;
		}

		let releaseUploadSlot;
		try {
			releaseUploadSlot = acquireMediaUploadSlot();
			const buffer = await req.getBodyBuffer(
				MAX_MEDIA_REQUEST_BYTES,
				MEDIA_UPLOAD_BODY_TIMEOUT_MS,
			);
			let body;
			try {
				body = req.getBodyParts(buffer, contentType);
			} catch {
				const parseError = new Error("Malformed multipart media upload");
				parseError.statusCode = 400;
				throw parseError;
			}
			const result = await mediaUploadService.upload(
				body,
				device,
				MAX_MEDIA_UPLOAD_BYTES,
			);
			res.send(result);
		} catch (ex) {
			if (ex?.code === "REQUEST_ABORTED") {
				return;
			}
			logger.error(ex);
			const status =
				ex?.statusCode ?? (ex?.code === "REQUEST_BODY_TOO_LARGE" ? 413 : 500);
			const error =
				status === 500
					? "Media upload failed"
					: ex?.message || "Media upload failed";
			res.setStatus(String(status)).send({ error });
		} finally {
			releaseUploadSlot?.();
		}
	}

	async getUploads(res, req) {
		try {
			const result = await fileService.getUploads();
			res.send(result);
		} catch (ex) {
			logger.error(ex);
			res.send([]);
		}
	}

	async getApps(res, req) {
		try {
			const result = await fileService.getApps();
			res.send(result);
		} catch (ex) {
			logger.error(ex);
			res.send([]);
		}
	}
}

export const controller = new FileController();
