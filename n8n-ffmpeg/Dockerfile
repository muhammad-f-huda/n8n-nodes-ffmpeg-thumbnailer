# n8nio/n8n 2.22.x is a Docker Hardened Image: the apk binary is deleted from
# the final image, so FFmpeg cannot be installed there (apk -> exit 127).
# Use statically linked binaries instead: no shared libraries, so nothing can be
# missing at runtime and nothing clashes with the libraries of the n8n image.
FROM mwader/static-ffmpeg:8.1.2 AS ffmpeg

FROM n8nio/n8n:2.22.3

USER root
COPY --from=ffmpeg /ffmpeg /ffprobe /usr/local/bin/
USER node
