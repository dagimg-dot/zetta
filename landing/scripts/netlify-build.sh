#!/usr/bin/env bash
# Netlify's build for the landing page. Its build image has neither Zig nor a pinned Bun, and the
# demo's zetta.wasm needs both, so this fetches them, checks Zig against its published hash, and
# builds web/ (embedded in the wasm) and then landing/.
set -euo pipefail

ZIG_VERSION=0.16.0
BUN_VERSION=1.4.0

root=$(cd "$(dirname "$0")/../.." && pwd)
tools="$root/.tools"

case "$(uname -m)" in
x86_64) arch=x86_64 sha=70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00 ;;
aarch64 | arm64) arch=aarch64 sha=ea4b09bfb22ec6f6c6ceac57ab63efb6b46e17ab08d21f69f3a48b38e1534f17 ;;
*)
	echo "no Zig $ZIG_VERSION build for $(uname -m)" >&2
	exit 1
	;;
esac

zig="$tools/zig-$arch-linux-$ZIG_VERSION/zig"
if [ ! -x "$zig" ]; then
	mkdir -p "$tools"
	archive="$tools/zig-$ZIG_VERSION.tar.xz"
	curl -fsSL "https://ziglang.org/download/$ZIG_VERSION/zig-$arch-linux-$ZIG_VERSION.tar.xz" -o "$archive"
	echo "$sha  $archive" | sha256sum -c -
	tar -xJf "$archive" -C "$tools"
fi

if [ "$(bun --version 2>/dev/null || true)" != "$BUN_VERSION" ]; then
	curl -fsSL https://bun.sh/install | bash -s "bun-v$BUN_VERSION"
	export PATH="$HOME/.bun/bin:$PATH"
fi

(cd "$root/web" && bun install --frozen-lockfile)
(cd "$root/landing" && bun install --frozen-lockfile && ZIG="$zig" bun run build)
