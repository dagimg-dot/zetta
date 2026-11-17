# syntax=docker/dockerfile:1

# zetta as one static binary on scratch, cross-compiled on the build machine.
#
#   docker build -t zetta --build-arg ZETTA_COMMIT=$(git rev-parse --short HEAD) .
#   docker buildx build --platform linux/amd64,linux/arm64 -t zetta .
#   export ZETTA_TOKEN=$(openssl rand -hex 16)
#   docker run --rm -p 127.0.0.1:1993:1993 -e ZETTA_TOKEN -e DATABASE_URL=postgres://... zetta
#
# The container listens on 0.0.0.0, so zetta needs ZETTA_TOKEN to start. Plain HTTP is accepted
# below because `docker run -p` decides what is reachable; publish on 127.0.0.1 unless a TLS proxy
# is in front.

ARG ZIG_VERSION=0.16.0


FROM --platform=$BUILDPLATFORM oven/bun:1.4.0-alpine AS web

WORKDIR /src/web
COPY web/package.json web/bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile
COPY web/ ./
RUN bun run build


FROM --platform=$BUILDPLATFORM alpine:3.22 AS build

ARG ZIG_VERSION
ARG BUILDARCH

# Zig is downloaded once into a cache mount and verified on every build.
RUN --mount=type=cache,target=/var/cache/zig-download \
    set -eu; \
    case "$BUILDARCH" in \
      amd64) arch=x86_64;  sum=70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00 ;; \
      arm64) arch=aarch64; sum=ea4b09bfb22ec6f6c6ceac57ab63efb6b46e17ab08d21f69f3a48b38e1534f17 ;; \
      *) echo "unsupported build architecture: $BUILDARCH" >&2; exit 1 ;; \
    esac; \
    name="zig-${arch}-linux-${ZIG_VERSION}.tar.xz"; \
    file="/var/cache/zig-download/${name}"; \
    for attempt in 1 2 3; do \
      echo "${sum}  ${file}" | sha256sum -c - >/dev/null 2>&1 && break; \
      wget -q -T 30 -O "${file}.part" "https://ziglang.org/download/${ZIG_VERSION}/${name}" \
        && mv "${file}.part" "${file}" \
        || echo "download attempt ${attempt} failed" >&2; \
    done; \
    echo "${sum}  ${file}" | sha256sum -c -; \
    mkdir -p /opt/zig; \
    tar -xJf "${file}" -C /opt/zig --strip-components=1

# scratch has no user database, and the Postgres driver finds ~/.pgpass through HOME.
RUN echo 'zetta:x:65532:65532:zetta:/:/zetta' > /tmp/passwd \
 && echo 'zetta:x:65532:' > /tmp/group

WORKDIR /src
COPY build.zig build.zig.zon ./
COPY vendor/ vendor/
COPY src/ src/
COPY --from=web /src/web/dist/index.html.gz web/dist/index.html.gz
COPY --from=web /src/web/dist/csp.txt web/dist/csp.txt

# Declared here so that a new commit only reruns this step.
ARG TARGETARCH
ARG ZETTA_COMMIT=unknown
RUN --mount=type=cache,target=/root/.cache/zig \
    set -eu; \
    case "$TARGETARCH" in \
      amd64) target=x86_64-linux-musl ;; \
      arm64) target=aarch64-linux-musl ;; \
      *) echo "unsupported target architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    /opt/zig/zig build \
      -Doptimize=ReleaseSafe \
      -Dtarget="$target" \
      -Dcpu=baseline \
      -Dui=prebuilt \
      -Dcommit="$ZETTA_COMMIT"


FROM scratch

COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=build /tmp/passwd /tmp/group /etc/
COPY --from=build /src/zig-out/bin/zetta /zetta

USER 65532:65532
ENV HOME=/ \
    ZETTA_HOST=0.0.0.0 \
    ZETTA_ALLOW_PLAIN_HTTP=true \
    ZETTA_PORT=1993 \
    ZETTA_WAIT=30
EXPOSE 1993

ENTRYPOINT ["/zetta"]
CMD ["serve"]
