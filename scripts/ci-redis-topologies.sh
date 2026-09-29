#!/usr/bin/env bash
# Bring up the two Redis topologies that a `services:` block cannot express, run
# whatever it is given, and tear them down.
#
#   scripts/ci-redis-topologies.sh up      start, wait, export the two URIs
#   scripts/ci-redis-topologies.sh down    stop and remove
#
# `services:` maps one container to one port, and a cluster is three masters and
# a sentinel set is a master, a replica and a sentinel. Both are started with
# `--network host`, which is what makes the addresses agree: the nodes have to
# reach *each other* to form the topology, and the test process runs on the
# runner, so everything has to be reachable as 127.0.0.1 from inside the
# containers and from outside them. A user-defined bridge would make the nodes
# agree on container names and the client would then have to be told how to map
# those back. On a Linux runner --network host avoids that translation entirely.
#
# Linux only, which is every runner this runs on. `--network host` is not
# available in Docker Desktop on macOS or Windows.
#
# The cluster is three masters and no replicas. That is the minimum for all
# 16384 hash slots to be covered, so a key can be written and read back, and it
# is enough to prove that topology discovery, slot mapping and MOVED handling
# work. A failover is not exercised: that needs replicas and seconds of
# propagation, and a test that waits on a failover is a test that flakes.
#
# The sentinel set is one master, one replica and one sentinel. The replica is
# started so the set is a real set rather than a sentinel watching a single
# node, but the failover is not triggered. One sentinel is what the URI form can
# name: `redis-sentinel://host:port/master-name` carries a single sentinel
# address, so a three-sentinel deployment is not something this server can be
# pointed at, and testing three would not test the code.

set -euo pipefail

CLUSTER_PORTS=(7000 7001 7002)
MASTER_PORT=6379
REPLICA_PORT=6380
SENTINEL_PORT=26379
MASTER_NAME=mymaster
NAMES=()

log()  { echo "::notice title=redis-topologies::$1"; }

# `fail` calls the diagnostic dump itself rather than relying on the ERR trap:
# a trap fires when a *command* fails, and `fail` ends in `exit`, which never
# triggers one. The first run of this script failed with a bare exit code 1 and
# no output at all, which is the one thing a setup script must not do.
fail() {
  echo "::error::$1"
  cleanup_on_error 1
  exit 1
}

cleanup_on_error() {
  # `${1:-$?}` rather than `$?`: inside a function, `$?` is the status of the
  # call, not the argument. `cleanup_on_error 1` from `fail` has to report the 1.
  local code=${1:-$?}
  if [ $code -ne 0 ]; then
    echo "::error::topology setup failed with exit $code"
    # The state of each container, because the reason a `docker run` did not take
    # is in there and not in the exit code: a mount that cannot be written, a
    # port already taken, a config redis rejected.
    echo "::error title=containers::$(docker ps -a --format '{{.Names}} {{.Status}}' 2>&1 | tr '\n' ';')"
    for name in "${NAMES[@]:-}"; do
      [ -n "$name" ] || continue
      echo "--- $name ---"
      docker logs --tail 15 "$name" 2>&1 || true
    done
  fi
  return $code
}

wait_for() {
  local name=$1 port=$2 tries=${3:-60} i=0
  while [ $i -lt "$tries" ]; do
    if docker exec "$name" redis-cli -p "$port" ping 2>/dev/null | grep -q PONG; then
      return 0
    fi
    i=$((i + 1))
    sleep 1
  done
  return 1
}

start_cluster() {
  local port i
  for port in "${CLUSTER_PORTS[@]}"; do
    local name="anydb-cluster-$port"
    NAMES+=("$name")
    docker run -d --rm --name "$name" --network host \
      redis:7-alpine redis-server \
      --port "$port" \
      --cluster-enabled yes \
      --cluster-config-file "nodes-$port.conf" \
      --cluster-node-timeout 5000 \
      --appendonly no \
      --save '' >/dev/null
    wait_for "$name" "$port" || fail "$name never answered PING"
  done

  # The three nodes have to agree on who is in the cluster, and 127.0.0.1 works
  # for that because they share the host's network namespace.
  local nodes
  nodes=$(printf '127.0.0.1:%s ' "${CLUSTER_PORTS[@]}")
  docker exec anydb-cluster-${CLUSTER_PORTS[0]} \
    redis-cli --cluster create $nodes --cluster-replicas 0 --cluster-yes >/dev/null 2>&1 \
    || fail 'redis-cli --cluster create failed'

  # cluster_state:ok is the only answer that means every slot is covered. Until
  # it appears, a SET can land on a node that has no slot for it and fail.
  local i=0
  while [ $i -lt 60 ]; do
    local state
    state=$(docker exec anydb-cluster-${CLUSTER_PORTS[0]} redis-cli -p "${CLUSTER_PORTS[0]}" cluster info 2>/dev/null \
      | tr -d '\r' | awk -F: '/^cluster_state:/{print $2}')
    [ "$state" = "ok" ] && { log "cluster formed, cluster_state:ok"; return 0; }
    i=$((i + 1))
    sleep 1
  done
  docker exec anydb-cluster-${CLUSTER_PORTS[0]} redis-cli -p "${CLUSTER_PORTS[0]}" cluster info 2>&1 | head -5 || true
  fail 'the cluster never reached cluster_state:ok'
}

start_sentinel_set() {
  NAMES+=(anydb-sentinel-master anydb-sentinel-replica anydb-sentinel)

  docker run -d --rm --name anydb-sentinel-master --network host \
    redis:7-alpine redis-server --port "$MASTER_PORT" --appendonly no --save '' >/dev/null
  wait_for anydb-sentinel-master "$MASTER_PORT" || fail 'the master never answered PING'

  docker run -d --rm --name anydb-sentinel-replica --network host \
    redis:7-alpine redis-server --port "$REPLICA_PORT" --replicaof 127.0.0.1 "$MASTER_PORT" \
    --appendonly no --save '' >/dev/null
  wait_for anydb-sentinel-replica "$REPLICA_PORT" || fail 'the replica never answered PING'

  # The sentinel has to be told the master as an address the *client* can reach.
  # 127.0.0.1 is that address here, because the client runs on the runner.
  #
  # The config is written *inside* the container rather than bind-mounted, and
  # that is the whole reason the first two attempts produced no sentinel at all.
  # A sentinel rewrites its own config on startup: it writes a sibling `.tmp` file
  # and renames it over the original, so it needs write permission on the
  # *directory*, not just on the file. A bind mount into `/usr/local/etc/redis`
  # is a directory the image's entrypoint never chowns, so the rewrite failed,
  # redis-server exited, and `--rm` removed the container - leaving only an exit
  # code with nothing in it. Writing into `/data` and exec'ing from there needs no
  # mount, no host file and no permission arithmetic.
  docker run -d --rm --name anydb-sentinel --network host \
    redis:7-alpine sh -c "printf 'sentinel monitor $MASTER_NAME 127.0.0.1 $MASTER_PORT\nsentinel down-after-milliseconds $MASTER_NAME 5000\nsentinel failover-timeout $MASTER_NAME 10000\n' > /data/sentinel.conf && exec redis-server /data/sentinel.conf --port $SENTINEL_PORT" >/dev/null \
    || fail 'the sentinel container refused to start'
  wait_for anydb-sentinel "$SENTINEL_PORT" || fail 'the sentinel never answered PING'
  local i=0
  while [ $i -lt 60 ]; do
    local reported
    reported=$(docker exec anydb-sentinel redis-cli -p "$SENTINEL_PORT" sentinel get-master-addr-by-name "$MASTER_NAME" 2>/dev/null | tr -d '\r')
    if [ -n "$reported" ] && [ "$reported" != "nil" ]; then
      log "sentinel is monitoring $MASTER_NAME at $reported"
      return 0
    fi
    i=$((i + 1))
    sleep 1
  done
  docker logs anydb-sentinel 2>&1 | tail -10 || true
  fail "the sentinel never reported an address for $MASTER_NAME"
}

case "${1:-}" in
  up)
    trap cleanup_on_error ERR
    start_cluster
    start_sentinel_set
    trap - ERR
    {
      echo "ANYDB_TEST_REDIS_CLUSTER=redis-cluster://127.0.0.1:${CLUSTER_PORTS[0]}"
      echo "ANYDB_TEST_REDIS_SENTINEL=redis-sentinel://127.0.0.1:${SENTINEL_PORT}/${MASTER_NAME}"
    } > "${2:?second argument is the file to write the URIs to}"
    log "wrote the topology URIs to $2"
    ;;
  down)
    for name in anydb-cluster-7000 anydb-cluster-7001 anydb-cluster-7002 \
                anydb-sentinel anydb-sentinel-master anydb-sentinel-replica; do
      docker rm -f "$name" >/dev/null 2>&1 || true
    done
    ;;
  *)
    echo "usage: $0 up <uri-file> | down" >&2
    exit 2
    ;;
esac
