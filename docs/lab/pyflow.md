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

### 突然出现问题

远程仓库更新后我本地的 bench repo 突然变得爆炸慢，何意味？

两个致命错误：Fatal KeyError + runtime 暴增（bench repo **大概比原来慢100倍**，吓哭了）

#### KeyError

`_descriptor_bind_values` 里模块级内置函数被当成类方法绑定（只要 `instance_class is not none` 就绑定），但是 Python 的一些模块是没有 `.py` 源码可供加载的，所以没有 scope info，`_bind_call_arguments` 直接 crash

- **Fix 1**：`_resolver.py:1765-` 的 `BOUND_METHOD_KIND` / `BOUND_CLASS_METHOD_KIND` 在调用 `_bind_call_arguments` 前增加 `if method_name not in self.scopes` guard。
- **Fix 2**：`_resolver.py:2461-` 的 `_descriptor_bind_values` 不再对所有 `FUNC_KIND class_field` 值无条件创建 `bound_method`。而是仅当 `value.name` 确实是类 MRO 中某个 class 的方法时才创建 `bound_method`。

#### Runtime

BFS loader 做了全传递闭包加载然后疯狂不动点分析。

- **Fix 3a**：`_loader.py:71` 的 BFS loader 在加载模块前检查 resolved path 是否位于 project_root 下；不在则 skip。`cli_tool` scope 数从 3828 → 92。
- **Fix 3b**：`_analyzer.py:697` 的不动点迭代上限收紧（但是影响精度）
  - 影响得并不显著🤔迭代上限设置为4096（`max(256, min(len(self.scopes) * 8, 4096))`），avg prec 只从0.422降到0.413

### 找更多 repo-level bench

#### JARVIS

**JARVIS:Scalable Demand-driven Call Graph Generation for Python**
- 库 https://github.com/pythonJaRvis/pythonJaRvis.github.io
- JARVIS 和 repo bench 存在大量不适应问题🤔

发现的问题
- **project 不存在**：经过调查，`callgraph.json` 必须放在 `manifest.json` 指定的 subdirectory 的根目录，如果 manifest 里的 `path` 不包含 ground truth，就无法被识别为 project。这个好解决。
- **naming 问题**：6个 JARVIS repo 有4个出现了 naming mismatch 导致 0 recall

解决方案
- 在 `callgraph.json` 指定 `_entry_file`，而不是使用搜索模式
- 对于每一个 ground truth（这里使用 EA exhaustive application analysis，考虑尝试别的 ground truth），调整其命名以适配 constraint 和 PyCG 的命名规则
- PyCG 的 `import` 似乎会直接执行要分析的代码？`bpytop.py` 的第65行有一个 unguarded `args.parse_args()` 直接读 `sys.argv`，任何它不认识的 flag 会直接抛 unrecognized flag，导致 PyCG 退出。
  - 怎么会有这种设计，Python 你无敌了，，
  - 考虑直接在这之前先 store `sys.argv`，完成后再 load（还有上下文切换），只需要修改 repo bench runner 就行。
- TextRank4ZH 的命名非常神奇，不好修，直接摆
  - 加一个 `--exclude-zero-recall` flag，统计平均数据的时候排除掉 0 recall 的库，不加就不排除🤔

目前剩下的问题
- 6个 repo 的数据都不好看，修 ground truth 把它变得好看一些

### 修了一下

TextRank4ZH 和 bpytop 解析失败，剩下的 repo 的 precision 和 recall 还是有点问题。下面的时间数据是在原生 Linux 上跑的。

似乎 TextRank4ZH 和 bpytop 超时还是因为 constraint engine 不动点迭代轮数的问题。另外加了个选项 normalize GT，默认开。开了之后 constraint 的数据好看了一些，PyCG 好看了很多。

这里有一个很搞笑的事情是 PyCG 不支持 Python 3.14，鼓捣了半天）

```
================================================================================
                        REPO-LEVEL CALL GRAPH BENCHMARK                         
================================================================================
Engine     Project        Precision  Recall  Runtime(ms)
--------------------------------------------------------------------------------
constraint cli_tool           0.349   0.822       241.15
constraint data_pipeline      0.493   0.367       135.47
constraint furl               0.678   0.369       508.60
constraint ml_utils           0.468   0.449       122.39
constraint repo_sample        0.559   0.950        76.28
constraint rich-cli           0.178   0.533       247.54
constraint sqlparse           0.257   0.351       555.23
constraint sshtunnel          0.492   0.598       185.42
constraint web_framework      0.259   0.300       136.04
pycg       cli_tool           0.199   0.800       207.84
pycg       data_pipeline      0.554   0.567       111.57
pycg       furl               0.022   0.018       289.91
pycg       ml_utils           0.051   0.061       125.94
pycg       repo_sample        0.444   0.800        55.71
pycg       rich-cli           0.128   0.533       128.08
pycg       sqlparse           0.714   0.319       642.44
pycg       sshtunnel          0.145   0.696       429.62
pycg       web_framework      0.471   0.660       139.93

================================================================================
                              PER-ENGINE AVERAGES                               
================================================================================
Engine       Projects  Avg Prec  Avg Rec  Avg RT(ms)
--------------------------------------------------------------------------------
constraint          9     0.415    0.527      245.35
pycg                9     0.303    0.495      236.78

================================================================================
          DELTAS vs constraint (positive = improvement over baseline)           
================================================================================
Project           pycg ΔPrec    ΔRec       ΔRT
--------------------------------------------------------------------------------
cli_tool              -0.150  -0.022    -33.30
data_pipeline         +0.062  +0.200    -23.90
furl                  -0.655  -0.350   -218.69
ml_utils              -0.417  -0.388     +3.55
repo_sample           -0.114  -0.150    -20.56
rich-cli              -0.050  +0.000   -119.46
sqlparse              +0.457  -0.032    +87.21
sshtunnel             -0.346  +0.098   +244.20
web_framework         +0.213  +0.360     +3.89
```