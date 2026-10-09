# syntax=docker/dockerfile:1
# 微信消息台镜像。构建：docker build -t wxrobot-web wechat-web
# 运行：docker run -d -p 127.0.0.1:8787:8787 -v wxrobot-data:/data ghcr.io/smallsmartmouse/wxrobot-web

# 编译阶段：在构建机的架构上交叉编译，纯 Go（SQLite 驱动也是纯 Go），不需要 C 编译器。
FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG TARGETOS TARGETARCH
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /out/wechat-web . \
    && mkdir -p /out/data /out/app && ln -s /data /out/app/.state

# 运行阶段：只含程序本身，以非 root 用户运行。数据库、图片都在 /data。
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/wechat-web /app/wechat-web
COPY --from=build --chown=nonroot:nonroot /out/data /data
COPY --from=build /out/app/ /app/
VOLUME /data
EXPOSE 8787
# 容器内需监听所有地址，并允许经过 Docker 网桥转发的请求；端口只映射到宿主机 127.0.0.1。
WORKDIR /app
COPY config.docker.json /app/config.json
ENTRYPOINT ["/app/wechat-web"]
