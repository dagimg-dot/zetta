// The WASI calls zetta.wasm imports, answered in memory: one read-only directory, /data,
// holding the files it is given, plus clocks, randomness and stderr to the console.
// Anything that would write a file answers EROFS, since the demo is read-only.

/* exported MemoryWasi */
class MemoryWasi {
	static errno = { success: 0, badf: 8, inval: 28, isdir: 31, noent: 44, nosys: 52, notdir: 54, rofs: 69 };
	static filetype = { charDevice: 2, directory: 3, regularFile: 4 };
	static preopen = "/data";
	static dirFd = 3;

	/** @param {Record<string, Uint8Array>} files by name, inside /data */
	constructor(files) {
		this.files = files;
		/** @type {Map<number, {name: string, pos: number}>} */
		this.open = new Map();
		this.nextFd = 4;
		this.memory = null;
		this.lines = { 1: "", 2: "" };
	}

	/** Call once the instance exists, before its first export. */
	start(instance) {
		this.memory = instance.exports.memory;
		instance.exports._initialize();
	}

	view() {
		return new DataView(this.memory.buffer);
	}

	bytes(ptr, len) {
		return new Uint8Array(this.memory.buffer, ptr, len);
	}

	text(ptr, len) {
		return new TextDecoder().decode(this.bytes(ptr, len));
	}

	/** A path inside /data, or null for /data itself. */
	nameOf(ptr, len) {
		const name = this.text(ptr, len).replace(/^\.?\/+/, "");
		return name === "" || name === "." ? null : name;
	}

	writeStat(ptr, filetype, size) {
		const v = this.view();
		for (let i = 0; i < 64; i += 8) v.setBigUint64(ptr + i, 0n, true);
		v.setUint8(ptr + 16, filetype);
		v.setBigUint64(ptr + 24, 1n, true);
		v.setBigUint64(ptr + 32, BigInt(size), true);
	}

	/** Copies from `data` at `offset` into the iovecs; returns the count. */
	readInto(data, offset, iovs, iovsLen) {
		const v = this.view();
		let done = 0;
		for (let i = 0; i < iovsLen; i++) {
			const buf = v.getUint32(iovs + i * 8, true);
			const len = v.getUint32(iovs + i * 8 + 4, true);
			const chunk = data.subarray(offset + done, offset + done + len);
			this.bytes(buf, chunk.length).set(chunk);
			done += chunk.length;
			if (chunk.length < len) break;
		}
		return done;
	}

	imports() {
		const E = MemoryWasi.errno;
		const T = MemoryWasi.filetype;
		const file = (fd) => {
			const f = this.open.get(fd);
			return f ? { f, data: this.files[f.name] } : null;
		};
		const rofs = () => E.rofs;
		const nosys = () => E.nosys;
		return {
			wasi_snapshot_preview1: {
				args_get: () => E.success,
				args_sizes_get: (count, size) => {
					this.view().setUint32(count, 0, true);
					this.view().setUint32(size, 0, true);
					return E.success;
				},
				environ_get: () => E.success,
				environ_sizes_get: (count, size) => {
					this.view().setUint32(count, 0, true);
					this.view().setUint32(size, 0, true);
					return E.success;
				},
				clock_res_get: (_id, ptr) => {
					this.view().setBigUint64(ptr, 1000n, true);
					return E.success;
				},
				clock_time_get: (id, _precision, ptr) => {
					const ms = id === 0 ? Date.now() : performance.now();
					this.view().setBigUint64(ptr, BigInt(Math.round(ms * 1e6)), true);
					return E.success;
				},
				random_get: (ptr, len) => {
					for (let at = 0; at < len; at += 65536) {
						crypto.getRandomValues(this.bytes(ptr + at, Math.min(65536, len - at)));
					}
					return E.success;
				},
				proc_exit: (code) => {
					throw new Error(`zetta exited with code ${code}`);
				},
				poll_oneoff: nosys,

				fd_prestat_get: (fd, ptr) => {
					if (fd !== MemoryWasi.dirFd) return E.badf;
					this.view().setUint8(ptr, 0);
					this.view().setUint32(ptr + 4, MemoryWasi.preopen.length, true);
					return E.success;
				},
				fd_prestat_dir_name: (fd, ptr, len) => {
					if (fd !== MemoryWasi.dirFd) return E.badf;
					this.bytes(ptr, len).set(new TextEncoder().encode(MemoryWasi.preopen).subarray(0, len));
					return E.success;
				},
				fd_fdstat_get: (fd, ptr) => {
					const type =
						fd <= 2 ? T.charDevice : fd === MemoryWasi.dirFd ? T.directory : this.open.has(fd) ? T.regularFile : 0;
					if (!type) return E.badf;
					const v = this.view();
					v.setUint8(ptr, type);
					v.setUint16(ptr + 2, 0, true);
					v.setBigUint64(ptr + 8, 0xffffffffffffffffn, true);
					v.setBigUint64(ptr + 16, 0xffffffffffffffffn, true);
					return E.success;
				},
				fd_fdstat_set_flags: () => E.success,
				fd_filestat_get: (fd, ptr) => {
					if (fd === MemoryWasi.dirFd) {
						this.writeStat(ptr, T.directory, 0);
						return E.success;
					}
					const o = file(fd);
					if (!o) return E.badf;
					this.writeStat(ptr, T.regularFile, o.data.length);
					return E.success;
				},
				path_filestat_get: (dirFd, _flags, pathPtr, pathLen, ptr) => {
					if (dirFd !== MemoryWasi.dirFd) return E.badf;
					const name = this.nameOf(pathPtr, pathLen);
					if (name === null) {
						this.writeStat(ptr, T.directory, 0);
						return E.success;
					}
					const data = this.files[name];
					if (!data) return E.noent;
					this.writeStat(ptr, T.regularFile, data.length);
					return E.success;
				},
				path_open: (dirFd, _dirflags, pathPtr, pathLen, oflags, _base, _inheriting, _fdflags, fdPtr) => {
					if (dirFd !== MemoryWasi.dirFd) return E.badf;
					const name = this.nameOf(pathPtr, pathLen);
					const creat = 1;
					const directory = 2;
					const truncate = 8;
					if (name === null) return E.isdir;
					if (!this.files[name]) return oflags & creat ? E.rofs : E.noent;
					if (oflags & directory) return E.notdir;
					if (oflags & truncate) return E.rofs;
					const fd = this.nextFd++;
					this.open.set(fd, { name, pos: 0 });
					this.view().setUint32(fdPtr, fd, true);
					return E.success;
				},
				fd_close: (fd) => (this.open.delete(fd) ? E.success : E.badf),
				fd_seek: (fd, offset, whence, ptr) => {
					const o = file(fd);
					if (!o) return E.badf;
					const base = whence === 0 ? 0 : whence === 1 ? o.f.pos : o.data.length;
					const pos = base + Number(offset);
					if (pos < 0) return E.inval;
					o.f.pos = pos;
					this.view().setBigUint64(ptr, BigInt(pos), true);
					return E.success;
				},
				fd_read: (fd, iovs, iovsLen, nread) => {
					if (fd === 0) {
						this.view().setUint32(nread, 0, true);
						return E.success;
					}
					const o = file(fd);
					if (!o) return E.badf;
					const n = this.readInto(o.data, o.f.pos, iovs, iovsLen);
					o.f.pos += n;
					this.view().setUint32(nread, n, true);
					return E.success;
				},
				fd_pread: (fd, iovs, iovsLen, offset, nread) => {
					const o = file(fd);
					if (!o) return E.badf;
					this.view().setUint32(nread, this.readInto(o.data, Number(offset), iovs, iovsLen), true);
					return E.success;
				},
				fd_write: (fd, iovs, iovsLen, nwritten) => {
					if (fd !== 1 && fd !== 2) return this.open.has(fd) ? E.rofs : E.badf;
					const v = this.view();
					let n = 0;
					for (let i = 0; i < iovsLen; i++) {
						const buf = v.getUint32(iovs + i * 8, true);
						const len = v.getUint32(iovs + i * 8 + 4, true);
						this.lines[fd] += this.text(buf, len);
						n += len;
					}
					const lines = this.lines[fd].split("\n");
					this.lines[fd] = lines.pop() ?? "";
					for (const line of lines) (fd === 2 ? console.warn : console.log)(`zetta: ${line}`);
					v.setUint32(nwritten, n, true);
					return E.success;
				},
				fd_sync: () => E.success,
				fd_pwrite: rofs,
				fd_filestat_set_size: rofs,
				fd_filestat_set_times: rofs,
				fd_readdir: nosys,
				path_create_directory: rofs,
				path_filestat_set_times: rofs,
				path_link: rofs,
				path_readlink: nosys,
				path_remove_directory: rofs,
				path_rename: rofs,
				path_symlink: rofs,
				path_unlink_file: rofs,
			},
		};
	}
}
