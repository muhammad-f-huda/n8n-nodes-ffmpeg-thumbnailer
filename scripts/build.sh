#!/usr/bin/env bash
set -e
tsc
cp nodes/FfmpegThumbnailer/*.svg dist/nodes/FfmpegThumbnailer/
cp nodes/FfmpegImage/*.svg dist/nodes/FfmpegImage/
