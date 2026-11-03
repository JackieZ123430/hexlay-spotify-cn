#!/bin/bash
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
DEPS="$HERE/deps"
SRC="$DEPS/ffmpeg-4.4.4"
PREFIX="$DEPS/install"

echo "=== Configuring Minimal Static FFmpeg ==="
cd "$SRC"

# Configure with ONLY H.264 decoder and MP4/HLS demuxers, NO external libraries
./configure \
    --prefix="$PREFIX" \
    --pkg-config-flags="--static" \
    --enable-static \
    --disable-shared \
    --disable-programs \
    --disable-doc \
    --disable-avdevice \
    --disable-postproc \
    --disable-avfilter \
    --disable-network \
    --disable-everything \
    --enable-avcodec \
    --enable-avformat \
    --enable-swscale \
    --enable-avutil \
    --enable-decoder=h264 \
    --enable-parser=h264 \
    --enable-demuxer=mov,mp4,m4a,hls,mpegts \
    --enable-protocol=file,pipe \
    --disable-x86asm \
    --extra-cflags="-O2 -fPIC"

echo "=== Compiling Static FFmpeg (parallel) ==="
make -j$(nproc)
make install
echo "=== Minimal Static FFmpeg Built Successfully ==="
ls -lh "$PREFIX/lib/"*.a
