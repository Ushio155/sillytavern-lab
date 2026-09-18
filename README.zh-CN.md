# sillytavern-lab

跑一个**隔离的第二份 SillyTavern**，用来开发和测试插件，而不碰你真正的聊天记录、角色卡、世界书和设置。

- 你正式的 SillyTavern 照常跑在原端口、用原数据，完全不受影响。
- 实验区跑在另一个端口、另一份数据根目录（data root）。测试卡、测试世界书、破坏性实验，全部落在那边。
- 实验区加载的是你**只给实验区**挂载的那份插件副本，并且会**遮蔽**同名已安装版本。半成品弄不坏你真正在聊的那份。
- 一把全局锁串行化测试脚本，两个脚本永远不会悄悄互相破坏对方的夹具。

零依赖，不改动你的 SillyTavern 检出。

```
实验区 ── 端口 8011 ── .runtime/data/     ── 仅实验区可见的插件/
正式   ── 端口 8000 ── <你的真实数据>/    ── 全局安装的插件/
        （同一个安装目录、同一份 public/ 代码，其它全部分开）
```

---

## 为什么需要它

SillyTavern 本身很给面子：`--port`、`--dataRoot`、`--configPath` 已经能让你起第二个实例。**如果你只需要这个，那直接敲命令就好，不需要本项目。**

问题出在你同时开发好几个插件、每个插件都带测试脚本之后：

| 会出什么事 | 实验区怎么解决 |
|---|---|
| 测试建出来的角色卡、世界书、聊天堆在你真实数据里，过几天你已经分不清哪些是夹具 | 全部落在实验区的数据根目录；`clean` 按**你自己声明**的文件名模式回收 |
| 不敢测"删光所有角色卡"这类破坏性操作 | 实验区数据根目录是一次性的，删掉下次启动重建 |
| 半成品插件必须装进正式客户端才能测，于是开发期间你自己没法用 | `link` 只挂给实验区；同名时实验区副本遮蔽全局版本 |
| 两个测试脚本同时跑，互相覆盖 `settings.json`、互相删对方的夹具，症状是"输的那个脚本偶发断言失败" | 一把全局锁；被强杀留下的死锁会**自动接管** |
| 每个脚本各自硬编码 URL、端口、路径 | `lab-env.mjs` 是唯一事实来源，所有脚本都 import 它 |
| 插件在两处各一份，悄悄落后几个 commit，而两边 `manifest.json` 版本号还一样 | `link` 是符号链接：代码永远只有一份 |

最后一条不是假设。这个工具就是因为这件事才写出来的：某次正式 SillyTavern 跑的是一个**四天前**的插件 clone，而它的版本号和当前源码一模一样，**光看版本号发现不了**。

---

## 环境要求

- Node.js 20 或更新
- 一个已经能跑的 SillyTavern 检出（`npm install` 已完成）

## 快速开始

```bash
git clone https://github.com/Ushio155/sillytavern-lab.git
cd sillytavern-lab

# 指向你的安装目录（或让它自动探测常见位置）
cp lab.config.example.json lab.config.json
#   ……然后改 "stInstall"
```

```bash
node lab.mjs start          # 启动，并等到它能响应为止
```

打开 <http://127.0.0.1:8011/> —— 这就是实验区。你正式的 SillyTavern 还在 8000，什么都没动。

```bash
node lab.mjs link SillyTavern-MyExtension /path/to/MyExtension-Plugin/SillyTavern-MyExtension
node lab.mjs restart
```

现在实验区加载的是你的工作副本。刷新实验区页面就能看到；正式 SillyTavern 永远看不见它。

```bash
node lab.mjs status     # 在跑吗？退出码 0 = 在跑，1 = 没跑
node lab.mjs info       # 实验区会加载哪些插件、数据在哪
node lab.mjs stop
```

## 三层隔离

| 层 | 路径 | 与正式实例共享？ |
|---|---|---|
| 安装目录 | `<stInstall>/public/` | **共享** —— 同一份文件、同一个版本。不用再下一份，也不会漂移。 |
| 数据根目录 | `.runtime/data/` | **隔离** —— 聊天、角色卡、世界书、`settings.json`、`_webpack` 全在这里。 |
| 插件目录 | `.runtime/data/default-user/extensions/` | **隔离** —— 而且这里的同名插件会**遮蔽**全局已安装版本。 |

实验区写的一切都在 `.runtime/` 下面。删掉这个目录，实验区就是全新的；你机器上其它东西一个都没动。

实验区的 `config.yaml` 在**首次启动时从你自己的 SillyTavern 配置复制**，而不是手写一份模板——手写模板会在上游新增配置项的那天开始腐烂。复制之后它就再也不会被覆盖，你的修改会保留。

---

## 配置

把 `lab.config.example.json` 复制成 `lab.config.json`。它是 JSONC，允许注释和尾随逗号。

| 键 | 默认值 | 含义 |
|---|---|---|
| `stInstall` | 自动探测 | 你的 SillyTavern 检出（含 `server.js` 的那层目录） |
| `dataRoot` | `.runtime/data` | 实验区私有数据根目录；相对路径按本目录解析 |
| `configPath` | `.runtime/config.yaml` | 交给实验区的 `config.yaml` |
| `configBase` | 你的 `config.yaml` | 首次启动时复制实验区配置的模板 |
| `listen` | `false` | 是否接受本机以外的连接 |
| `browserLaunch` | `false` | 启动时是否自动开浏览器窗口 |
| `overrides` | 见示例 | 以点号键名追加的 `config.yaml` 设置 |
| `ports.st` / `.mock` / `.cdp` | `8011` / `8123` / `9333` | 实验区 / mock API / 浏览器调试端口 |
| `residue` | `{}` | `clean` 允许删什么，见下 |
| `runtimeDir` | `.runtime` | 运行时状态目录（日志、pid、锁、生成配置、数据根） |

`overrides` 是通过 SillyTavern 官方文档化的 `SILLYTAVERN_*` 环境变量传进实验区进程的，**不会改写任何 YAML**。默认关掉磁盘角色卡缓存——那玩意的陈旧条目 SillyTavern 从不回收。

环境变量优先于配置文件：`LAB_ST_INSTALL`、`LAB_DATA_ROOT`、`LAB_CONFIG_PATH`、`LAB_CONFIG_FILE`、`LAB_RUNTIME_DIR`、`LAB_ST_PORT`、`LAB_MOCK_PORT`、`LAB_CDP_PORT`、`LAB_ST_URL`。

`listen` 默认 `false` 是刻意的：一个隔离的测试实例悄悄变成全网可达，是很糟糕的惊喜。

---

## 回收测试残留

`clean` **只**删文件名匹配你写的模式、且不在保护名单里的**普通文件**。它绝不递归、绝不跟随符号链接、绝不判断"这看起来像垃圾"。

声明你的测试会造什么：

```jsonc
"residue": {
  "rules": [
    { "dir": "characters",        "pattern": "^MyExt-Test-.*\\.png$",  "reason": "每轮导入一张新测试卡" },
    { "dir": "thumbnails/avatar", "pattern": "^MyExt-Test-.*\\.png$",  "reason": "同一张卡生成的缩略图，在另一个目录" },
    { "dir": "worlds",            "pattern": "^MyExt-Test-.*\\.json$", "reason": "世界书夹具" }
  ],
  "protect": [
    { "path": "worlds/MyHandWrittenBook.json", "note": "手写的，不是夹具" }
  ]
}
```

```bash
node lab.mjs clean            # dry-run：只列清单，一个文件都不动
node lab.mjs clean --yes      # 真删
```

两个旗标同时给出时 `--dry-run` 赢：一个叫 dry-run 却还能删文件的旗标，比没有这个旗标更糟。SillyTavern 自带的示例角色卡和世界书默认受保护，你的 `settings.json` 也是。

另外内置一项清理：`_cache/characters` 里目标角色卡已不存在的陈旧缓存条目。

---

## 在测试脚本里使用实验区

`lab-env.mjs` 是共享契约。不要硬编码任何东西，import 它：

```js
import { ST_URL, MOCK_PORT, assertLabUp, withHarnessLock, cdpPort } from '../lab/lab-env.mjs';

await assertLabUp();                    // 实验区没起来就抛出带修复提示的错误

await withHarnessLock('myext-driver', async () => {
    // 同一时间只有一个脚本能持有它。被强杀留下的锁会被识别（pid 已死）并接管，
    // 所以 Ctrl-C 永远不会把实验区卡死。
    await fetch(`${ST_URL}api/characters/all`);
});

// 浏览器自动化：要一个槽位，而不是硬编码 9333 + n
const port = cdpPort(1);
```

这把锁是**全局的，不是按名字分的**：两个脚本绝不能共用一份数据根目录，所以 `withHarnessLock('a')` 和 `withHarnessLock('b')` 之间也互斥。

导出：`ST_URL`、`ST_PORT`、`MOCK_URL`、`MOCK_PORT`、`CDP_PORT`、`cdpPort(slot)`、`LAB_DIR`、`stInstall()`、`DATA_ROOT`、`CONFIG_PATH`、`USER_DIR`、`WORLDS_DIR`、`LAB_EXTENSIONS_DIR`、`globalExtensionsDir()`、`isLabUp`、`waitForLabUp`、`assertLabUp`、`withHarnessLock`、`acquireLock`、`releaseLock`、`readLock`、`isAlive`、`ensureLabConfig`、`RESIDUE`。

---

## 命令

| 命令 | 作用 |
|---|---|
| `node lab.mjs start` | 后台启动。已经在跑就什么都不做。等到能响应为止。 |
| `node lab.mjs run` | 前台运行，日志打在当前终端。CI、agent 沙箱、任务计划程序用这个。 |
| `node lab.mjs stop` | 停止。**不会**杀一个它没启动过的进程。 |
| `node lab.mjs restart` | 先停再起。 |
| `node lab.mjs status` | 在跑吗？退出码 0 = 在跑，1 = 没跑。 |
| `node lab.mjs info` | 实验区会加载哪些插件、数据在哪。 |
| `node lab.mjs link <名字> <目录>` | 只给实验区挂载插件。 |
| `node lab.mjs unlink <名字>` | 摘掉挂载。绝不动你的源码。 |
| `node lab.mjs clean [--dry-run] [--yes]` | 回收测试残留。默认 dry-run。 |

`link` / `unlink` 只碰它们自己建的符号链接。`unlink` 拒绝删除真实目录；含 `/`、`\` 或 `..` 的名字直接拒绝——否则 `unlink ..` 会欢快地把插件目录外面的东西删掉。

---

## 测试

```bash
npm test          # 19 项检查，不需要 SillyTavern
npm run verify    # 在 8012 端口真起一个实例，断言它确实是隔离的
```

`npm test` 拿一个一次性实验区端到端跑 CLI：JSONC 解析、dry-run / `--yes` 契约、保护名单、不递归、`link`/`unlink` 安全性、锁的死锁接管。

`npm run verify` 才是验证核心承诺的那个。它在一个一次性端口和数据根目录上启动 SillyTavern，断言 HTTP 200，然后**读服务端日志**确认进程真的用了那份数据根目录和配置，最后确认停止后端口被释放。它用的是独立的数据根目录，所以在你自己的实验区或正式 SillyTavern 开着的时候跑也安全。

## 哪些验证过、哪些没有

这里写清楚，因为一个悄悄没做隔离的隔离工具还不如没有。

**已验证：**

- `npm test`：19/19。
- `npm run verify`：Windows 上真实 SillyTavern 1.18.0 以隔离端口、隔离数据根、隔离配置启动；停止后端口释放。
- 遮蔽行为（实验区专属插件遮住同名全局插件）—— 在 1.18.0 上实测过。
- 用这种方式搭出的实验区跑真实插件测试套件：25 项与 119 项断言全绿，正式安装的数据一行未动。

**未验证：**

- Windows 和 Node 22 以外的环境。POSIX 的进程查找只是尽力而为，而且**只影响诊断信息**——实验区自己的存活判断是 HTTP 请求，与平台无关。
- `performance.useDiskCache` 这条覆盖。它是按 SillyTavern 官方文档的 `SILLYTAVERN_*` 环境变量机制传的，测试没覆盖这条机制；万一它被忽略，后果只是 `_cache` 目录会涨。
- 1.18.0 以外的 SillyTavern 版本。

## 已知限制

- 一份数据根目录同时只服务一个实验区进程。这就是设计意图，但意味着那把锁是认真的：不持锁的脚本照样能互相踩。
- `link` 建的是目录符号链接（Windows 上是 junction）。Windows 上指向网络路径或另一个盘的 junction 可能失败；源码请放在本地。
- 实验区与正式实例**共享 `public/`**，所以如果 SillyTavern 本体检出坏了，两个一起坏。隔离的是插件，不是服务端。
- 插件遮蔽是 SillyTavern 的行为，本项目只是依赖它、控制不了它。上游要是改了，`link` 就不再能把半成品对正式客户端藏起来。`node lab.mjs info` 里你的插件出现在 "Lab-only extensions" 下面，就是它仍然生效的证据。

## 许可证

MIT
