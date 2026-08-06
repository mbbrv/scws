import { controller } from "./file-controller.js";

export default [
	{
		method: "post",
		url: "/api/file/upload",
		// schema: schema.get,
		handler: controller.upload,
	},
	{
		method: "post",
		url: "/api/file/upload-media",
		handler: controller.uploadMedia,
	},
	{
		method: "get",
		url: "/api/file/get-uploads",
		// schema: schema.get,
		handler: controller.getUploads,
	},
	{
		method: "get",
		url: "/api/file/get-apps",
		// schema: schema.get,
		handler: controller.getApps,
	},
];
