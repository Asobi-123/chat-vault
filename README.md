# 聊天保险箱

[English](README_EN.md)

SillyTavern 的服务器侧聊天备份、未保存编辑找回、灾难恢复扩展。

它不把恢复希望寄托在当前聊天 `jsonl` 还活着。
也不把浏览器 `IndexedDB` 当主存储。

所有独立备份和未保存编辑都会写到：

- `data/<user>/user/files/chat-vault/`

## 什么时候需要它

- 酒馆一时崩了，最近楼层少了，想把刚才那个阶段捞回来
- 正在编辑一条消息，刷新或报错后没保存，想找回未保存编辑
- 原聊天文件坏了、打不开了，想从独立备份里恢复某个阶段

## 功能亮点

- **提交级自动备份**：监听 `MESSAGE_SENT`、`MESSAGE_RECEIVED`、`MESSAGE_DELETED`、`MESSAGE_SWIPED`
- **同轮自动备份合并**：一轮“发送 -> 收到”优先合并成同一条自动备份，不无限堆叠
- **重新生成也尽量归并**：同一轮 swipe / regenerate 不应无止境吃掉自动备份额度
- **未保存编辑镜像**：编辑框里的内容会按短延迟同步到服务器侧 `draft.json`
- **灾难恢复**：就算当前聊天打不开，也可以从全局列表找回聊天线
- **聊天改名不断档**：通过 scope rebind 保持聊天改名前后的备份归属
- **更快落盘**：事件后会短延迟补一次 `context.saveChat()`
- **可管理备份**：支持预览、恢复为新聊天、覆盖当前聊天、设为长期保留、重命名、删除
- **面板完整**：悬浮球、悬浮面板、移动端适配、主题切换、中文/英文 i18n

## 最快安装

```bash
git clone https://github.com/Asobi-123/chat-vault.git
cd chat-vault
node install.mjs
```

- 安装脚本会自动查找附近的 SillyTavern
- 如果找到多个目标，会在终端里让你选一个
- 脚本不会自动重启 SillyTavern，安装后请自己重启

## 安装脚本会做什么

- 自动定位 SillyTavern 根目录
- 优先复制前端扩展到 `data/<user>/extensions/chat-vault`
- 复制 server plugin 到 `plugins/chat-vault`
- 自动把 `config.yaml` 里的 `enableServerPlugins` 改成 `true`
- 清掉同名旧安装残留
- 不自动删除已有 `user/files/chat-vault` 备份数据

## 手动指定路径

如果你不想让安装脚本自动猜目标，可以直接传路径：

```bash
node install.mjs /path/to/SillyTavern
```

也可以用环境变量：

```bash
SILLYTAVERN_DIR=/path/to/SillyTavern node install.mjs
```

## 卸载

```bash
node uninstall.mjs
```

或：

```bash
node uninstall.mjs /path/to/SillyTavern
```

卸载脚本会删除前端扩展目录和 `plugins/chat-vault`。
它不会自动删除 `user/files/chat-vault` 里的备份数据。

## 使用方式

1. 打开扩展设置里的 `聊天保险箱` 抽屉，或直接点悬浮球
2. 在 **当前聊天** 里查看未保存编辑、自动备份和手动备份
3. 在 **灾难恢复** 里浏览全局聊天线，并把任意备份恢复为新聊天
4. 在 **设置** 里调整自动备份数量、落盘延迟、未保存编辑同步频率、命名模板和主题

## 数据位置

### 安装位置

- 前端扩展：`data/<user>/extensions/chat-vault`
- Server Plugin：`plugins/chat-vault`

### 运行数据位置

- 根目录：`data/<user>/user/files/chat-vault/`
- 全局聊天线索引：`scopes-index.json`
- 聊天别名绑定：`scope-aliases.json`
- 每条聊天线目录：`scopes/<label>__<scopeId>/`
- 备份索引：`index.json`
- 未保存编辑：`draft.json`
- 实际备份文件：`snapshots/*.jsonl`

## 常见问题

**Q：为什么不能直接用酒馆内置“安装扩展”？**

因为它不只是前端扩展。
它还需要安装 SillyTavern server plugin。

**Q：备份存在什么地方？**

存在 SillyTavern 用户目录下的：

- `data/<user>/user/files/chat-vault/`

**Q：卸载会不会删掉我的备份？**

不会。
卸载脚本默认只删扩展目录和插件目录，不删已有备份数据。

**Q：更新怎么做？**

```bash
cd /path/to/chat-vault
git pull
node install.mjs
```

**Q：为什么改聊天文件名最好走酒馆自己的重命名？**

因为聊天保险箱会拦截酒馆自己的重命名流程，把旧聊天名和新聊天名继续绑定到同一条聊天线。
如果你直接在文件系统里手改名字，不会触发这个绑定。

**Q：灾难恢复和普通聊天备份有什么区别？**

当前聊天页显示的是当前聊天线下的备份。
灾难恢复页显示的是独立于当前聊天打开状态的全局聊天线列表，适合原聊天文件损坏、打不开或记不清原聊天名时使用。

## 相关文档

- **更新日志** — [CHANGELOG.md](CHANGELOG.md)
- **架构说明** — [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- **数据模型** — [docs/DATA_MODEL.md](docs/DATA_MODEL.md)
- **手动测试清单** — [docs/MANUAL_TESTING.md](docs/MANUAL_TESTING.md)
- **常见问题排查** — [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)

## 许可证

[AGPL-3.0](LICENSE)
