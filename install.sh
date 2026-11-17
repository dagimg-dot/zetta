#!/bin/sh
# Installs zetta from a GitHub release on Linux (x86_64, arm64) or macOS (Apple Silicon).
#
#   curl -fsSL https://raw.githubusercontent.com/dagimg-dot/zetta/main/install.sh | sh
#
# ZETTA_VERSION picks a release such as 0.1.0 (default: the latest).
# ZETTA_INSTALL_DIR picks the directory (default: /usr/local/bin when writable, else ~/.local/bin).
set -eu

repo=dagimg-dot/zetta

say() { printf '%s\n' "$*" >&2; }
die() {
	say "error: $*"
	exit 1
}

fetch() {
	if command -v curl >/dev/null 2>&1; then
		curl -fsSL --retry 3 -o "$2" "$1" || die "could not download $1"
	elif command -v wget >/dev/null 2>&1; then
		wget -q -O "$2" "$1" || die "could not download $1"
	else
		die "curl or wget is required"
	fi
}

sha256_check() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum -c - >/dev/null
	elif command -v shasum >/dev/null 2>&1; then
		shasum -a 256 -c - >/dev/null
	else
		die "sha256sum or shasum is required"
	fi
}

case "$(uname -s)" in
Linux) os=linux ;;
Darwin) os=macos ;;
*) die "no build for $(uname -s); see https://github.com/$repo/releases" ;;
esac

case "$(uname -m)" in
x86_64 | amd64) arch=x86_64 ;;
aarch64 | arm64) arch=aarch64 ;;
*) die "no build for $(uname -m); see https://github.com/$repo/releases" ;;
esac

if [ "$os" = macos ]; then
	# A shell under Rosetta reports x86_64 on Apple Silicon.
	if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = 1 ]; then
		arch=aarch64
	fi
	[ "$arch" = aarch64 ] || die "zetta is built for Apple Silicon only on macOS"
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

# The latest release is found through its SHA256SUMS, whose archive names carry the version,
# so no GitHub API call (and its rate limit) is needed.
version=${ZETTA_VERSION:-}
if [ -n "$version" ]; then
	base="https://github.com/$repo/releases/download/v${version#v}"
else
	base="https://github.com/$repo/releases/latest/download"
fi
fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS"

line=$(grep -E "  zetta-[^ ]+-$os-$arch\.tar\.gz\$" "$tmp/SHA256SUMS" | head -n 1)
[ -n "$line" ] || die "the release has no archive for $os $arch"
archive=${line##* }
version=${archive#zetta-}
version=${version%-"$os-$arch".tar.gz}
base="https://github.com/$repo/releases/download/v$version"

say "Downloading zetta $version for $os $arch"
fetch "$base/$archive" "$tmp/$archive"
(cd "$tmp" && printf '%s\n' "$line" | sha256_check) || die "checksum mismatch for $archive"

tar -xzf "$tmp/$archive" -C "$tmp"

dir=${ZETTA_INSTALL_DIR:-}
if [ -z "$dir" ]; then
	if [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; then
		dir=/usr/local/bin
	else
		dir="$HOME/.local/bin"
	fi
fi
mkdir -p "$dir"
cp "$tmp/zetta-$version-$os-$arch/zetta" "$dir/.zetta.new"
chmod 755 "$dir/.zetta.new"
mv -f "$dir/.zetta.new" "$dir/zetta"

say "Installed $("$dir/zetta" --version) to $dir/zetta"
case ":$PATH:" in
*":$dir:"*) ;;
*) say "$dir is not on your PATH. Add it, for example: export PATH=\"$dir:\$PATH\"" ;;
esac
