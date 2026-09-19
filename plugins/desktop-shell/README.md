# plugins/desktop-shell

便利入口指针：真正的插件实现在 [packages/desktop-shell](../../packages/desktop-shell)
（Cordis 插件 `dsh-desktop-shell` + `cordis.patch.yml`）。

Windows 下不使用符号链接（需要管理员/开发者模式）；把插件装入 DSH profile：

```bash
dsh plugin --profile dsh-desktop-electron add <repo>/packages/desktop-shell
```

或直接通过 `--patch` overlay 注入（本项目平台壳采用的方式，见 PLAN.md §3）：

```bash
dsh --profile dsh-desktop-electron --patch <repo>/packages/desktop-shell/cordis.patch.yml --port 0 --no-open
```
