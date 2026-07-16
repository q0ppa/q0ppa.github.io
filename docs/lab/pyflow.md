# Pyflow

## Repo Bench

### Benchmark

eval 评估的是 `analysis/callgraph/` 的 call graph construction。

流程：比较 PyFlow `constraint` engine
- PyFlow 一共有三种分析引擎，一个 **PyCG-based** 作为 baseline，一个 **AST-based** 比较简单粗暴，**Constraint-based** 则是评估的重点。
- **Ground Truth** 即标准答案，它精确地记录了一段给定 Python 代码中，所有我们认为确实存在的函数调用关系。此处，GT 被以 JSON 格式存储，格式类似：

```json
{"caller.qualified.name": ["callee.qualified.name", ...], ...}
```

每个 JSON 名称为 `callgraph.json`。一个例子：

```json
{
    "main": [ "<builtin>.map", "main.func", "main.func2", "main.func3", "main.func3.func" ],
    "main.func": [],
    "main.func2": [ "main.func" ],
    "main.func3": [],
    "<builtin>.map": []
}
```

#### 评估过程

评估对象为 `tests/callgraph/snippets/` 下的代码，这个也是默认的 `--snippet-root`。

```sh
python evaluation/bench_callgraph_engines.py
```

一个 snippet 的目录结构如下：

```c
tests/callgraph/snippets/args/assigned_call
  ├── callgraph.json
  ├── main.py
  └── README.md
```

- `_discover_cases()` 会递归搜索整个 `--snippet-root` 参数对应的子目录，并找到一个有 sibling `callgraph.json` 的 `main.py`。
- `_run_case()` 会调用引擎 API 进行分析，并输出 JSON。统计 **Precision** 和 **Recall**：前者是预测正确的边占所有边的比例，后者是占实际边的比例。

#### PyCG

从 PyPI 安装的 `pycg` 是有问题的，需要从 git 安装：

```sh
pip uninstall pycg python-scalpel -y
pip install git+https://github.com/vitsalis/PyCG.git
python -c "import pycg; print(pycg.__file__)"
```

### Repo-Level?

Repo-level bench 存在，但没有 benchmark runner。

整个 bench 有一个 `manifest.json` 文件提供了每个仓库的信息，目前只是 `name`，`path` 和 `python_files`。

Manually Verified:
- [x] **cli tool**
- [x] **data pipeline**
- [x] **ml utils**
- [x] **repo sample**
- [x] **web framework**

### Low Recall?

- `super().__init__()` 穿透，应该直接解析超类，但是解析工具直接放弃了，其实是合理的🤔
  - 继承链：`ListSource → Source → Component`
  - `Source` 的 `__init__` 是一个 `@abstractmethod`，调用 `Component.__init__`
  - `Component.__init__()` 是最典型的，`Pipeline` 也有同样情况。
- `Loggable.__init__()`：实际上 `Loggable()` 没有 `__init__()` 方法，所以是我的 GT 过于严格了
- `Loggable.log()` 被继承了 `Loggable` 的类以 `self.log()` 的方式调用，PyCG 成功分析出了这种调用方式，而 Constraint 没有
  - `Validatable.validate_or_raise()` 同理

剩下的有这么一些 edges

```json
"data_pipeline.base.Loggable.log": [
  "data_pipeline.base.Loggable._should_log"
],
"data_pipeline.base.Source.__or__": [
  "data_pipeline.pipeline.Pipeline.__init__",
  "data_pipeline.pipeline.Pipeline.pipe"
],
"data_pipeline.base.Transform.__ror__": [
  "data_pipeline.pipeline.Pipeline.__init__",
  "data_pipeline.pipeline.Pipeline.pipe"
],
"data_pipeline.base.Validatable.validate_or_raise": [
  "data_pipeline.base.Validatable.validate"
],
"data_pipeline.pipeline.Pipeline.to": [
  "data_pipeline.base.Sink.consume"
]
```

`base.Source.__or__()`，`base.Transform.__ror__()` 和 `pipeline.Pipeline.to()` 是跨模块调用，constraint 和 PyCG 都失败了。

剩下两个是这样的：

```py
class Loggable:
    _log_level: str = "INFO"

    def log(self, message: str, level: str = "INFO") -> None:
        if self._should_log(level):
            print(f"[{level}] {self.__class__.__name__}: {message}")

    def _should_log(self, level: str) -> bool:
        levels = ["DEBUG", "INFO", "WARNING", "ERROR"]
        return levels.index(level) >= levels.index(self._log_level)


class Validatable:
    def validate(self, data: Any) -> bool:
        return True

    def validate_or_raise(self, data: Any) -> None:
        if not self.validate(data):
            raise ValueError(f"Validation failed for {data!r}")
```

这两条边在 PyCG 都是存在的。这里先压下这个问题，先看看其他 repo。

### 问题分析

**data_pipeline** 上面提到了，不再赘述。

剩下的 repo：

- **ml_utils**：几乎全是超类初始化问题。
- **repo_sample**：和上面一样的处理，对于没有 `__init__` 且没有继承父类的类，不再显式要求创建其 `__init__` 的调用边。目前只漏一条 `asyncio.run`，无伤大雅。
- **cli_tool**：一些 `self.` 前缀的方法，以及通过自身成员进行的成员方法调用（i.e. `self._configs[name].save(path)`）。
  - 移除了 Ground Truth 中的实例化边。
  - 值得注意的是这个 repo 根本没有对 `utils.validation` 进行分析。
- **web_framework**：一些是 `self.` 前缀的方法，一些是跨类。

跨类基本上有两种，一是通过成员调用成员类的方法，二是函数接受参数后调用参数的方法。