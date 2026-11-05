# Makefile for mgu-vidplay (BMW iDrive 7 Video Engine)
CC ?= gcc
CFLAGS ?= -O2 -g0 -Wall -Wextra -Wno-unused-parameter -D_GNU_SOURCE
PREFIX ?= deps/install

CFLAGS += -I$(PREFIX)/include
STATIC_LIBS = $(PREFIX)/lib/libavformat.a \
              $(PREFIX)/lib/libavcodec.a \
              $(PREFIX)/lib/libswscale.a \
              $(PREFIX)/lib/libavutil.a

SYS_LIBS = -lm -lz -lpthread -ldl
LDFLAGS = -Wl,--dynamic-linker=/lib/ld-linux-x86-64.so.2

all: build/mgu-vidplay

build/mgu-vidplay: vidplay.c
	@mkdir -p build
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ vidplay.c $(STATIC_LIBS) $(SYS_LIBS)
	strip $@

clean:
	rm -rf build

.PHONY: all clean
