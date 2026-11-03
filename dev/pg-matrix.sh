#!/usr/bin/env bash
# Runs the zetta binary against real Postgres servers across every auth method,
# TLS on and off, and every sslmode, and checks each outcome. Expected results
# follow libpq's behaviour (src/interfaces/libpq/t/005_negotiate_encryption.pl).
#
#   dev/pg-matrix.sh [path/to/zetta]
#
# Needs docker and openssl. Leaves nothing running.
set -euo pipefail
unset PGHOST PGHOSTADDR PGPORT PGUSER PGPASSWORD PGDATABASE PGSSLMODE PGSSLROOTCERT PGPASSFILE PGCHANNELBINDING

ZETTA=$(realpath "${1:-zig-out/bin/zetta}")
WORK=$(mktemp -d)
TLS_NAME=zetta-matrix-tls
PLAIN_NAME=zetta-matrix-plain
TLS_PORT=55501
PLAIN_PORT=55502

cleanup() {
	# A clean shutdown removes the socket files, which belong to the container's user.
	docker stop -t 10 "$TLS_NAME" "$PLAIN_NAME" >/dev/null 2>&1 || true
	docker rm -f "$TLS_NAME" "$PLAIN_NAME" >/dev/null 2>&1 || true
	rm -rf "$WORK"
}
trap cleanup EXIT

# A private CA, a server certificate for "localhost" only (no IP), and an unrelated CA.
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=zetta test CA" \
	-keyout "$WORK/ca.key" -out "$WORK/ca.crt" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=localhost" \
	-keyout "$WORK/server.key" -out "$WORK/server.csr" 2>/dev/null
printf 'subjectAltName=DNS:localhost\n' >"$WORK/san.ext"
openssl x509 -req -in "$WORK/server.csr" -CA "$WORK/ca.crt" -CAkey "$WORK/ca.key" -CAcreateserial \
	-days 2 -extfile "$WORK/san.ext" -out "$WORK/server.crt" 2>/dev/null
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=other CA" \
	-keyout "$WORK/other.key" -out "$WORK/other.crt" 2>/dev/null

cat >"$WORK/pg_hba.conf" <<'EOF'
local     all  all                   trust
hostssl   all  ssl_user    all       scram-sha-256
hostnossl all  nossl_user  all       scram-sha-256
host      all  scram_user  all       scram-sha-256
host      all  md5_user    all       md5
host      all  clear_user  all       password
host      all  trust_user  all       trust
host      all  postgres    all       scram-sha-256
EOF

cat >"$WORK/users.sql" <<'EOF'
create role scram_user login password 'scram-pw';
create role ssl_user login password 'ssl-pw';
create role nossl_user login password 'nossl-pw';
create role clear_user login password 'clear-pw';
create role trust_user login;
set password_encryption = 'md5';
create role md5_user login password 'md5-pw';
EOF

mkdir -p "$WORK/socket"
chmod 777 "$WORK/socket"
start() {
	local name=$1 port=$2 ssl=$3
	docker run -d --name "$name" -p "127.0.0.1:$port:5432" \
		-e POSTGRES_PASSWORD=super -v "$WORK:/conf:ro" \
		-v "$WORK/users.sql:/docker-entrypoint-initdb.d/users.sql:ro" \
		$([ "$ssl" = on ] && printf -- '-v %s:/var/run/postgresql' "$WORK/socket") \
		postgres:17-alpine sh -c "cp /conf/server.crt /conf/server.key /conf/pg_hba.conf /tmp/ \
			&& chown postgres /tmp/server.key && chmod 600 /tmp/server.key \
			&& exec docker-entrypoint.sh postgres -c ssl=$ssl -c ssl_cert_file=/tmp/server.crt \
			   -c ssl_key_file=/tmp/server.key -c hba_file=/tmp/pg_hba.conf" >/dev/null
}
start "$TLS_NAME" "$TLS_PORT" on
start "$PLAIN_NAME" "$PLAIN_PORT" off
for name in "$TLS_NAME" "$PLAIN_NAME"; do
	for _ in $(seq 60); do
		docker exec "$name" pg_isready -U postgres -h 127.0.0.1 -q 2>/dev/null && break
		sleep 1
	done
done
# The init script runs before the final server start; wait for that restart too.
sleep 2

pass=0
fail=0
# check NAME DSN EXPECT [VAR=value], where EXPECT is "ssl", "plain" or
# "fail:<text the error must contain>".
check() {
	local name=$1 dsn=$2 expect=$3 extra_env=${4:-} out status got
	set +e
	out=$(env $extra_env "$ZETTA" query "$dsn" "select coalesce((select ssl::text from pg_stat_ssl where pid = pg_backend_pid()), 'false')" -f csv 2>&1)
	status=$?
	set -e
	if [ $status -eq 0 ]; then
		case "$(printf '%s' "$out" | tail -n 1 | tr -d '\r')" in
			true) got=ssl ;;
			false) got=plain ;;
			*) got="ok?:$out" ;;
		esac
	else
		got="fail:$out"
	fi
	local ok=0
	case "$expect" in
		fail:*) [[ $got == fail:* && $got == *"${expect#fail:}"* ]] && ok=1 ;;
		*) [ "$got" = "$expect" ] && ok=1 ;;
	esac
	if [ $ok = 1 ]; then
		pass=$((pass + 1))
		printf '  ok    %-52s %s\n' "$name" "${expect%%:*}"
	else
		fail=$((fail + 1))
		printf '  FAIL  %-52s want %s\n        got %s\n' "$name" "$expect" "$got"
	fi
}

T="127.0.0.1:$TLS_PORT"
L="localhost:$TLS_PORT"
P="127.0.0.1:$PLAIN_PORT"
CA="sslrootcert=$WORK/ca.crt"

echo "server with TLS"
check "scram, sslmode=disable" "postgres://scram_user:scram-pw@$T/postgres?sslmode=disable" plain
check "scram, sslmode=allow" "postgres://scram_user:scram-pw@$T/postgres?sslmode=allow" plain
check "scram, sslmode=prefer" "postgres://scram_user:scram-pw@$T/postgres?sslmode=prefer" ssl
check "scram, default sslmode is prefer" "postgres://scram_user:scram-pw@$T/postgres" ssl
check "scram, sslmode=require" "postgres://scram_user:scram-pw@$T/postgres?sslmode=require" ssl
check "verify-ca with the right CA" "postgres://scram_user:scram-pw@$T/postgres?sslmode=verify-ca&$CA" ssl
check "verify-full, name in the certificate" "postgres://scram_user:scram-pw@$L/postgres?sslmode=verify-full&$CA" ssl
check "verify-full, IP not in the certificate" "postgres://scram_user:scram-pw@$T/postgres?sslmode=verify-full&$CA" "fail:SSL connection"
check "verify-ca with an unrelated CA" "postgres://scram_user:scram-pw@$T/postgres?sslmode=verify-ca&sslrootcert=$WORK/other.crt" "fail:SSL connection"
check "verify-full against the system store" "postgres://scram_user:scram-pw@$L/postgres?sslmode=verify-full&sslrootcert=system" "fail:SSL connection"
check "require with sslrootcert checks the chain" "postgres://scram_user:scram-pw@$T/postgres?sslmode=require&sslrootcert=$WORK/other.crt" "fail:SSL connection"
check "md5 over TLS" "postgres://md5_user:md5-pw@$T/postgres" ssl
check "md5 in plaintext" "postgres://md5_user:md5-pw@$T/postgres?sslmode=disable" plain
check "cleartext password over TLS" "postgres://clear_user:clear-pw@$T/postgres" ssl
check "trust needs no password" "postgres://trust_user@$T/postgres?sslmode=disable" plain
check "wrong password" "postgres://scram_user:nope@$T/postgres" "fail:password authentication failed"
check "missing password" "postgres://scram_user@$T/postgres?passfile=/nonexistent" "fail:no password supplied"
check "hostssl user, sslmode=disable" "postgres://ssl_user:ssl-pw@$T/postgres?sslmode=disable" "fail:no pg_hba.conf entry"
check "hostssl user, sslmode=allow retries with TLS" "postgres://ssl_user:ssl-pw@$T/postgres?sslmode=allow" ssl
check "hostssl user, sslmode=prefer" "postgres://ssl_user:ssl-pw@$T/postgres?sslmode=prefer" ssl
check "hostnossl user, sslmode=prefer retries plain" "postgres://nossl_user:nossl-pw@$T/postgres?sslmode=prefer" plain
check "hostnossl user, sslmode=require" "postgres://nossl_user:nossl-pw@$T/postgres?sslmode=require" "fail:no pg_hba.conf entry"
check "channel_binding=require is refused" "postgres://scram_user:scram-pw@$T/postgres?channel_binding=require" "fail:channel binding"
check "keyword string form" "host=127.0.0.1 port=$TLS_PORT user=scram_user password=scram-pw dbname=postgres sslmode=require" ssl
check "Unix socket" "postgres:///postgres?host=$WORK/socket&user=trust_user" plain
check "password from PGPASSWORD" "postgres://scram_user@$T/postgres" ssl PGPASSWORD=scram-pw

echo "server without TLS"
check "sslmode=prefer falls back to plain" "postgres://postgres:super@$P/postgres?sslmode=prefer" plain
check "sslmode=require fails" "postgres://postgres:super@$P/postgres?sslmode=require" "fail:server does not support SSL"
check "sslmode=disable" "postgres://postgres:super@$P/postgres?sslmode=disable" plain
check "unreachable port" "postgres://postgres:super@127.0.0.1:1/postgres" "fail:connection to server"
check "unknown host name" "postgres://postgres:super@no-such-host.invalid/postgres" "fail:could not translate host name"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
