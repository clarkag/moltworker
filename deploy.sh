#!/usr/bin/env bash
# Deploy molted-sandbox Worker. Uses system Docker socket so container build works
# when DOCKER_HOST points at a user socket that isn't connected to the daemon.
set -e
export DOCKER_HOST="${DOCKER_HOST:-unix:///var/run/docker.sock}"
cd "$(dirname "$0")"
npm run deploy
