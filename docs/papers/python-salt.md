# Prompt Less, Infer More: Static Analysis-Guided LLM Type Annotation for Python
<p subt>Oh <em>et al.</em> (2026), doi:10.48550/arXiv.2610.41617</p>

## Abstract & Introduction

类型标注提升 Python 程序的可维护性与可靠性，但许多真实项目仍然标注不足。近期的神经网络与 LLM 类型推断系统能够恢复缺失的标注，却往往在准确率与效率之间取舍。既有方法要么未能利用项目范围的类型证据，要么通过不必要的模型调用与嘈杂的 prompt 低效地利用。

SALT 将静态分析与 LLM 推断整合起来，静态地解析类型、对 LLM 查询进行优先级排序，并构造简洁的类型感知上下文。SALT 在所评估系统中取得最佳准确率，与强 coding-assistant 基线相比，估计 LLM 成本降低最多 78.5%。它在前沿模型 GPT-5.5 上也展现出类似的成本节省，表明 SALT 在强 LLM 下仍然有效。

### Prelude

论文使用 TYPyBENCH 作为 benchmark，它由真实的、类型标注完整的 Python 项目构成，评测方式为把标注全部删除来让系统重新推断，再和原标注比对。

使用的工具包括：
- **TIGER**，一个专用的类型推断系统，底层是用 CodeT5 微调过的神经网络模型。CodeT5 是 Salesforce 训练的一个代码理解/生成模型。
- **TYPET5**，同样基于 CodeT5 微调。
- **TYPEGEN**，一个基于大语言模型（LLM）的专用类型生成系统。它把代码切片、已有类型信息和思维链示例放进 prompt，让 LLM 生成标注。
- **AIDER**，一个开源的通用 AI 编程助手，不是为类型推断设计的。

结果如下：

| Model | TIGER | TYPET5 | TYPEGEN | AIDER |
|:-:|:-:|:-:|:-:|:-:|
| Acc | 49.83% | 69.30% | gpt-oss: 46.51% | GLM-4.7: 83.13% |

TYPET5 是专用工具里最强的，比 AIDER 低约 15 个百分点；TYPEGEN 虽然使用了 LLM，准确率却很低，说明「使用了 LLM」本身并不代表着问题已经解决。

### Motivating Example

```py
class String: def kind(self, name: str) -> str: ...
class Bytes: def kind(self, name: bytes) -> bytes: ...
def get_paths() -> list[str]: ...
def internal(name):
  x = get_paths()
  paths = pack(x, name, "i-str")
  return paths
def external(name):
  x = external_func()
  paths = pack(x, name, "e-str")
  return paths
def pack(paths, name, msg):
  print_log(name, msg)
  k = String()
  return [(norm(p), k.kind(name)) for p in paths]
def norm(path):
  return path.rstrip()
def print_log(name, msg) -> None:
  print(f"{name}: {msg}")
```

#### 双向推断

在这个例子中，前向推断沿着调用边把 caller 的类型传给被 callee：`internal()` 和 `external()` 把 string literal `"i-str"` 和 `"e-str"` 传给 `pack()`，所以 `msg: str` 可以前向确定。

```py
class String: def kind(self, name: str) -> str: ...
# ...
def pack(paths, name, msg):
  print_log(name, msg)
  k = String()
  return [(norm(p), k.kind(name)) for p in paths]
```

然而，`pack()` 的第二个参数 `name` 的类型只能后向确定：`k = String()` 让 `k.kind(name)` 解析到 `String.kind`，而第一行写了它的参数类型是 `str`。forward only 的设计就会漏掉这条。

#### 查询顺序

TYPET5 采用 callee-first 顺序，这个顺序隐含一个假设，即先确定底层函数，上层函数就能从底层函数推出来。但实际上 callee 并不总是类型信息的源头，上层函数的参数类型可以决定下层函数的实参类型，从而减少查询的次数。

#### 上下文构造

TYPET5 和 AIDER 收集的函数上下文是按函数名和变量名搜索得到的结果，这有两个问题：
- **不准确**：在这例子里，有两个 `kind()` 函数，按名字搜的话两个都会被搜到，但二者之间完全无关。
- 既有的上下文构造方式，如果想把类型证据补全，就必须把一大串函数体塞进 prompt，导致 token 成本很高

#### 结论

- 前向和后向证据不能各自独立使用，必须合起来解释。
- 决定先查哪个函数时，应该用静态推断结果找到最高价值的目标。
- 用类型分析构造准确且简洁的上下文。

## Algorithm

### Forward and Backward Analysis

论文把 Backward Analysis 收集到的证据分为两类：
- **Strong evidence** $B_s$：明确的类型约束，如 `isinstance(x, int)`，直接说明 `x` 在该分支中是 `int`
- **Weak evidence** $B_w$：来自 callee，如 `g(y)` 的参数类型是 `int | str`，说明 `g` 接受这些类型但不代表 `y` 一定只能是它们。

<div info>

Python 的类型标注主要用于静态检查，并不会自动在运行时强制执行。如果是有运行时强制类型检查机制的其他语言，可能这种约束就会变得 strong。
</div>

此刻函数中存在三种证据：
- $F$：caller 传入的类型
- $B_s$ 和 $B_w$

如果这些证据不一致，那么 SALT 会优先合并 Forward 和 Strong evidence，两者的候选类型取并集；谨慎使用 Weak evidence，只有当 $F_s$ 未知，$B_w$ 恰只有一个类型时才选用 $B_w$；如果最终结果还是包含 Unknown，就不能确定具体类型，保留未知状态。

<div info>

为什么取并而不是取交集？Intuitively，比如说传入的数据如果能不满足 strong evidence，似乎应该是一个错误。
但实际上 SALT 会聚合所有路径的证据得到一个总和，$F$ 和 $B_s$ 的路径分别来自不同的调用点/控制流分支，并不总是描述同一个具体情境，所以完全可以存在冲突。
</div>

### Query Prioritization

经过 Forward / Backward Analysis 和静态类型推断后，仍然可能有很多函数的参数类型无法确定。此时可以让 LLM 推断，但 LLM 调用有成本，因此需要决定查询顺序。

考虑两个启发式的指标：
- **Impact**：函数对其他函数的潜在影响。
- **Richness**：目标函数现有的类型证据的丰富程度。

函数会先比较 Impact 再比较 Richness，因为 **Impact 是 interprocedural，可以带动更多的 intraprocedural 分析**。

具体的量化方式为，

#### Impact

<div center>

$\mathrm{Impact}(m) = \| \{ n \in \mathrm{Unresolved}(P, A) \mid \\ (n, m) \in G_A \lor (m, n) \in G_A \} \|$
</div>

- 对于当前静态分析构建的 call graph，将其作为一个无向的单图（一对函数的互相、多次调用都只计一次）；
- 统计一个函数的 unresolved 邻居数量，作为 Impact。

#### Richness

首先，函数中如果有一个

<div center>

$\phi(P, A, m) = \{(m, i) \mid (m, i) \in \mathrm{slots}(P), \\ A((m, i)) = \{ \mathrm{Unknown} \}\}$
</div>

在整个 Python program $P$ 中，目前已经知道的类型标注集为 $A$。考虑函数 $m$，找到其所有仍然需要推断的参数集合，就是如上的 $\phi$。

举个例子：`def f(x: int, y, z)`

$$\phi(P, A, foo) = \{f.y, f.z\}$$

对每一个 slot 计算 backward evidence 的强度 Hint，通过查表得到：

$$\mathrm{Hint((F, B_s, B_w), s)}$$

| | concrete $B$ | partial $B$ | unknown $B$ |
|-:|:-:|:-:|:-:|
| concrete $F$ | 1.00 | 0.75 | 0 |
| partial $F$ | 0.75 | 0.50 | 0.25 |
| unknown $F$ | 0 | 0 | 0 |

<div info>

concrete 说明已经确认收集到的类型就是全部可能的类型
</div>

把一个函数的所有 Hint 计算算术平均，就能作为 Richness 分数。

### Type-Aware Context Construction

本节关注给 LLM 看哪些代码，以及要把哪些静态分析了解的内容发送给 LLM。

#### Code Context

首先根据 call graph $G_A$ 找到所有 caller 和 callee，它们都需要被包括；此外由于 call graph 可能不完整，SALT 会 fallback 到 lexical name matching 寻找额外的可能的 caller 和 callee。

对于 caller，因为 caller 的函数体能展示目标函数的参数是怎么被构造和传递的，所以**完整传递**；

对于 callee，如果 callee 已经完全标注，它的 **signature** 通常已经包含 LLM 需要的类型信息，没必要再塞入整个函数体。如果 callee 还没有完整标注，那么 signature 不够用，这时候需要看 body。

#### Type-Hint Context

SALT 会提供 slot 和三项 evidence，并且区分 strong 和 weak evidence，比如提供这样的摘要（仅供参考）：

```py
paths <- list[str]  # from internal
paths <- Unknown    # from external
```

## Eval

RQ1：SALT 是否能提高类型标注准确率，同时减少 LLM 使用量？
RQ2：SALT 的不同设计分别贡献了什么？
RQ3：换用不同 LLM，SALT 是否仍然有效？

### RQ1

比较对象主要是 AIDER，测试了 Gemma 4、gpt-oss、GLM-4.7，以及 GPT-5.5。可以发现**成本上的显著降低**，说明 <span key>**SALT 的主要价值不是单纯提高模型能力，而是让模型以更少的调用和 token 消耗，达到更好的结果**</span>。

| Model | Method | Accuracy | LLM calls | Cost |
|:-:|:-:|:-:|:-:|:-:|
| Gemma 4 | AIDER | 72.03% | — | — |
| | SALT | **76.76%** | — | — |
| gpt-oss | AIDER | 82.41% | 4,733 | $35.25 |
| | SALT | **84.06%** | 3,167 | $9.59 |
| GLM-4.7 | AIDER | 84.13% | 4,752 | $285.08 |
| | SALT | **85.82%** | 3,146 | $61.19 |
| GPT-5.5 | AIDER | 92.71% | 640 | $73.42 |
| | SALT | **93.09%** | 448 | $18.49 |

### RQ2

| Configuration | Accuracy | Calls | Tokens (M) | Price ($) |
|-|-:|-:|-:|-:|
| FORWARDONLY | 81.16% | 3,666 | 29.00 | 11.18 |
| NOSTATICFILL | 83.06% | 5,069 | 36.83 | 14.05 |
| NOFEEDBACK | 83.00% | 3,814 | 31.50 | 12.07 |
| CALLEEFIRST | 82.45% | 3,373 | 26.79 | 10.31 |
| NOCOMPRESSION | 83.31% | 3,554 | 74.10 | 26.89 |
| SALT | **84.06%** | **3,167** | **24.94** | **9.59** |

- **Forward-only**
  - 不做 backward analysis，丢失从 callee 反向传播的类型信息
- **No static fill**
  - 不用静态分析直接补全类型，增加了不必要的 LLM 查询
- **No feedback**
  - 不在 LLM 标注后重新进行静态分析，则无法利用新标注传播出更多类型
- **Callee-first**
  - 优先查询叶子函数，则可能先查询低 leverage 函数
- **No compression**
  - 不压缩 context，Prompt token 消耗明显增加（变为近3倍）
  
### RQ3

SALT 的效果是否依赖某一个特定的 LLM？换用不同能力、不同架构的模型，收益是否仍然存在？

换用一个强 LLM GPT-5.5，此时 SALT 仍然把成本降低了 74.8%，准确率还提高了 0.38pp。这说明静态分析带来的效率收益并不依赖于底层 LLM 能力较弱。

## Discussion & Limitations

### Exact-match accuracy 不足以衡量类型质量

假设开发者写的是 `Sequence[PackageNode]`，SALT 推断出 `list[PackageNode]`，从 exact-match 的角度看，这是错误的，因为二者不完全相同；但从 Python 类型系统的角度看，`list[PackageNode]` 通常可以作为 `Sequence[PackageNode]` 使用。它可能是一个有效、甚至更具体的类型标注。

反过来也成立：和 ground truth 完全相同，也不一定意味着这个标注在实际程序中没有问题。

作者统计时排除了原始代码中已经存在的 alarms，只计算类型标注生成后新增的类型相关问题，发现 SALT 并不是在所有模型上都能减少 alarms。此时有一个重要的细节：`Any` 可以抑制很多 type-checker alarms，因为它弱化了类型检查约束。

作者因此进一步统计 standalone `Any`：AIDER 产生的 standalone `Any` 比 SALT 多 82.3%，其中 66.7% 与开发者原本写的类型不匹配。在 SALT 的 standalone `Any` 中，这个比例是 49.0%。

由此认为，SALT 在显著降低 LLM 成本的同时，生成的标注没有表现出明显更差的 type-checker compatibility，而且比 AIDER 更少依赖 standalone `Any`。

### Case Study

抽样分析了 100 of 678 个 GLM-4.7 下 SALT 正确、AIDER 错误的 slot：

#### Strengths

如果证据存在于更远的调用链上，普通 caller-callee context 覆盖不到，静态分析依然可以捕捉它。

把代码中明确存在的值流证据转化成显式类型提示，也会减少 LLM 用常识猜测替代程序事实的机会。

#### Weaknesses

Static analysis 可能过度收窄类型，比开发者真正希望公开的类型更具体。包括：

- **Return type over-narrowing**，函数的公开接口可能希望表达一个更一般的抽象，这属于意图对齐范畴；
- **Parameter type over-narrowing**，当前项目中观察到的调用，并不一定覆盖 API 允许的全部输入。

### Threats to Validity

**Construct Validity：评价指标是否真正测量了我们关心的东西？**

exact-match accuracy 不能充分衡量类型标注质量，这个问题还需要进一步研究 developers’ preferences。可能需要关注，比如：
- 类型是否符合开发者的设计意图；
- 对于 API 用户，这个类型是否合适；
- etc.

**External Validity：实验结果能否推广到其他项目？**

实验使用了 12 个 TYPYBENCH 项目，并且人为移除了原本的类型标注，形成一个 controlled setting，这样有 developer-written annotations 可以作为 ground truth，方便比较不同方法。

然而，真实项目可能只缺少部分标注，缺失的部分也可能集中在特定模块或特定类型上，而不是像实验那样通过移除标注构造数据集。

**Internal Validity：观察到的效果是否可能受到实现或实验过程的影响？**

静态分析可能引入错误，实际上 Python 分析工具为了可扩展性、运行速度和实用性，也往往会选择不完整地建模语言语义、调用关系和外部环境。

另外，LLM 存在 non-determinism，相同 prompt 多次调用模型，可能得到不同预测，因此实验结果可能受到模型随机性的影响。
