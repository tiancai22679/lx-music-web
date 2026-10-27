# 音源脚本目录（LX Music 源）

本目录用于放置洛雪音乐（LX Music）格式的「音源脚本」。服务端启动时会自动加载本目录下所有 `.js` 文件作为音源（`server.js` 中的 `bootAllLxSources`）。

- 仓库默认**不包含任何第三方音源脚本**，仅保留项目自有代码；内置的网易云音源位于 `server.js` / `parsers.js`，无需此目录即可使用。
- 如需酷我 / 酷狗 / QQ 音乐 / 咪咕等音源，可将洛雪官方或社区音源脚本（例如 `lx-music-source.js`）放入本目录后重启服务即可生效。
- 也可通过环境变量 `SOURCE_DIR` 指定额外的用户音源目录（默认 `data/sources`，已被 `.gitignore` 忽略，不会进仓库）。

音源脚本须遵循洛雪 1.9.1 协议：读取 `globalThis.lx`，注册 `musicUrl` 等动作。可参考 `lxsource.js` 中的运行时实现。
