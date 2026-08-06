<script setup>
  import axios from 'axios'
  import { computed, onBeforeUnmount, ref, shallowRef } from 'vue'
  import { useAdbStore } from '@/store/adb'
  import { useToastStore } from '@/store/toast'
  import { fileUploadService } from '@/services/file/file-service'
  import {
    DEFAULT_MAX_MEDIA_UPLOAD_MB,
    MEDIA_FILE_EXTENSIONS,
    MEDIA_UPLOAD_MAX_FILES,
  } from '@/utils/constants'

  const adbStore = useAdbStore()
  const toastStore = useToastStore()

  const filesToUpload = ref([])
  const isUploading = ref(false)
  const uploadDevice = ref(null)
  const uploadProgress = ref(0)
  const uploadController = shallowRef(null)
  const supportedMediaTypes = [
    'image/*',
    'video/*',
    'audio/*',
    ...MEDIA_FILE_EXTENSIONS.map((extension) => `.${extension}`),
  ].join(',')

  const configuredMaxMediaUploadMb = Number(
    import.meta.env.VITE_MAX_MEDIA_UPLOAD_MB || DEFAULT_MAX_MEDIA_UPLOAD_MB,
  )
  const maxMediaUploadMb =
    Number.isFinite(configuredMaxMediaUploadMb) &&
    configuredMaxMediaUploadMb > 0
      ? configuredMaxMediaUploadMb
      : DEFAULT_MAX_MEDIA_UPLOAD_MB
  const maxMediaUploadBytes = maxMediaUploadMb * 1024 ** 2
  const totalSizeBytes = computed(() =>
    filesToUpload.value.reduce((total, file) => total + file.size, 0),
  )
  const isOverLimit = computed(() => totalSizeBytes.value > maxMediaUploadBytes)
  const canCancelUpload = computed(
    () => isUploading.value && uploadProgress.value < 100,
  )

  function formatFileSize(bytes) {
    if (!bytes) return '0 B'

    const units = ['B', 'KiB', 'MiB', 'GiB']
    const unitIndex = Math.min(
      Math.floor(Math.log(bytes) / Math.log(1024)),
      units.length - 1,
    )
    const value = bytes / 1024 ** unitIndex
    const fractionDigits = unitIndex === 0 || value >= 10 ? 0 : 1

    return `${value.toFixed(fractionDigits)} ${units[unitIndex]}`
  }

  function isSupportedMedia(file) {
    const mimeType = file.type?.toLowerCase() || ''
    const extension = file.name.split('.').pop()?.toLowerCase()
    if (!MEDIA_FILE_EXTENSIONS.includes(extension)) return false

    return (
      !mimeType ||
      mimeType === 'application/octet-stream' ||
      mimeType.startsWith('image/') ||
      mimeType.startsWith('video/') ||
      mimeType.startsWith('audio/')
    )
  }

  function fileKey(file) {
    return `${file.name}:${file.size}:${file.lastModified}`
  }

  function prepareFiles(value) {
    const selectedFiles = Array.isArray(value) ? value : value ? [value] : []
    const supportedFiles = selectedFiles.filter(isSupportedMedia)
    const rejectedCount = selectedFiles.length - supportedFiles.length

    if (rejectedCount > 0) {
      toastStore.warning(
        `${rejectedCount} unsupported file${rejectedCount === 1 ? ' was' : 's were'} skipped. Select an image, video, or audio file.`,
      )
    }

    const existingFiles = new Set(filesToUpload.value.map(fileKey))
    for (const file of supportedFiles) {
      const key = fileKey(file)
      if (!existingFiles.has(key)) {
        filesToUpload.value.push(file)
        existingFiles.add(key)
      }
    }

    if (filesToUpload.value.length > MEDIA_UPLOAD_MAX_FILES) {
      filesToUpload.value.splice(MEDIA_UPLOAD_MAX_FILES)
      toastStore.warning(
        `You can upload up to ${MEDIA_UPLOAD_MAX_FILES} media files at once. Extra files were skipped.`,
      )
    }

    if (isOverLimit.value) {
      toastStore.warning(
        `Selected media exceeds the ${maxMediaUploadMb} MiB upload limit. Remove some files before uploading.`,
      )
    }
  }

  function removeFile(index) {
    if (!isUploading.value) {
      filesToUpload.value.splice(index, 1)
    }
  }

  function clearFiles() {
    filesToUpload.value = []
    uploadProgress.value = 0
  }

  function onCancel() {
    if (canCancelUpload.value) {
      uploadController.value?.abort()
      return
    }

    if (isUploading.value) return

    clearFiles()
  }

  function getErrorMessage(error) {
    const responseError = error?.response?.data?.error

    if (typeof responseError === 'string' && responseError.trim()) {
      return responseError
    }
    if (Array.isArray(responseError)) {
      const messages = responseError.filter(
        (message) => typeof message === 'string' && message.trim(),
      )
      if (messages.length) return messages.join(' ')
    }
    if (
      responseError &&
      typeof responseError === 'object' &&
      typeof responseError.message === 'string'
    ) {
      return responseError.message
    }

    return error?.message || 'Media upload failed. Please try again.'
  }

  function getSuccessMessage(data, fallbackCount) {
    const uploadedCount = Array.isArray(data?.files)
      ? data.files.length
      : fallbackCount

    return `${uploadedCount} media file${uploadedCount === 1 ? '' : 's'} uploaded successfully.`
  }

  function handleUploadResult(data, originalFiles) {
    const uploadedFiles = Array.isArray(data?.files) ? data.files : []
    const errors = Array.isArray(data?.errors) ? data.errors : []
    const scanWarnings = uploadedFiles.filter((file) => file?.warning)

    if (errors.length) {
      const failedFields = new Set(errors.map((error) => error?.fieldName))
      filesToUpload.value = originalFiles.filter((_, index) =>
        failedFields.has(`files[${index}]`),
      )
      const firstError = errors.find((error) => error?.error)?.error
      const scanWarningMessage = scanWarnings.length
        ? ` Android could not refresh ${scanWarnings.length} uploaded item${scanWarnings.length === 1 ? '' : 's'} in the media library.`
        : ''
      toastStore.warning(
        `${uploadedFiles.length} uploaded, ${errors.length} failed.${firstError ? ` ${firstError}` : ''}${scanWarningMessage}`,
      )
      return
    }

    filesToUpload.value = []
    if (scanWarnings.length) {
      toastStore.warning(
        `${getSuccessMessage(data, originalFiles.length)} Android could not refresh ${scanWarnings.length} item${scanWarnings.length === 1 ? '' : 's'} in the media library.`,
      )
      return
    }

    toastStore.success(getSuccessMessage(data, originalFiles.length))
  }

  async function onUpload() {
    if (isUploading.value) return
    if (!adbStore.device) {
      toastStore.warning('Select a device before uploading media.')
      return
    }
    if (!filesToUpload.value.length) return
    if (isOverLimit.value) {
      toastStore.error(
        `The selected files total ${formatFileSize(totalSizeBytes.value)}. The upload limit is ${maxMediaUploadMb} MiB.`,
      )
      return
    }

    const controller = new AbortController()
    const files = [...filesToUpload.value]
    const device = adbStore.device

    uploadController.value = controller
    uploadDevice.value = device
    isUploading.value = true
    uploadProgress.value = 0

    try {
      const { data } = await fileUploadService.uploadMedia(files, device, {
        signal: controller.signal,
        onProgress: (progress) => {
          uploadProgress.value = progress
        },
      })
      handleUploadResult(data, files)
    } catch (error) {
      if (axios.isCancel(error)) {
        toastStore.info('Media upload cancelled.')
      } else {
        toastStore.error(getErrorMessage(error))
      }
    } finally {
      isUploading.value = false
      uploadDevice.value = null
      uploadController.value = null
      uploadProgress.value = 0
    }
  }

  onBeforeUnmount(() => {
    uploadController.value?.abort()
  })
</script>

<template>
  <div class="pt-2">
    <v-alert
      v-if="!adbStore.device"
      class="mb-4"
      density="compact"
      type="info"
      variant="tonal"
    >
      Select a device before uploading media.
    </v-alert>

    <v-chip
      v-else
      class="mb-4"
      color="primary"
      prepend-icon="mdi-cellphone-link"
      variant="tonal"
    >
      Target device: {{ uploadDevice || adbStore.device }}
    </v-chip>

    <v-file-input
      :model-value="filesToUpload"
      :accept="supportedMediaTypes"
      :clearable="false"
      :disabled="isUploading || !adbStore.device"
      chips
      counter
      hint="Images, videos, and audio files"
      label="Select media files"
      multiple
      persistent-hint
      prepend-icon="mdi-paperclip"
      variant="outlined"
      @update:model-value="prepareFiles"
    />

    <template v-if="filesToUpload.length">
      <div
        class="d-flex flex-wrap justify-space-between align-center mt-4 mb-2"
      >
        <strong class="text-secondary">Media files to upload</strong>
        <span class="text-caption">
          {{ formatFileSize(totalSizeBytes) }} / {{ maxMediaUploadMb }} MiB
        </span>
      </div>

      <v-alert
        v-if="isOverLimit"
        class="mb-3"
        density="compact"
        type="error"
        variant="tonal"
      >
        The selected files total {{ formatFileSize(totalSizeBytes) }}. The
        maximum size per upload is {{ maxMediaUploadMb }} MiB. Remove some files
        before uploading.
      </v-alert>

      <v-table density="compact">
        <thead>
          <tr>
            <th class="text-left">Name</th>
            <th class="text-left">Size</th>
            <th class="text-center">Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(file, index) in filesToUpload" :key="fileKey(file)">
            <td class="text-left">{{ file.name }}</td>
            <td class="text-left">{{ formatFileSize(file.size) }}</td>
            <td class="text-center">
              <v-btn
                v-tooltip="'Remove'"
                :disabled="isUploading"
                color="red"
                icon="mdi-close"
                size="small"
                variant="text"
                @click="removeFile(index)"
              />
            </td>
          </tr>
        </tbody>
      </v-table>

      <div v-if="isUploading" class="mt-4">
        <div class="d-flex justify-space-between mb-1 text-caption">
          <span>
            {{
              uploadProgress >= 100
                ? `Copying media to ${uploadDevice}…`
                : 'Sending files to the server…'
            }}
          </span>
          <span v-if="uploadProgress > 0"> {{ uploadProgress }}% </span>
        </div>
        <v-progress-linear
          :indeterminate="uploadProgress === 0"
          :model-value="uploadProgress"
          color="secondary"
          height="4"
        />
      </div>

      <div class="d-flex mt-4">
        <v-btn
          :color="canCancelUpload ? 'error' : undefined"
          :disabled="isUploading && !canCancelUpload"
          class="mr-3"
          variant="text"
          @click="onCancel"
        >
          {{
            isUploading
              ? canCancelUpload
                ? 'Cancel upload'
                : 'Copying…'
              : 'Cancel'
          }}
        </v-btn>
        <v-btn
          :disabled="isUploading || isOverLimit || !adbStore.device"
          color="primary"
          @click="onUpload"
        >
          Upload to device
        </v-btn>
      </div>
    </template>
  </div>
</template>
