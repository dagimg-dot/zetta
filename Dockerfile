# syntax=docker/dockerfile:1
#
# zetta as one static binary on scratch. The binary has no C dependencies beyond
# libc, so the build stage runs on the build machine and cross-compiles for the
# target: one machine builds both architectures without emulation.
#
#   docker build -t zetta --build-arg ZETTA_COMMIT=$(git rev-parse --short HEAD) .
#   docker buildx build --platform linux/amd64,linux/arm64 -t zetta .
#   docker run --rm -p 1993:1993 -e ZETTA_TOKEN=change-me -e DATABASE_URL=postgres://... zetta
#
# The container listens on 0.0.0.0, so zetta refuses to start without ZETTA_TOKEN.

ARG ZIG_VERSION=0.16.0

FROM --platform=$BUILDPLATFORM oven/bun:1.4.0-alpine AS web
WORKDIR /src/web
COPY web/package.json web/bun.lock ./
RUN bun install --frozen-lockfile
COPY web/ ./
RUN bun run build

FROM --platform=$BUILDPLATFORM alpine:3.22 AS build
ARG ZIG_VERSION
ARG BUILDARCH
ARG TARGETARCH
ARG ZETTA_COMMIT=unknown
RUN apk add --no-cache curl xz ca-certificates
RUN set -eu; \
    case "$BUILDARCH" in \
      amd64) arch=x86_64; sum=70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00 ;; \
      arm64) arch=aarch64; sum=ea4b09bfb22ec6f6c6ceac57ab63efb6b46e17ab08d21f69f3a48b38e1534f17 ;; \
      *) echo "unsupported build architecture: $BUILDARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/zig.tar.xz "https://ziglang.org/download/${ZIG_VERSION}/zig-${arch}-linux-${ZIG_VERSION}.tar.xz"; \
    echo "${sum}  /tmp/zig.tar.xz" | sha256sum -c -; \
    mkdir -p /opt/zig; \
    tar -xJf /tmp/zig.tar.xz -C /opt/zig --strip-components=1; \
    rm /tmp/zig.tar.xz
WORKDIR /src
COPY build.zig build.zig.zon ./
COPY vendor/ vendor/
COPY src/ src/
COPY --from=web /src/web/dist/index.html.gz web/dist/index.html.gz
RUN --mount=type=cache,target=/root/.cache/zig \
    set -eu; \
    case "$TARGETARCH" in \
      amd64) target=x86_64-linux-musl ;; \
      arm64) target=aarch64-linux-musl ;; \
      *) echo "unsupported target architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    /opt/zig/zig build -Doptimize=ReleaseSafe -Dui=prebuilt -Dtarget="$target" -Dcpu=baseline \
      -Dcommit="${ZETTA_COMMIT}"
# scratch has no user database; the Postgres driver reads ~/.pgpass via HOME.
RUN printf 'zetta:x:65532:65532:zetta:/:/zetta\n' > /tmp/passwd \
 && printf 'zetta:x:65532:\n' > /tmp/group

FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /tmp/passwd /etc/passwd
COPY --from=build /tmp/group /etc/group
COPY --from=build /src/zig-out/bin/zetta /zetta
USER 65532:65532
ENV HOME=/ \
    ZETTA_HOST=0.0.0.0 \
    ZETTA_PORT=1993
EXPOSE 1993
ENTRYPOINT ["/zetta"]
CMD ["serve"]
