#!/usr/bin/env bash
set -euo pipefail

MONGOS_HOST="${MONGOS_HOST:-mongos}"
SHARDS="${SHARDS:-shard0,shard1,shard2}"
SHARD_DB="${SHARD_DB:-tixwar}"
HA_MEMBERS="${HA_MEMBERS:-}"
CONFIG_SET="${CONFIG_SET:-cfg}"
SHARD_PORT="${SHARD_PORT:-27018}"
CONFIG_PORT="${CONFIG_PORT:-27019}"

SHARDED_COLLECTIONS="orders payments tickets outboxEvents processedEvents auditLogs"
CONFIG_HOSTS="mongo-config-1:$CONFIG_PORT,mongo-config-2:$CONFIG_PORT,mongo-config-3:$CONFIG_PORT"

log() { printf '[mongo-init] %s\n' "$*"; }

shard_container() {
  printf 'mongo-shard-%s' "${1#shard}"
}

shard_host() {
  printf '%s:%s' "$(shard_container "$1")" "$SHARD_PORT"
}

wait_for_ping() {
  local host="$1" port="$2" label="$3"
  for _ in $(seq 1 120); do
    if mongosh --host "$host" --port "$port" --quiet --eval "db.adminCommand({ping:1}).ok" >/dev/null 2>&1; then
      log "$label reachable"
      return 0
    fi
    sleep 1
  done
  log "ERROR: $label not reachable"
  return 1
}

wait_for_primary() {
  local label="$1" port="$2"
  shift 2
  for _ in $(seq 1 180); do
    for host in "$@"; do
      if mongosh --host "$host" --port "$port" --quiet --eval \
        "if (db.hello().isWritablePrimary) { quit(0) } else { quit(1) }" >/dev/null 2>&1; then
        log "$label is primary on $host"
        return 0
      fi
    done
    sleep 1
  done
  log "ERROR: $label did not become primary"
  return 1
}

primary_host() {
  local port="$1"
  shift
  for host in "$@"; do
    local out
    out=$(mongosh --host "$host" --port "$port" --quiet --eval "db.hello().primary" 2>/dev/null || true)
    if [ -n "$out" ] && [ "$out" != "null" ]; then
      printf '%s' "${out%%:*}"
      return 0
    fi
  done
  return 1
}

initiate_set() {
  local host="$1" port="$2" setname="$3" member="$4"
  local state
  state=$(mongosh --host "$host" --port "$port" --quiet --eval \
    "try { rs.status().ok } catch (e) { 0 }" 2>/dev/null || echo 0)
  if [ "$state" != "1" ]; then
    log "initiating replica set $setname"
    mongosh --host "$host" --port "$port" --quiet --eval \
      "rs.initiate({_id: '$setname', members: [{_id: 0, host: '$member'}]})" >/dev/null
  else
    log "replica set $setname already initiated"
  fi
}

add_member() {
  local host="$1" port="$2" member="$3"
  mongosh --host "$host" --port "$port" --quiet --eval \
    "try { rs.add({host: '$member'}); print('added $member') } catch (e) { if (e.codeName === 'AlreadyExists' || e.code === 23) { print('member exists') } else { throw e } }" >/dev/null 2>&1 || \
    log "warning: could not add member $member"
}

log "waiting for config servers"
for host in mongo-config-1 mongo-config-2 mongo-config-3; do
  wait_for_ping "$host" "$CONFIG_PORT" "$host"
done

initiate_set mongo-config-1 "$CONFIG_PORT" "$CONFIG_SET" "mongo-config-1:$CONFIG_PORT"
wait_for_primary "$CONFIG_SET" "$CONFIG_PORT" mongo-config-1 mongo-config-2 mongo-config-3
config_primary=$(primary_host "$CONFIG_PORT" mongo-config-1 mongo-config-2 mongo-config-3)
for host in mongo-config-2 mongo-config-3; do
  add_member "$config_primary" "$CONFIG_PORT" "$host:$CONFIG_PORT"
done

log "waiting for shard servers"
for shard in ${SHARDS//,/ }; do
  wait_for_ping "$(shard_container "$shard")" "$SHARD_PORT" "$shard"
done

for shard in ${SHARDS//,/ }; do
  host=$(shard_container "$shard")
  initiate_set "$host" "$SHARD_PORT" "$shard" "$(shard_host "$shard")"
  wait_for_primary "$shard" "$SHARD_PORT" "$host"
done

if [ -n "$HA_MEMBERS" ]; then
  log "adding HA secondary members"
  for member in ${HA_MEMBERS//,/ }; do
    shard="${member#mongo-shard-}"
    shard="${shard%-ha}"
    if mongosh --host "$member" --port "$SHARD_PORT" --quiet --eval \
      "db.adminCommand({ping:1}).ok" >/dev/null 2>&1; then
      shard_primary=$(primary_host "$SHARD_PORT" "mongo-shard-$shard" "$member" || true)
      add_member "${shard_primary:-mongo-shard-$shard}" "$SHARD_PORT" "$member:$SHARD_PORT"
    else
      log "ha member $member not running, skipping"
    fi
  done
fi

log "waiting for mongos"
for _ in $(seq 1 120); do
  if mongosh --host "$MONGOS_HOST" --port 27017 --quiet --eval "db.adminCommand({listShards:1}).ok" >/dev/null 2>&1; then
    log "mongos ready"
    break
  fi
  sleep 1
done

existing_shards=$(mongosh --host "$MONGOS_HOST" --port 27017 --quiet --eval \
  "db.adminCommand({listShards:1}).shards.map(s => s._id).join(',')" 2>/dev/null || echo "")
log "existing shards: ${existing_shards:-none}"

for shard in ${SHARDS//,/ }; do
  case ",$existing_shards," in
    *",$shard,"*) log "shard $shard already registered" ;;
    *)
      log "adding shard $shard"
      shard_host_value=$(shard_host "$shard")
      mongosh --host "$MONGOS_HOST" --port 27017 --quiet --eval \
        "db.adminCommand({addShard: '$shard/$shard_host_value', name: '$shard'})" >/dev/null
      ;;
  esac
done

mongosh --host "$MONGOS_HOST" --port 27017 --quiet --eval \
  "try { db.adminCommand({enableSharding: '$SHARD_DB'}) } catch (e) { if (e.code !== 23) { throw e } }" >/dev/null
log "sharding enabled for $SHARD_DB"

for collection in $SHARDED_COLLECTIONS; do
  sharded=$(mongosh --host "$MONGOS_HOST" --port 27017 --quiet --eval \
    "db.getSiblingDB('config').collections.countDocuments({_id: '$SHARD_DB.$collection'})" 2>/dev/null || echo 0)
  if [ "$sharded" = "1" ]; then
    log "$collection already sharded"
    continue
  fi
  log "sharding $SHARD_DB.$collection on { userId: 1 }"
  mongosh --host "$MONGOS_HOST" --port 27017 --quiet --eval \
    "db.adminCommand({shardCollection: '$SHARD_DB.$collection', key: {userId: 1}})" >/dev/null
done

log "cluster initialization complete"
mongosh --host "$MONGOS_HOST" --port 27017 --quiet --eval \
  "db.adminCommand({listShards:1}).shards.forEach(s => print('  shard ' + s._id + ' -> ' + s.host))"
