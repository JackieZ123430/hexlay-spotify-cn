/*
 * mgu-vidplay - Native Hardware Video Player & Engine for BMW iDrive 7 (MGU).
 * Writes decoded 720p H.264 video frames into /dev/shm/mgu-video-<name> (Protocol 4),
 * rendered at 60 fps by mgu-renderd GPU compositor.
 *
 * Supports:
 *   - Direct MP4 streams, HLS (.m3u8), and local video files.
 *   - Automatic scaling & conversion to I420 (YUV420P) at target resolution (e.g. 1280x720).
 *   - Triple-buffering with atomic seq / slot update (no frame tearing).
 *   - Real-time PTS audio/video synchronization pacing.
 *   - IPC Control FIFO: pause, resume, seek, stop.
 *   - IPC Status FIFO: live timecode / duration / state JSON stream for iDrive UI.
 *   - Growing-file input (--grow <done-marker>): plays a local file while it is still being
 *     downloaded. Reads that reach the end of the written data wait (and report "buffering")
 *     until more data arrives or the done marker appears; --size tells the demuxer the final size.
 *   - Range input (--sock <unix socket> --size <bytes>): bytes come from the app over a Unix
 *     socket, one request at a time ("R <offset> <len>\n" -> 4-byte little-endian length + data;
 *     length 0 = end of file, 0xFFFFFFFF = error). The app fetches and caches the ranges, so the
 *     engine needs no network and no file, and seeking jumps straight to the needed bytes.
 *   - --nice <n>: lower CPU priority, so the HMI always comes first.
 */
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <stdbool.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <time.h>
#include <signal.h>
#include <errno.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/resource.h>
#include <sys/prctl.h>

#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libswscale/swscale.h>
#include <libavutil/imgutils.h>
#include <libavutil/time.h>
#include <libavutil/opt.h>

#define MGU_VIDEO_MAGIC 0x4656474du   /* "MGVF" */

struct mgu_video_head {
    uint32_t magic;    /* MGU_VIDEO_MAGIC (0x4656474d) */
    uint32_t version;  /* 1 */
    uint32_t w, h;     /* 1280, 720 (even, 16..2048) */
    uint32_t seq;      /* frames written so far */
    uint32_t slot;     /* newest written slot (0..nslot-1) */
    uint32_t nslot;    /* 3 slots (triple-buffering) */
    uint32_t matrix;   /* 1 = BT.709 (HD video) */
    uint32_t full;     /* 0 = limited range (16-235) */
    uint32_t pad[7];   /* 64 bytes total */
};

static volatile sig_atomic_t g_running = 1;
static volatile sig_atomic_t g_paused = 0;
static volatile int64_t g_seek_target_sec = -1;
static volatile sig_atomic_t g_resync = 0;   /* re-anchor the pacing clock (after a stall) */

static int g_ctrl_fd = -1;
static int g_status_fd = -1;
static double g_last_pts_sec = 0;
static double g_total_sec = 0;

#define GROW_POLL_US      40000      /* wait between checks for new data */
#define GROW_STATUS_US    500000     /* buffering status interval while stalled */
#define GROW_TIMEOUT_US   120000000  /* no new data for this long = give up */
#define SOCK_STALL_US     300000     /* a range answer slower than this counts as buffering */

static void sig_handler(int sig) {
    (void)sig;
    g_running = 0;
}

static int64_t get_time_us(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (int64_t)ts.tv_sec * 1000000LL + (ts.tv_nsec / 1000LL);
}

/* Check control FIFO for incoming commands from Node.js */
static void process_ctrl_fifo(int ctrl_fd, AVFormatContext *fmt_ctx, int video_idx) {
    if (ctrl_fd < 0) return;

    char buf[256];
    ssize_t n = read(ctrl_fd, buf, sizeof(buf) - 1);
    if (n <= 0) return;

    buf[n] = '\0';
    char *cmd = strtok(buf, "\r\n");
    while (cmd) {
        if (strcmp(cmd, "pause") == 0) {
            g_paused = 1;
            fprintf(stderr, "[vidplay] Paused\n");
        } else if (strcmp(cmd, "resume") == 0) {
            g_paused = 0;
            fprintf(stderr, "[vidplay] Resumed\n");
        } else if (strncmp(cmd, "seek ", 5) == 0) {
            double target_sec = atof(cmd + 5);
            if (target_sec >= 0) {
                g_seek_target_sec = (int64_t)(target_sec * AV_TIME_BASE);
                fprintf(stderr, "[vidplay] Seek requested to %.2f sec\n", target_sec);
            }
        } else if (strcmp(cmd, "stop") == 0 || strcmp(cmd, "quit") == 0) {
            fprintf(stderr, "[vidplay] Quit command received\n");
            g_running = 0;
        }
        cmd = strtok(NULL, "\r\n");
    }
}

/* Send JSON status update to status FIFO (non-blocking) */
static void send_status(int status_fd, double current_sec, double total_sec, bool playing, bool buffering) {
    if (status_fd < 0) return;
    char line[160];
    int len = snprintf(line, sizeof(line),
                      "{\"pts\":%.2f,\"dur\":%.2f,\"playing\":%s%s}\n",
                      current_sec, total_sec, playing ? "true" : "false",
                      buffering ? ",\"buffering\":true" : "");
    if (len > 0) {
        ssize_t ret = write(status_fd, line, len);
        (void)ret;
    }
}

/* ---------- Growing-file input ---------- */
struct grow_src {
    int fd;
    int64_t pos;
    int64_t size_hint;      /* final size if known (--size), else 0 */
    const char *done_path;  /* exists once the writer has finished */
    int64_t last_len;
    int64_t last_growth_us;
    int stalled;
};

static int grow_is_done(struct grow_src *g) {
    return g->done_path && access(g->done_path, F_OK) == 0;
}

static int64_t grow_len(struct grow_src *g) {
    struct stat st;
    return fstat(g->fd, &st) == 0 ? (int64_t)st.st_size : -1;
}

static int grow_read(void *opaque, uint8_t *buf, int buf_size) {
    struct grow_src *g = (struct grow_src *)opaque;
    int64_t last_status_us = 0;
    for (;;) {
        ssize_t n = pread(g->fd, buf, (size_t)buf_size, (off_t)g->pos);
        if (n > 0) {
            g->pos += n;
            if (g->stalled) {
                g->stalled = 0;
                g_resync = 1;
                fprintf(stderr, "[vidplay] Buffer refilled, resuming\n");
            }
            return (int)n;
        }
        if (n < 0) {
            if (errno == EINTR) continue;
            return AVERROR(errno);
        }
        /* n == 0: at the end of the written data */
        if (g->size_hint > 0 && g->pos >= g->size_hint) return AVERROR_EOF;
        if (grow_is_done(g)) {
            n = pread(g->fd, buf, (size_t)buf_size, (off_t)g->pos);   /* data written just before the marker */
            if (n > 0) { g->pos += n; return (int)n; }
            return AVERROR_EOF;
        }
        if (!g_running) return AVERROR_EXIT;

        int64_t now = get_time_us();
        int64_t len = grow_len(g);
        if (len != g->last_len) { g->last_len = len; g->last_growth_us = now; }
        if (now - g->last_growth_us > GROW_TIMEOUT_US) {
            fprintf(stderr, "[vidplay] No new data for %d s, giving up\n", GROW_TIMEOUT_US / 1000000);
            return AVERROR(ETIMEDOUT);
        }
        if (!g->stalled) {
            g->stalled = 1;
            fprintf(stderr, "[vidplay] Waiting for data at %lld bytes\n", (long long)g->pos);
        }
        if (now - last_status_us >= GROW_STATUS_US) {
            send_status(g_status_fd, g_last_pts_sec, g_total_sec, false, true);
            last_status_us = now;
        }
        process_ctrl_fifo(g_ctrl_fd, NULL, -1);   /* quit / pause / seek while waiting */
        usleep(GROW_POLL_US);
    }
}

static int64_t grow_seek(void *opaque, int64_t offset, int whence) {
    struct grow_src *g = (struct grow_src *)opaque;
    int64_t size = g->size_hint > 0 ? g->size_hint : (grow_is_done(g) ? grow_len(g) : -1);
    if (whence & AVSEEK_SIZE) return size;
    whence &= ~AVSEEK_FORCE;
    int64_t np;
    switch (whence) {
        case SEEK_SET: np = offset; break;
        case SEEK_CUR: np = g->pos + offset; break;
        case SEEK_END: if (size < 0) return AVERROR(ENOSYS); np = size + offset; break;
        default: return AVERROR(EINVAL);
    }
    if (np < 0) return AVERROR(EINVAL);
    g->pos = np;   /* past the written data is fine: the next read waits for it */
    return np;
}

/* ---------- Range input over a Unix socket ---------- */
struct sock_src {
    int fd;
    int64_t pos;
    int64_t size;
    int stalled;
};

static int write_all(int fd, const char *b, size_t n) {
    while (n > 0) {
        ssize_t k = send(fd, b, n, MSG_NOSIGNAL);
        if (k < 0) { if (errno == EINTR) continue; return -1; }
        b += k; n -= (size_t)k;
    }
    return 0;
}

/* Receive exactly n bytes; while waiting, report buffering and keep reading the control FIFO. */
static int sock_recv(struct sock_src *s, uint8_t *dst, size_t n) {
    size_t got = 0;
    int64_t start = get_time_us(), last_status = 0;
    while (got < n) {
        struct pollfd p = { .fd = s->fd, .events = POLLIN };
        int pr = poll(&p, 1, 40);
        if (pr > 0) {
            ssize_t k = recv(s->fd, dst + got, n - got, 0);
            if (k == 0) return AVERROR(EIO);                 /* the app closed the socket */
            if (k < 0) {
                if (errno == EINTR || errno == EAGAIN) continue;
                return AVERROR(EIO);
            }
            got += (size_t)k;
            continue;
        }
        if (pr < 0 && errno != EINTR) return AVERROR(EIO);
        int64_t now = get_time_us();
        if (!s->stalled && now - start > SOCK_STALL_US) {
            s->stalled = 1;
            fprintf(stderr, "[vidplay] Waiting for data at %lld bytes\n", (long long)s->pos);
        }
        if (s->stalled && now - last_status >= GROW_STATUS_US) {
            send_status(g_status_fd, g_last_pts_sec, g_total_sec, false, true);
            last_status = now;
        }
        process_ctrl_fifo(g_ctrl_fd, NULL, -1);
        if (!g_running) return AVERROR_EXIT;
        if (now - start > GROW_TIMEOUT_US) {
            fprintf(stderr, "[vidplay] No data for %d s, giving up\n", GROW_TIMEOUT_US / 1000000);
            return AVERROR(ETIMEDOUT);
        }
    }
    return 0;
}

static int sock_read(void *opaque, uint8_t *buf, int buf_size) {
    struct sock_src *s = (struct sock_src *)opaque;
    if (s->size > 0 && s->pos >= s->size) return AVERROR_EOF;
    char req[64];
    int rl = snprintf(req, sizeof(req), "R %lld %d\n", (long long)s->pos, buf_size);
    if (write_all(s->fd, req, (size_t)rl) < 0) return AVERROR(EIO);
    uint8_t hdr[4];
    int r = sock_recv(s, hdr, 4);
    if (r) return r;
    uint32_t len = (uint32_t)hdr[0] | ((uint32_t)hdr[1] << 8) | ((uint32_t)hdr[2] << 16) | ((uint32_t)hdr[3] << 24);
    if (len == 0) return AVERROR_EOF;
    if (len == 0xFFFFFFFFu || len > (uint32_t)buf_size) {
        fprintf(stderr, "[vidplay] Error: range source failed at %lld bytes\n", (long long)s->pos);
        return AVERROR(EIO);
    }
    r = sock_recv(s, buf, len);
    if (r) return r;
    s->pos += len;
    if (s->stalled) {
        s->stalled = 0;
        g_resync = 1;
        fprintf(stderr, "[vidplay] Buffer refilled, resuming\n");
    }
    return (int)len;
}

static int64_t sock_seek(void *opaque, int64_t offset, int whence) {
    struct sock_src *s = (struct sock_src *)opaque;
    if (whence & AVSEEK_SIZE) return s->size > 0 ? s->size : -1;
    whence &= ~AVSEEK_FORCE;
    int64_t np;
    switch (whence) {
        case SEEK_SET: np = offset; break;
        case SEEK_CUR: np = s->pos + offset; break;
        case SEEK_END: if (s->size <= 0) return AVERROR(ENOSYS); np = s->size + offset; break;
        default: return AVERROR(EINVAL);
    }
    if (np < 0) return AVERROR(EINVAL);
    s->pos = np;     /* no I/O: the next read asks the app for these bytes */
    return np;
}

int main(int argc, char *argv[]) {
    const char *input_url = NULL;
    const char *shm_path = "/dev/shm/mgu-video-cinema";
    const char *ctrl_path = NULL;
    const char *status_path = NULL;
    int target_w = 1280;
    int target_h = 720;
    int target_fps = 30;
    int loop_playback = 0;
    const char *grow_done = NULL;
    const char *sock_path = NULL;
    int64_t grow_size = 0;
    int nice_level = 0;

    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--shm") == 0 && i + 1 < argc) {
            shm_path = argv[++i];
        } else if (strcmp(argv[i], "--width") == 0 && i + 1 < argc) {
            target_w = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--height") == 0 && i + 1 < argc) {
            target_h = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--fps") == 0 && i + 1 < argc) {
            target_fps = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--ctrl") == 0 && i + 1 < argc) {
            ctrl_path = argv[++i];
        } else if (strcmp(argv[i], "--status") == 0 && i + 1 < argc) {
            status_path = argv[++i];
        } else if (strcmp(argv[i], "--loop") == 0) {
            loop_playback = 1;
        } else if (strcmp(argv[i], "--grow") == 0 && i + 1 < argc) {
            grow_done = argv[++i];
        } else if (strcmp(argv[i], "--sock") == 0 && i + 1 < argc) {
            sock_path = argv[++i];
        } else if (strcmp(argv[i], "--nice") == 0 && i + 1 < argc) {
            nice_level = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--size") == 0 && i + 1 < argc) {
            grow_size = strtoll(argv[++i], NULL, 10);
        } else if (strcmp(argv[i], "--caps") == 0) {
            printf("grow\nsock\nnice\n");   /* features the player checks before using them */
            return 0;
        } else if (argv[i][0] != '-') {
            input_url = argv[i];
        }
    }

    if (!input_url && sock_path) input_url = "stream.mp4";
    if (!input_url) {
        fprintf(stderr, "Usage: %s [OPTIONS] <input_url_or_file>\n", argv[0]);
        fprintf(stderr, "Options:\n");
        fprintf(stderr, "  --shm <path>       Shared memory path (default: /dev/shm/mgu-video-cinema)\n");
        fprintf(stderr, "  --width <w>        Width (default: 1280, max: 1280)\n");
        fprintf(stderr, "  --height <h>       Height (default: 720, max: 720)\n");
        fprintf(stderr, "  --fps <fps>        Target FPS (default: 30)\n");
        fprintf(stderr, "  --ctrl <fifo>      Path to control FIFO\n");
        fprintf(stderr, "  --status <fifo>    Path to status FIFO\n");
        fprintf(stderr, "  --loop             Loop local playback\n");
        fprintf(stderr, "  --grow <marker>    Input file is still being written; EOF once <marker> exists\n");
        fprintf(stderr, "  --sock <path>      Read the input as byte ranges from the app over a Unix socket\n");
        fprintf(stderr, "  --size <bytes>     Final size of a --grow / --sock input, if known\n");
        fprintf(stderr, "  --nice <n>         Lower CPU priority (0..19)\n");
        fprintf(stderr, "  --caps             Print supported features and exit\n");
        return 1;
    }

    if (strcmp(input_url, "-") == 0) {
        input_url = "pipe:0";
    }

    // Clamp dimensions to even numbers, max 1280x720 (720p cap)
    target_w = (target_w > 1280 ? 1280 : target_w) & ~1;
    target_h = (target_h > 720 ? 720 : target_h) & ~1;
    if (target_w < 64) target_w = 64;
    if (target_h < 64) target_h = 64;

    signal(SIGINT, sig_handler);
    signal(SIGTERM, sig_handler);
    signal(SIGPIPE, SIG_IGN);

    // Never outlive the app: the kernel sends SIGTERM when the parent (Node) dies, even by SIGKILL
    pid_t parent = getppid();
    prctl(PR_SET_PDEATHSIG, SIGTERM);
    if (getppid() != parent) {              // the parent died before prctl took effect
        fprintf(stderr, "[vidplay] Parent already gone, exiting\n");
        return 0;
    }

    // Lower priority before any decoder thread exists (Linux nice is per thread, inherited)
    if (nice_level > 0) {
        if (nice_level > 19) nice_level = 19;
        if (setpriority(PRIO_PROCESS, 0, nice_level) != 0) perror("[vidplay] setpriority");
    }

    // Setup FIFOs first: opening a --grow input can wait for data and must still see 'quit'
    int ctrl_fd = -1;
    if (ctrl_path) {
        mkfifo(ctrl_path, 0666);
        ctrl_fd = open(ctrl_path, O_RDONLY | O_NONBLOCK);
    }
    int status_fd = -1;
    if (status_path) {
        mkfifo(status_path, 0666);
        status_fd = open(status_path, O_WRONLY | O_NONBLOCK);
    }
    g_ctrl_fd = ctrl_fd;
    g_status_fd = status_fd;

    // Initialize Network & FFmpeg
    avformat_network_init();

    AVDictionary *opts = NULL;
    av_dict_set(&opts, "rtsp_transport", "tcp", 0);
    av_dict_set(&opts, "max_delay", "500000", 0);
    av_dict_set(&opts, "reconnect", "1", 0);
    av_dict_set(&opts, "reconnect_streamed", "1", 0);
    av_dict_set(&opts, "reconnect_delay_max", "5", 0);
    av_dict_set(&opts, "timeout", "8000000", 0); // 8s socket timeout

    AVFormatContext *fmt_ctx = NULL;
    AVIOContext *grow_io = NULL;
    struct grow_src grow = { .fd = -1 };
    struct sock_src ssrc = { .fd = -1 };
    fprintf(stderr, "[vidplay] Opening stream: %s%s\n", sock_path ? sock_path : input_url,
            sock_path ? " (range socket)" : grow_done ? " (growing file)" : "");
    if (sock_path) {
        struct sockaddr_un sa;
        memset(&sa, 0, sizeof(sa));
        sa.sun_family = AF_UNIX;
        if (strlen(sock_path) >= sizeof(sa.sun_path)) { fprintf(stderr, "[vidplay] Error: socket path too long\n"); return 1; }
        strcpy(sa.sun_path, sock_path);
        ssrc.fd = socket(AF_UNIX, SOCK_STREAM, 0);
        if (ssrc.fd < 0 || connect(ssrc.fd, (struct sockaddr *)&sa, sizeof(sa)) < 0) {
            fprintf(stderr, "[vidplay] Error: Cannot connect to '%s': %s\n", sock_path, strerror(errno));
            av_dict_free(&opts);
            return 1;
        }
        ssrc.size = grow_size;
        unsigned char *iobuf = av_malloc(131072);
        grow_io = iobuf ? avio_alloc_context(iobuf, 131072, 0, &ssrc, sock_read, NULL, sock_seek) : NULL;
        fmt_ctx = avformat_alloc_context();
        if (!grow_io || !fmt_ctx) {
            fprintf(stderr, "[vidplay] Error: out of memory\n");
            return 1;
        }
        fmt_ctx->pb = grow_io;
        fmt_ctx->flags |= AVFMT_FLAG_CUSTOM_IO;
        fmt_ctx->probesize = 1 << 20;            /* start after ~1 MB, not the 5 MB default */
    } else if (grow_done) {
        grow.fd = open(input_url, O_RDONLY);
        if (grow.fd < 0) {
            fprintf(stderr, "[vidplay] Error: Cannot open input '%s': %s\n", input_url, strerror(errno));
            av_dict_free(&opts);
            return 1;
        }
        grow.size_hint = grow_size;
        grow.done_path = grow_done;
        grow.last_len = grow_len(&grow);
        grow.last_growth_us = get_time_us();
        unsigned char *iobuf = av_malloc(65536);
        grow_io = iobuf ? avio_alloc_context(iobuf, 65536, 0, &grow, grow_read, NULL, grow_seek) : NULL;
        fmt_ctx = avformat_alloc_context();
        if (!grow_io || !fmt_ctx) {
            fprintf(stderr, "[vidplay] Error: out of memory\n");
            return 1;
        }
        fmt_ctx->pb = grow_io;
        fmt_ctx->flags |= AVFMT_FLAG_CUSTOM_IO;
    }
    if (avformat_open_input(&fmt_ctx, input_url, NULL, &opts) < 0) {
        fprintf(stderr, "[vidplay] Error: Cannot open input '%s'\n", input_url);
        av_dict_free(&opts);
        return 1;
    }
    av_dict_free(&opts);

    if (avformat_find_stream_info(fmt_ctx, NULL) < 0) {
        fprintf(stderr, "[vidplay] Error: Cannot find stream information\n");
        avformat_close_input(&fmt_ctx);
        return 1;
    }

    int video_stream_idx = -1;
    for (unsigned int i = 0; i < fmt_ctx->nb_streams; i++) {
        if (fmt_ctx->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_VIDEO) {
            video_stream_idx = (int)i;
            break;
        }
    }

    if (video_stream_idx < 0) {
        fprintf(stderr, "[vidplay] Error: No video stream found\n");
        avformat_close_input(&fmt_ctx);
        return 1;
    }

    AVStream *video_stream = fmt_ctx->streams[video_stream_idx];
    AVCodecParameters *codecpar = video_stream->codecpar;
    AVCodec *codec = avcodec_find_decoder(codecpar->codec_id);
    if (!codec) {
        fprintf(stderr, "[vidplay] Error: Unsupported codec %d\n", codecpar->codec_id);
        avformat_close_input(&fmt_ctx);
        return 1;
    }

    AVCodecContext *codec_ctx = avcodec_alloc_context3(codec);
    if (!codec_ctx || avcodec_parameters_to_context(codec_ctx, codecpar) < 0) {
        fprintf(stderr, "[vidplay] Error: Failed to setup codec context\n");
        if (codec_ctx) avcodec_free_context(&codec_ctx);
        avformat_close_input(&fmt_ctx);
        return 1;
    }

    // Utilize multi-threaded decoding if available on Atom
    codec_ctx->thread_count = 2;
    codec_ctx->thread_type = FF_THREAD_FRAME;

    if (avcodec_open2(codec_ctx, codec, NULL) < 0) {
        fprintf(stderr, "[vidplay] Error: Cannot open codec\n");
        avcodec_free_context(&codec_ctx);
        avformat_close_input(&fmt_ctx);
        return 1;
    }

    double total_duration_sec = (fmt_ctx->duration > 0) ? ((double)fmt_ctx->duration / AV_TIME_BASE) : 0;
    g_total_sec = total_duration_sec;
    fprintf(stderr, "[vidplay] Stream detected: %dx%d @ %.1f fps (Duration: %.1f sec)\n",
            codecpar->width, codecpar->height, av_q2d(video_stream->r_frame_rate), total_duration_sec);

    // Setup Shared Memory File for Protocol 4
    int nslot = 3; // Triple buffering
    size_t ysz = (size_t)target_w * target_h;
    size_t csz = (size_t)(target_w / 2) * (target_h / 2);
    size_t fsz = ysz + 2 * csz; // 1.5 * w * h bytes per I420 frame
    size_t total_shm_size = sizeof(struct mgu_video_head) + (size_t)nslot * fsz;

    // Reuse an existing frame file in place: the renderer keeps the file it opened (by inode), so a
    // file replaced under it would never show a frame. Only a file we may not write is replaced.
    int shm_fd = open(shm_path, O_RDWR | O_CREAT, 0666);
    if (shm_fd < 0) {
        unlink(shm_path);
        shm_fd = open(shm_path, O_RDWR | O_CREAT | O_TRUNC, 0666);
    }
    if (shm_fd < 0) {
        perror("[vidplay] open shm_path");
        avcodec_free_context(&codec_ctx);
        avformat_close_input(&fmt_ctx);
        return 1;
    }
    fchmod(shm_fd, 0666); // Ensure world-readable by BMW HMI and OAP sandboxes

    if (ftruncate(shm_fd, (off_t)total_shm_size) < 0) {
        perror("[vidplay] ftruncate shm_fd");
        close(shm_fd);
        avcodec_free_context(&codec_ctx);
        avformat_close_input(&fmt_ctx);
        return 1;
    }

    uint8_t *shm_map = mmap(NULL, total_shm_size, PROT_READ | PROT_WRITE, MAP_SHARED, shm_fd, 0);
    if (shm_map == MAP_FAILED) {
        perror("[vidplay] mmap shm");
        close(shm_fd);
        avcodec_free_context(&codec_ctx);
        avformat_close_input(&fmt_ctx);
        return 1;
    }

    struct mgu_video_head *head = (struct mgu_video_head *)shm_map;
    memset(head, 0, sizeof(*head));
    head->magic = MGU_VIDEO_MAGIC;
    head->version = 1;
    head->w = (uint32_t)target_w;
    head->h = (uint32_t)target_h;
    head->seq = 0;
    head->slot = 0;
    head->nslot = (uint32_t)nslot;
    head->matrix = 1; // 1 = BT.709
    head->full = 0;   // 0 = limited range

    // Setup software scaler for scaling / pixel format conversion
    struct SwsContext *sws_ctx = sws_getContext(
        codec_ctx->width, codec_ctx->height, codec_ctx->pix_fmt,
        target_w, target_h, AV_PIX_FMT_YUV420P,
        SWS_FAST_BILINEAR, NULL, NULL, NULL
    );

    AVFrame *frame = av_frame_alloc();
    AVFrame *i420_frame = av_frame_alloc();
    AVPacket *packet = av_packet_alloc();

    // Allocate temp buffer for scaled I420 frame
    uint8_t *i420_buf = malloc(fsz);
    av_image_fill_arrays(i420_frame->data, i420_frame->linesize, i420_buf,
                         AV_PIX_FMT_YUV420P, target_w, target_h, 1);

    fprintf(stderr, "[vidplay] Video Engine Ready: %dx%d into %s\n", target_w, target_h, shm_path);

    uint32_t written_seq = 0;
    uint32_t current_slot = 0;
    int64_t start_time_us = get_time_us();
    int64_t stream_start_pts = AV_NOPTS_VALUE;
    int64_t frame_interval_us = 1000000LL / target_fps;
    int64_t last_status_us = 0;

    while (g_running) {
        // Process control commands (seek, pause, resume)
        process_ctrl_fifo(ctrl_fd, fmt_ctx, video_stream_idx);

        if (g_seek_target_sec >= 0) {
            avformat_seek_file(fmt_ctx, -1, INT64_MIN, g_seek_target_sec, INT64_MAX, 0);
            avcodec_flush_buffers(codec_ctx);
            stream_start_pts = AV_NOPTS_VALUE;
            start_time_us = get_time_us();
            g_seek_target_sec = -1;
        }

        if (g_paused) {
            usleep(20000); // 20ms pause poll
            start_time_us = get_time_us(); // Keep clock fresh
            continue;
        }

        int ret = av_read_frame(fmt_ctx, packet);
        if (g_resync) {               // waited for data: restart the clock at the next frame
            g_resync = 0;
            stream_start_pts = AV_NOPTS_VALUE;
        }
        if (ret < 0) {
            if (ret == AVERROR_EXIT || !g_running) break;
            if (ret == AVERROR(ETIMEDOUT)) {
                fprintf(stderr, "[vidplay] Error: input stalled\n");
                break;
            }
            if (ret == AVERROR_EOF) {
                if (loop_playback) {
                    fprintf(stderr, "[vidplay] EOF reached, looping...\n");
                    av_seek_frame(fmt_ctx, video_stream_idx, 0, AVSEEK_FLAG_BACKWARD);
                    avcodec_flush_buffers(codec_ctx);
                    stream_start_pts = AV_NOPTS_VALUE;
                    start_time_us = get_time_us();
                    continue;
                } else {
                    fprintf(stderr, "[vidplay] Stream EOF\n");
                    break;
                }
            }
            usleep(5000);
            continue;
        }

        if (packet->stream_index == video_stream_idx) {
            if (avcodec_send_packet(codec_ctx, packet) == 0) {
                while (avcodec_receive_frame(codec_ctx, frame) == 0) {
                    if (stream_start_pts == AV_NOPTS_VALUE && frame->pts != AV_NOPTS_VALUE) {
                        stream_start_pts = frame->pts;
                        start_time_us = get_time_us();
                    }

                    // Scale & convert frame to target I420
                    sws_scale(sws_ctx, (const uint8_t * const *)frame->data, frame->linesize,
                              0, codec_ctx->height,
                              i420_frame->data, i420_frame->linesize);

                    // Pacing: calculate target presentation timestamp
                    if (frame->pts != AV_NOPTS_VALUE && stream_start_pts != AV_NOPTS_VALUE) {
                        int64_t pts_diff = frame->pts - stream_start_pts;
                        int64_t pts_us = (int64_t)(pts_diff * av_q2d(video_stream->time_base) * 1000000.0);
                        int64_t elapsed_us = get_time_us() - start_time_us;
                        int64_t sleep_us = pts_us - elapsed_us;

                        if (sleep_us > 1000 && sleep_us < 500000) {
                            usleep((useconds_t)sleep_us);
                        }
                    } else {
                        usleep((useconds_t)frame_interval_us);
                    }

                    // Rotate to next slot in triple-buffer
                    uint32_t next_slot = (current_slot + 1) % (uint32_t)nslot;
                    uint8_t *slot_dst = shm_map + sizeof(struct mgu_video_head) + (size_t)next_slot * fsz;

                    // Copy I420 planes (contiguous Y, then U, then V)
                    uint8_t *d = slot_dst;
                    // Y plane
                    for (int y = 0; y < target_h; y++) {
                        memcpy(d + y * target_w, i420_frame->data[0] + y * i420_frame->linesize[0], target_w);
                    }
                    d += ysz;
                    // U plane
                    int half_w = target_w / 2;
                    int half_h = target_h / 2;
                    for (int y = 0; y < half_h; y++) {
                        memcpy(d + y * half_w, i420_frame->data[1] + y * i420_frame->linesize[1], half_w);
                    }
                    d += csz;
                    // V plane
                    for (int y = 0; y < half_h; y++) {
                        memcpy(d + y * half_w, i420_frame->data[2] + y * i420_frame->linesize[2], half_w);
                    }

                    // Update shm head atomically (protocol: slot first, memory barrier, seq next)
                    head->slot = next_slot;
                    __sync_synchronize();
                    head->seq = ++written_seq;
                    current_slot = next_slot;

                    // Send periodic status updates to UI (every 250ms)
                    int64_t now_us = get_time_us();
                    if (now_us - last_status_us > 250000LL) {
                        double cur_sec = 0;
                        if (frame->pts != AV_NOPTS_VALUE) {
                            cur_sec = (double)frame->pts * av_q2d(video_stream->time_base);
                        }
                        g_last_pts_sec = cur_sec;
                        send_status(status_fd, cur_sec, total_duration_sec, true, false);
                        last_status_us = now_us;
                    }
                }
            }
        }
        av_packet_unref(packet);
    }

    fprintf(stderr, "[vidplay] Shutting down, total frames rendered: %u\n", written_seq);
    send_status(status_fd, total_duration_sec, total_duration_sec, false, false);

    if (ctrl_fd >= 0) close(ctrl_fd);
    if (status_fd >= 0) close(status_fd);

    free(i420_buf);
    av_frame_free(&frame);
    av_frame_free(&i420_frame);
    av_packet_free(&packet);
    sws_freeContext(sws_ctx);
    avcodec_free_context(&codec_ctx);
    avformat_close_input(&fmt_ctx);
    if (grow_io) {
        av_freep(&grow_io->buffer);
        avio_context_free(&grow_io);
    }
    if (grow.fd >= 0) close(grow.fd);
    if (ssrc.fd >= 0) close(ssrc.fd);
    avformat_network_deinit();

    munmap(shm_map, total_shm_size);
    // the frame file stays: the app drops it from the renderer first, then removes it
    close(shm_fd);

    return 0;
}
