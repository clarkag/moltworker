FROM docker.io/cloudflare/sandbox:0.7.0

# Install Node.js 22 (required by OpenClaw) and rclone (for R2 persistence).
#
# IMPORTANT: Do NOT replace the base image's system runtime in /usr/local.
# Cloudflare's sandbox agent runs inside this image and expects the base layout.
# We install Node 22 side-by-side and call it explicitly for OpenClaw.
ENV NODE22_VERSION=22.13.1
ENV NODE22_DIR=/opt/node22
RUN ARCH="$(dpkg --print-architecture)" \
    && case "${ARCH}" in \
         amd64) NODE_ARCH="x64" ;; \
         arm64) NODE_ARCH="arm64" ;; \
         *) echo "Unsupported architecture: ${ARCH}" >&2; exit 1 ;; \
       esac \
    && apt-get update && apt-get install -y xz-utils ca-certificates rclone \
    && mkdir -p "${NODE22_DIR}" \
    && curl -fsSLk "https://nodejs.org/dist/v${NODE22_VERSION}/node-v${NODE22_VERSION}-linux-${NODE_ARCH}.tar.xz" -o /tmp/node22.tar.xz \
    && tar -xJf /tmp/node22.tar.xz -C "${NODE22_DIR}" --strip-components=1 \
    && rm /tmp/node22.tar.xz \
    && "${NODE22_DIR}/bin/node" --version \
    && "${NODE22_DIR}/bin/npm" --version

# Install pnpm globally
RUN PATH="${NODE22_DIR}/bin:${PATH}" "${NODE22_DIR}/bin/npm" install -g pnpm

# Install OpenClaw (formerly clawdbot/moltbot) and ClawHub (skill registry CLI)
# Use latest stable OpenClaw so new models (e.g. claude-sonnet-4.6) are available.
RUN PATH="${NODE22_DIR}/bin:${PATH}" "${NODE22_DIR}/bin/npm" install -g openclaw@latest clawhub \
    && PATH="${NODE22_DIR}/bin:${PATH}" "${NODE22_DIR}/bin/openclaw" --version

# Create OpenClaw directories
# Legacy .clawdbot paths are kept for R2 backup migration
RUN mkdir -p /root/.openclaw \
    && mkdir -p /root/clawd \
    && mkdir -p /root/clawd/skills

# Copy startup script
# Build cache bust: 2026-02-11-v30-rclone
COPY start-openclaw.sh /usr/local/bin/start-openclaw.sh
RUN chmod +x /usr/local/bin/start-openclaw.sh

# Copy custom skills
COPY skills/ /root/clawd/skills/

# Set working directory
WORKDIR /root/clawd

# Expose the gateway port
EXPOSE 18789
