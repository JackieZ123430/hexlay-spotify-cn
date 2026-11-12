# Spotify Connect · BMW iDrive 7 简体中文

[English](README.md) · [简体中文](README.zh-CN.md)

hexlay 的 Spotify 应用可在宝马 iDrive 7 中控上浏览歌单和喜欢的歌曲、控制进度与播放队列，并切换 Spotify Connect 播放设备。Spotify 账户通过手机扫码配对，车机显示已配对账户和播放设备。实际可用功能取决于 Spotify 账户、播放设备和车机联网状态。

翻译者：抖音「小白科技杂物社」 · BiliBili「小白151」 · GitHub [JackieZ123430](https://github.com/JackieZ123430)。

## 原版安装与配对

1. 在 MGU Store 添加源码来源 `hexlay/idrive7-custom-apps`，选择 `main` 分支，再安装 Spotify。
2. 确认车机 Internet Uplink 可用，打开应用的「连接」页。
3. 在手机上扫描配对二维码并按 Spotify 页面完成登录。切换账户或断开连接也在手机上进行。
4. 选择歌单或「喜欢的歌曲」后，可在「正在播放」中控制音乐、查看队列，或在「连接」页选择播放设备。

## 简中设置

- **配色主题**可选择 Spotify 绿、M 三色、M 红、冰白和夜间琥珀。
- **播放模式**提供在线和离线演示。
- **屏幕尺寸、布局和渲染方式**按车机配置选择。
- **播放同步频率**控制播放状态刷新间隔。

中文歌名、艺人名、专辑名和歌单名按 Spotify 提供的文本显示。简中版使用 Noto Sans SC 和 GB2312 标题备用图集，生僻字、表情和其他特殊符号取决于字形覆盖。主界面右上角和设置页保留汉化署名。

## 构建简中版

准备自己车机的 `oap-sdk/`，在仓库根目录运行。Windows 下可使用 `python`。

```sh
python3 kit/tools/build.py --language zh-CN spotify
```

产物位于 `dist/`。简中版的应用 ID 仍为 `spotify`。BMW SDK 和含有该 SDK 的构建包请留在本地。此指南覆盖 Spotify，原仓库其他应用见 [上游说明](README.md)。

## 来源与许可

- [hexlay 原仓库](https://github.com/hexlay/idrive7-custom-apps)
- [简中 fork](https://github.com/JackieZ123430/hexlay-spotify-cn)
- [MGU Store](https://github.com/robertnisipeanu/mgu-store)
- [Noto Sans SC 字体许可](kit/runtime/fonts/OFL-NotoSansSC.txt)

这是社区项目，与 BMW AG 或 Spotify 无关联。项目许可见 [LICENSE](LICENSE) 和 [LICENSE.MIT](LICENSE.MIT)。
