//! Password authentication: SCRAM-SHA-256 (RFC 5802, RFC 7677) and the legacy MD5 scheme.
//! Channel binding (-PLUS) and SASLprep are not implemented; ASCII passwords are unaffected.

const std = @import("std");
const mem = std.mem;
const base64 = std.base64.standard;
const HmacSha256 = std.crypto.auth.hmac.sha2.HmacSha256;
const Sha256 = std.crypto.hash.sha2.Sha256;
const Md5 = std.crypto.hash.Md5;

pub const Error = error{ AuthFailed, ProtocolViolation };

/// 18 random bytes, base64-encoded, as libpq does.
pub const nonce_len = base64.Encoder.calcSize(18);

pub const Scram = struct {
    nonce_buf: [32]u8 = undefined,
    nonce_len: usize = 0,
    /// "n=<user>,r=<nonce>", kept for the AuthMessage.
    first_bare: [256]u8 = undefined,
    first_bare_len: usize = 0,
    server_signature: [Sha256.digest_length]u8 = undefined,

    pub fn init(random: *const [18]u8) Scram {
        var s: Scram = .{ .nonce_len = nonce_len };
        _ = base64.Encoder.encode(s.nonce_buf[0..nonce_len], random);
        return s;
    }

    /// A fixed nonce, for known-answer tests.
    pub fn initWithNonce(fixed: []const u8) Scram {
        var s: Scram = .{ .nonce_len = fixed.len };
        @memcpy(s.nonce_buf[0..fixed.len], fixed);
        return s;
    }

    fn clientNonce(s: *const Scram) []const u8 {
        return s.nonce_buf[0..s.nonce_len];
    }

    /// Postgres ignores the SCRAM user name and uses the startup user, so libpq sends it empty.
    pub fn clientFirst(s: *Scram, user: []const u8, out: []u8) ![]const u8 {
        const bare = try std.fmt.bufPrint(&s.first_bare, "n={s},r={s}", .{ user, s.clientNonce() });
        s.first_bare_len = bare.len;
        return std.fmt.bufPrint(out, "n,,{s}", .{bare});
    }

    /// Takes "r=...,s=...,i=..." and returns "c=biws,r=...,p=...".
    pub fn clientFinal(s: *Scram, server_first: []const u8, password: []const u8, out: []u8) ![]const u8 {
        var nonce: ?[]const u8 = null;
        var salt_b64: ?[]const u8 = null;
        var iterations: ?u32 = null;
        var it = mem.splitScalar(u8, server_first, ',');
        while (it.next()) |attr| {
            if (attr.len < 2 or attr[1] != '=') return error.ProtocolViolation;
            switch (attr[0]) {
                'r' => nonce = attr[2..],
                's' => salt_b64 = attr[2..],
                'i' => iterations = std.fmt.parseInt(u32, attr[2..], 10) catch return error.ProtocolViolation,
                else => {},
            }
        }
        const server_nonce = nonce orelse return error.ProtocolViolation;
        if (!mem.startsWith(u8, server_nonce, s.clientNonce())) return error.ProtocolViolation;
        const rounds = iterations orelse return error.ProtocolViolation;

        var salt_buf: [128]u8 = undefined;
        const salt_len = base64.Decoder.calcSizeForSlice(salt_b64 orelse return error.ProtocolViolation) catch return error.ProtocolViolation;
        if (salt_len > salt_buf.len) return error.ProtocolViolation;
        base64.Decoder.decode(salt_buf[0..salt_len], salt_b64.?) catch return error.ProtocolViolation;

        var salted: [Sha256.digest_length]u8 = undefined;
        std.crypto.pwhash.pbkdf2(&salted, password, salt_buf[0..salt_len], rounds, HmacSha256) catch return error.ProtocolViolation;

        var client_key: [HmacSha256.mac_length]u8 = undefined;
        HmacSha256.create(&client_key, "Client Key", &salted);
        var stored_key: [Sha256.digest_length]u8 = undefined;
        Sha256.hash(&client_key, &stored_key, .{});

        const without_proof_len = (try std.fmt.bufPrint(out, "c=biws,r={s}", .{server_nonce})).len;
        const without_proof = out[0..without_proof_len];

        var mac = HmacSha256.init(&stored_key);
        mac.update(s.first_bare[0..s.first_bare_len]);
        mac.update(",");
        mac.update(server_first);
        mac.update(",");
        mac.update(without_proof);
        var client_signature: [HmacSha256.mac_length]u8 = undefined;
        mac.final(&client_signature);

        var proof: [HmacSha256.mac_length]u8 = undefined;
        for (&proof, client_key, client_signature) |*p, k, sig| p.* = k ^ sig;

        var server_key: [HmacSha256.mac_length]u8 = undefined;
        HmacSha256.create(&server_key, "Server Key", &salted);
        var smac = HmacSha256.init(&server_key);
        smac.update(s.first_bare[0..s.first_bare_len]);
        smac.update(",");
        smac.update(server_first);
        smac.update(",");
        smac.update(without_proof);
        smac.final(&s.server_signature);

        const proof_b64_len = base64.Encoder.calcSize(proof.len);
        if (without_proof_len + 3 + proof_b64_len > out.len) return error.ProtocolViolation;
        @memcpy(out[without_proof_len..][0..3], ",p=");
        _ = base64.Encoder.encode(out[without_proof_len + 3 ..][0..proof_b64_len], &proof);
        return out[0 .. without_proof_len + 3 + proof_b64_len];
    }

    /// Checks "v=<server signature>", which proves the server knew the password too.
    pub fn verifyServerFinal(s: *const Scram, server_final: []const u8) Error!void {
        if (!mem.startsWith(u8, server_final, "v=")) return error.AuthFailed;
        var got: [Sha256.digest_length]u8 = undefined;
        const b64 = mem.trimEnd(u8, server_final[2..], ",");
        if ((base64.Decoder.calcSizeForSlice(b64) catch return error.AuthFailed) != got.len) return error.AuthFailed;
        base64.Decoder.decode(&got, b64) catch return error.AuthFailed;
        if (!std.crypto.timing_safe.eql([Sha256.digest_length]u8, got, s.server_signature)) return error.AuthFailed;
    }
};

/// "md5" ++ hex(md5(hex(md5(password ++ user)) ++ salt)), 35 bytes.
pub fn md5Password(user: []const u8, password: []const u8, salt: [4]u8) [35]u8 {
    var inner: [Md5.digest_length]u8 = undefined;
    var h = Md5.init(.{});
    h.update(password);
    h.update(user);
    h.final(&inner);
    const inner_hex = std.fmt.bytesToHex(inner, .lower);

    var outer: [Md5.digest_length]u8 = undefined;
    h = Md5.init(.{});
    h.update(&inner_hex);
    h.update(&salt);
    h.final(&outer);

    var out: [35]u8 = undefined;
    @memcpy(out[0..3], "md5");
    out[3..].* = std.fmt.bytesToHex(outer, .lower);
    return out;
}

const testing = std.testing;

test "SCRAM-SHA-256 matches the RFC 7677 example exchange" {
    // RFC 7677 section 3: user "user", password "pencil".
    var s = Scram.initWithNonce("rOprNGfwEbeRWgbNEkqO");
    var out: [256]u8 = undefined;
    try testing.expectEqualStrings("n,,n=user,r=rOprNGfwEbeRWgbNEkqO", try s.clientFirst("user", &out));
    const final = try s.clientFinal("r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096", "pencil", &out);
    try testing.expectEqualStrings(
        "c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,p=dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=",
        final,
    );
    try s.verifyServerFinal("v=6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=");
    try testing.expectError(error.AuthFailed, s.verifyServerFinal("v=AAAATRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4="));
}

test "a server nonce that does not extend ours is refused" {
    var s = Scram.init(&@splat(7));
    var out: [256]u8 = undefined;
    _ = try s.clientFirst("", &out);
    try testing.expectError(error.ProtocolViolation, s.clientFinal("r=someoneelse,s=AAAA,i=4096", "pw", &out));
}

test "client-first carries no channel binding and an empty user, as libpq sends" {
    var s = Scram.init(&@splat(0));
    var out: [128]u8 = undefined;
    const first = try s.clientFirst("", &out);
    try testing.expect(mem.startsWith(u8, first, "n,,n=,r="));
    try testing.expectEqual(3 + 3 + 2 + nonce_len, first.len);
}

test "md5 password hashing matches an independent reference" {
    // Python: "md5" + md5(md5(b"secret" + b"alice").hexdigest().encode() + b"\x01\x02\x03\x04").hexdigest()
    const got = md5Password("alice", "secret", .{ 1, 2, 3, 4 });
    try testing.expectEqualStrings("md598a0412b9c31436fc53776e863350083", &got);
}
