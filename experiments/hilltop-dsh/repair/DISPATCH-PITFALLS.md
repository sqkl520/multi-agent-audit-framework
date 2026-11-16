# dsh 派发的两个环境陷阱

**记录时间**：2026-11-15 01:50
**触发**：第一次派发 `task-repair.md` 后，dsh 跑了 33 步、14 个作业，却**一个文件都改不了**。

---

## 陷阱一：沙箱根目录是 `process.cwd()`，不是任务里写的路径

dsh 的 `sandbox-policy` 插件配置是：

```yaml
- id: sandbox-policy
  name: '@deepseek-ai/dsh-sandbox-policy'
  config:
    mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'
    workspaceRoot: !!js process.cwd()
```

而 `workspace-write` 模式下，`dsh-fs-sandbox` 的 `checkedTarget()` 会做：

```js
const fresh = await this.resolve(target.displayPath);
let contained = false;
for (const root of writableRoots(policy)) if (await isPathUnder(fresh.targetKey, root)) {
    contained = true;
    break;
}
if (!contained) throw new FsError(`cannot write "…": file access denied under workspace-write mode`, "FS_SANDBOX_DENIED");
```

**任务书里写「修改 D:/Server/.../Hilltop Village Plugin」没有用。**
我从框架仓库 `<WORKSPACE>/.../multi-agent-audit-framework` 启动的 dsh，
它的可写根就是框架仓库，目标项目在另一个盘根，写入必然被拒。

### 症状

不是立刻报错，而是**跑很久才卡住**：dsh 先花 30 多步读代码、找构建入口，
到真正要写文件时才会撞墙。如果不看日志，会误以为它在正常工作。

### 修法

**从目标项目目录启动 dsh**，而不是从框架仓库：

```bash
cd "<TARGET_REPO>"
AUDIT_API_KEY='...' node ".../dsh/lib/bin.js" --profile headless --patch ".../patch-audit.yml" "$(cat ".../task-repair.md")"
```

任务书文件可以在任意位置（读不受限），但**工作目录必须在目标项目内**。

### 验证方法

看新 session 的 `session` 事件里的 `cwd` 字段：

```bash
node -e "
const fs=require('fs'),z=require('zlib');
const out=z.zstdDecompressSync(fs.readFileSync(process.argv[1])).toString();
const first=out.split('\n').filter(Boolean).map(l=>JSON.parse(l)).find(o=>o.type==='session');
console.log(first.data.cwd);
" ~/.dsh/sessions/<dir>/session-<id>/session.v4.jsonl.zstd
```

必须等于目标项目根。**不要靠「任务书里写了路径」来推断，要读 `cwd` 实际值。**

---

## 陷阱二：Windows 上 Git Bash 在 dsh 里起不来

第一次派发时，dsh 执行 `bash -lc "./build.sh -o test"` 得到：

```
bash : 0 [main] bash (134456) D:\Git\usr\bin\bash.exe: *** fatal error
- NtCreateDirectoryObject(\BaseNamedObjects\msys-2.0S5-9d45cb7009983b2a): 0xC0000022
[status: completed, exit code: 1]
```

MSYS 需要创建命名内核对象，受限进程里被拒（`0xC0000022` = `STATUS_ACCESS_DENIED`）。

**后果**：任务书里写的构建命令 `./build.sh -o test` 在这条执行路径上**永远跑不了**。
dsh 自己花了几步去找替代方案（查 `build.cmd`、查 JDK 位置），这是它该做的，
但我不该把这条走不通的路写进任务书。

### 修法

这个项目**已经有原生 Windows 包装脚本** `build.cmd`，是同一套四探针逻辑：

```
[build.cmd] Maven exit code=0
[INFO] BUILD SUCCESS
```

任务书改成：

```
cmd.exe /c build.cmd -o test
```

不是 `./build.sh`，也不是裸 `mvn`（`build.cmd` 的注释写明了原因：
默认 `JAVA_HOME` 指向 JDK 17，裸 `mvn` 会被 `maven-enforcer-plugin` 拒；项目要 JDK 21）。

---

## 教训

**任务书里写「用 X 命令」之前，先验证 X 在这条执行路径上真的能跑。**

我写了 `./build.sh -o test`，是因为我在主线程用 Git Bash 跑成功过。
但 dsh 不是从 Git Bash 启动的，它在一个受限的 PowerShell 环境里，
两者能用的工具集不同。

同理，我写了「修改 D:/Server/...」，是因为路径本身是对的，
但**路径对 ≠ 可写**，可写性由启动目录决定。

这两条都属于同一类错误：**把我所在环境的假设，当成对方所处环境的现实。**

---

## 与主线程越界的关系

这次错误还有一层：

在我发现沙箱问题前，dsh 已经跑了 33 步。我那 33 步里做的「取证」
（读 session 日志、解压 zstd、读 dsh 插件源码确认 `workspaceRoot: process.cwd()`）
是**调度者该做的事**——判断一个 agent 是否能完成任务，本来就是调度职责。

但我在中途一度想过「那我自己去改吧」，那是越界。
正确的动作是：**发现环境不对 → 停掉 → 修环境 → 重派**，而不是接手。
