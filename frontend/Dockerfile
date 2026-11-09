# Web image: build the SPA with Vite, then serve dist/ with nginx, which also proxies /api to the api service.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
# Install scripts stay off, as in development; the build does not need them.
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
RUN npm run build

FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
