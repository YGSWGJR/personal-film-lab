# resources/mpv

运行期依赖的 libmpv 动态库与开发头文件。

| 文件 | 是否入库 | 说明 |
|---|---|---|
| `libmpv-2.dll` | 否（约 120MB，见仓库 `.gitignore`） | 官方 mpv dev 包，静态链接单文件，直接放到本目录 |
| `include/mpv/*.h` | 是 | client / render / render_gl / stream_cb 头文件，对照 API 用 |
| `libmpv.dll.a` | 否 | MinGW 导入库，本项目走 koffi 运行时加载，不需要它 |

注意：

- DLL 文件名是 **`libmpv-2.dll`**（官方命名）。S01 早期版本写的 `mpv-2.dll` 已更正。
- 无需额外拷贝其他运行时库（该 dev 包已静态链接依赖）。
- 打包时 electron-builder 按 `build.extraResources` 把本目录复制到安装包 `resources/mpv/`；
  主进程通过 `app.isPackaged` 区分开发路径与安装包路径（见 `src/main/player/mpv-lib.ts`）。