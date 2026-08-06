import { apiClient } from "../http-client";
import { useProgressStore } from "@/store/progress";
 import * as qs from "qs";

class FileUploadService {
	#endpoint = "file";

	upload(files, params) {
		const progressStore = useProgressStore();
		const formData = new FormData();
		for (let i = 0; i < files.length; i++) {
			const file = files[i];
			formData.append(`files[${i}]`, file);
		}

		const querystring = qs.stringify(params, { encode: false });
		const url = `/${this.#endpoint}/upload?${querystring}`;
		return apiClient.post(url, formData, {
			headers: {
				"Content-Type": "multipart/form-data",
			},
			onUploadProgress: ({ loaded, total }) => {
				progressStore.setProgress(Math.floor((loaded * 100) / total));
			},
		});
	}

  uploadMedia(files, device, { signal, onProgress } = {}) {
    const formData = new FormData()
    for (let i = 0; i < files.length; i++) {
      formData.append(`files[${i}]`, files[i])
    }

    return apiClient.post(`/${this.#endpoint}/upload-media`, formData, {
      params: { device },
      signal,
      headers: {
        'Content-Type': undefined,
      },
      onUploadProgress: ({ loaded, total, progress }) => {
        const percentage = Number.isFinite(progress)
          ? Math.round(progress * 100)
          : total
            ? Math.round((loaded * 100) / total)
            : 0
        onProgress?.(Math.min(100, Math.max(0, percentage)))
      },
    })
  }

	  getUplaods(params) {
 		const querystring = qs.stringify(params, { encode: false });
		const url = `/${this.#endpoint}/get-uploads?${querystring}`;
		return apiClient.get(url);
	
 	}

	 getApps(params) {
		const querystring = qs.stringify(params, { encode: false });
	   const url = `/${this.#endpoint}/get-apps?${querystring}`;
	   return apiClient.get(url);
   
	}
}

export const fileUploadService = new FileUploadService();
