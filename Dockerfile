FROM node:20-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
# Render / 云构建时传入：--build-arg VITE_API_BASE=https://你的后端.onrender.com
ARG VITE_API_BASE=
ENV VITE_API_BASE=$VITE_API_BASE
RUN npm run build

FROM nginx:1.27-alpine
# 默认用云配置（无 backend 主机名）；本地 compose 可通过 build.args 覆盖为 nginx.conf
ARG NGINX_CONF=nginx.cloud.conf
COPY ${NGINX_CONF} /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
