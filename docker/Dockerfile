# rea-mcp image (openspec: container-image). Build from the repository root:
#
#   docker build -f docker/Dockerfile -t rea-mcp:dev .
#
# Four stages on one pinned base. Only the last one ships; curl and unzip stay behind in the
# download stages. Every third-party archive is verified against a SHA-256 before it is used.
# The evidence for each pinned value is in docs/DESIGN.md: Ghidra in section 8, the base image
# and JDK in section 9.

# ---- base: Node 24 on Debian bookworm, pinned by tag AND digest (DESIGN.md 9.2) -------------------
# REA admits Node 24 only from 24.22.1 (DESIGN.md 2.1); this tag resolved to 24.22.3. The tag moves,
# the digest does not; Dependabot (.github/dependabot.yml) proposes new digests, never a new major.
FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS base
# The Ghidra and JDK archives below are x86-64 builds, so any other platform is refused at once,
# whatever the builder defaults to (build with --platform linux/amd64 on a non-amd64 host).
RUN test "$(dpkg --print-architecture)" = "amd64" \
 || { echo "rea-mcp images are linux/amd64 only: the Ghidra and JDK archives are x86-64 builds" >&2; exit 1; }

# ---- ghidra: download, verify, unpack (DESIGN.md section 8) ---------------------------------------
FROM base AS ghidra
ARG GHIDRA_VERSION=12.1.4
ARG GHIDRA_URL=https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_12.1.4_build/ghidra_12.1.4_PUBLIC_20260921.zip
RUN export DEBIAN_FRONTEND=noninteractive \
 && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/*
RUN curl --fail --silent --show-error --location --retry 3 --proto '=https' --tlsv1.2 \
      --output /tmp/ghidra.zip "${GHIDRA_URL}"
# The hash is declared after the download so that changing it re-runs only this check. It fails the
# build, and no image is produced, when the archive is not the one that was pinned.
ARG GHIDRA_SHA256=ddac49f903da9d5bac833e5cc79395098b9c33cfd3279be5f31bd00387d2d4db
RUN set -eux; \
    echo "${GHIDRA_SHA256}  /tmp/ghidra.zip" | sha256sum --check --strict -; \
    unzip -q /tmp/ghidra.zip -d /tmp/ghidra-unpacked; \
    # The archive's one top-level directory becomes the install root: GHIDRA_INSTALL_DIR must be
    # the directory that holds support/analyzeHeadless (DESIGN.md 8.1).
    mv "/tmp/ghidra-unpacked/ghidra_${GHIDRA_VERSION}_PUBLIC" /opt/ghidra; \
    rm -rf /tmp/ghidra.zip /tmp/ghidra-unpacked; \
    test -x /opt/ghidra/support/analyzeHeadless; \
    grep -qx "application.version=${GHIDRA_VERSION}" /opt/ghidra/Ghidra/application.properties; \
    test -x /opt/ghidra/Ghidra/Features/Decompiler/os/linux_x86_64/decompile

# ---- jdk: Eclipse Temurin 21, because bookworm packages no JDK 21 (DESIGN.md 9.1, 9.3) -----------
# Ghidra 12.1.4 declares JDK 21 as its minimum (DESIGN.md 8.1) and REA needs a full JDK with javac.
# Fetched and verified exactly like Ghidra. Nothing updates it: bump the version, URL and hash by hand.
FROM base AS jdk
ARG JDK_URL=https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.13%2B9/OpenJDK21U-jdk_x64_linux_hotspot_21.0.13_9.tar.gz
RUN export DEBIAN_FRONTEND=noninteractive \
 && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
RUN curl --fail --silent --show-error --location --retry 3 --proto '=https' --tlsv1.2 \
      --output /tmp/jdk.tar.gz "${JDK_URL}"
ARG JDK_SHA256=d7f5d5cf865a2902b70ff549b97586a7d3f234e016f041ab447ea740c7d66d1c
RUN set -eux; \
    echo "${JDK_SHA256}  /tmp/jdk.tar.gz" | sha256sum --check --strict -; \
    mkdir /opt/jdk; \
    tar -xzf /tmp/jdk.tar.gz -C /opt/jdk --strip-components=1; \
    rm /tmp/jdk.tar.gz; \
    test -x /opt/jdk/bin/java; \
    test -x /opt/jdk/bin/javac

# ---- build: compile the gateway, then keep only its production dependencies -------------------------
# `npm ci` honours the lockfile (so rea-agents is exactly the committed version) and .npmrc
# (ignore-scripts=true). Nothing here runs `rea-agents setup`, which edits agent configuration.
FROM base AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build \
 && npm prune --omit=dev

# ---- runtime: what ships ------------------------------------------------------------------------------
FROM base AS runtime

# tshark reads capture files only (it never captures); binutils gives objdump; procps gives ps, which
# REA's own checks use; tini is the init process. --no-install-recommends keeps the Wireshark GUI and
# other optional packages out. libcap2-bin arrives as a hard dependency of wireshark-common
# (DESIGN.md 9.4). rizin is not packaged for bookworm, so it is omitted (DESIGN.md 9.1).
RUN export DEBIAN_FRONTEND=noninteractive \
 && apt-get update \
 && apt-get install -y --no-install-recommends binutils procps tini tshark \
 && rm -rf /var/lib/apt/lists/*

# Third-party programs, owned by root and read-only to the runtime user. Their licence and notice
# files travel with them: /opt/ghidra/LICENSE, /opt/ghidra/licenses and /opt/ghidra/GPL/licenses,
# and /opt/jdk/NOTICE and /opt/jdk/legal. This project's own licence is /app/LICENSE.
COPY --from=ghidra /opt/ghidra /opt/ghidra
COPY --from=jdk /opt/jdk /opt/jdk

# The gateway: compiled code and production dependencies, including the pinned rea-agents.
COPY --from=build /app/package.json /app/package.json
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/dist /app/dist
COPY LICENSE /app/LICENSE

# uid 99 / gid 100 is unRAID's nobody:users. gid 100 is the `users` group Debian already has. An
# account entry is created so that tools which look the current user up by number find one.
# /work is owned by that user, so that it works even when nothing is mounted over it. /tmp must stay
# world-writable: REA puts each Ghidra session's private runtime under it (DESIGN.md 2.6).
RUN set -eux; \
    useradd --system --uid 99 --gid 100 --no-create-home --home-dir /work/home --shell /usr/sbin/nologin rea-mcp; \
    mkdir -p -m 0700 /work/home /work/sessions; \
    chown -R 99:100 /work; \
    mkdir -m 0755 /samples; \
    chmod 1777 /tmp

COPY --chmod=0755 docker/entrypoint.sh /usr/local/bin/rea-mcp-entrypoint

# JAVA_HOME and PATH point at the Temurin JDK. TMPDIR is deliberately not set: Ghidra aborts on a
# project path with a dot-prefixed element, so a TMPDIR like /work/.tmp would break it.
ENV NODE_ENV=production \
    PORT=8080 \
    HOME=/work/home \
    JAVA_HOME=/opt/jdk \
    GHIDRA_INSTALL_DIR=/opt/ghidra \
    PATH=/opt/jdk/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

LABEL org.opencontainers.image.title="rea-mcp" \
      org.opencontainers.image.description="Remote MCP gateway for REA (rea-agents), with Ghidra, tshark and objdump" \
      org.opencontainers.image.source="https://github.com/EGuthrieWasTaken/rea-mcp" \
      org.opencontainers.image.licenses="GPL-3.0-only"

# Samples are mounted read-only; /work holds Ghidra output, per-session directories and the optional
# checkpoint root. Declared after the directories above are prepared, which is when a VOLUME freezes
# its contents.
VOLUME ["/samples", "/work"]
WORKDIR /work
EXPOSE 8080

# No curl in this stage, so the probe is Node's own fetch against the unauthenticated /healthz.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||'8080')+'/healthz',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

USER 99:100

# tini is PID 1: it forwards SIGTERM to the gateway and reaps orphaned processes. The entrypoint script
# checks that /work and /tmp are writable and creates /work/home and /work/sessions, then runs the CMD.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/rea-mcp-entrypoint"]
CMD ["node", "/app/dist/main.js"]
