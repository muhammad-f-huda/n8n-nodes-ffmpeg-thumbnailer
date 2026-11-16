# n8n-nodes-ffmpeg-thumbnailer

An n8n node that generates a thumbnail image from a video using **FFmpeg**.

Takes a video (binary data from a previous node, or a file already on the n8n host)
and outputs the captured frame as binary data, ready for further nodes.

## Requirements

The node shells out to `ffmpeg` and `ffprobe`, so both must be installed on the
machine running n8n and available on `PATH`.

### Ubuntu / Debian

```bash
sudo apt-get update
sudo apt-get install -y ffmpeg
```

### macOS

```bash
brew install ffmpeg
```

### Windows

Download a build from <https://www.gyan.dev/ffmpeg/builds/> (or `choco install ffmpeg`),
extract it, and add the `bin` folder to your `PATH`.

### Docker

If n8n runs in Docker, FFmpeg must be installed in the image.

Recent `n8nio/n8n` images (2.x) are Docker Hardened Images: the `apk` binary is
removed, so `RUN apk add ffmpeg` fails with exit code 127. Copying the Alpine
package's binaries plus their `ldd` libraries is also not enough, because
`ffmpeg` dlopens some libraries (for example SDL3) that `ldd` does not report,
and the process then dies from a signal.

Use statically linked binaries instead:

```dockerfile
FROM mwader/static-ffmpeg:8.1.2 AS ffmpeg

FROM n8nio/n8n:2.47.7

USER root
COPY --from=ffmpeg /ffmpeg /ffprobe /usr/local/bin/
USER node
```

A ready-to-use version of this Dockerfile and a `docker-compose.yaml` live in
`./n8n-ffmpeg`. Build the image and start n8n with:

```bash
cd n8n-ffmpeg
docker compose up -d --build
```

n8n is then available at <http://localhost:5678>. Stop it with `docker compose down`.

### Verify

```bash
ffmpeg -version
ffprobe -version
```

The n8n process must be able to run these commands. Restart n8n after installing.

## Installation

```bash
npm install
npm run build
```

Then install the folder as a community node in n8n, or copy `dist/` plus
`package.json` into your n8n custom nodes directory and restart n8n.

## Usage

1. Add an **FFmpeg Thumbnailer** node.
2. Choose the **Source**:
   - `Binary Data` – read the video from a binary property of the incoming item.
   - `File Path` – read the video from an absolute path on the n8n host.
3. Choose the **Timestamp**:
   - `First Frame` – frame at the start of the video.
   - `Specific Second` – capture at a given second (e.g. `12.5`).
   - `Percentage of Duration` – capture at a percentage of the video length
     (e.g. `25` = a quarter in). Requires `ffprobe`.
4. Optionally set **Width** / **Height** (0 = keep the source dimension) and
   **Quality** for JPEG.
5. The thumbnail is written to the **Output Binary Property** (default `thumbnail`).

## Output

```json
{
  "json": {
    "fileName": "thumbnail.jpg",
    "fileSize": 45632,
    "mimeType": "image/jpeg",
    "timestamp": 5,
    "source": "clip.mp4"
  },
  "binary": {
    "thumbnail": {
      "fileName": "thumbnail.jpg",
      "mimeType": "image/jpeg",
      "data": "<buffer>"
    }
  }
}
```

## Parameters

| Parameter | Description |
| --- | --- |
| Source | `Binary Data` or `File Path` |
| Binary Property | Binary property holding the video (binary source only) |
| File Path | Absolute path to the video (file path source only) |
| Timestamp | `First Frame`, `Specific Second`, or `Percentage of Duration` |
| Timestamp Value | Seconds, or percentage 0-100 |
| Output Format | `JPEG` or `PNG` |
| Width / Height | Output size in pixels; 0 keeps the source dimension |
| Quality | JPEG quality 1-100 (higher is better) |
| Output Binary Property | Where the thumbnail is written (default `thumbnail`) |
| Output File Name | Base name without extension (default `thumbnail`) |

## Errors

The node throws a node error when something fails, for example:

- FFmpeg / ffprobe not installed or not on `PATH`
- Video file not found or not readable
- Unsupported or corrupt video
- Timestamp outside the video duration
- Invalid percentage

Enable **Continue On Fail** on the node to emit the error message as JSON instead
of stopping the workflow.

## Cleanup

Videos received as binary data are written to a temporary folder
(`n8n-ffmpeg-thumbnailer-*` under the OS temp directory) and removed after the
thumbnail is generated — also when generation fails. The thumbnail itself is
piped straight out of FFmpeg, so no intermediate image file is left on disk.

## License

MIT
