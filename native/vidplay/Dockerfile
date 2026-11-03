FROM ubuntu:18.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc g++ make libc6-dev pkg-config file ca-certificates \
    libavcodec-dev libavformat-dev libswscale-dev libavutil-dev \
    libva-dev libasound2-dev zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
