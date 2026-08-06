# default

## Project setup

```
# yarn
yarn

# npm
npm install

# pnpm
pnpm install
```

### Compiles and hot-reloads for development

```
# yarn
yarn dev

# npm
npm run dev

# pnpm
pnpm dev
```

### Compiles and minifies for production

```
# yarn
yarn build

# npm
npm run build

# pnpm
pnpm build
```

### Media upload limit

Set `VITE_MAX_MEDIA_UPLOAD_MB` at build time to change the maximum total size
of one media upload. It defaults to 94 MiB and should match the backend limit.
The default leaves room for multipart overhead below Cloudflare's 100 MB cap.

### Customize configuration

See [Configuration Reference](https://vitejs.dev/config/).
