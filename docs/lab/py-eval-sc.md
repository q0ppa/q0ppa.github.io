# Python SC Eval

## 2026-11-17 orientation

#### Terms

- **Witness**：从入口到 vulnerability function 的一串 `(caller, file:line, callee)`；
- **Identity**：被调方实际落在哪一份物理文件。

### SCA

如果单纯考虑“我们是如何分析供应链存在的问题的”，这个问题的答案可能很 trivial：

<div stmt>

1\. 我们获取到当前仓库的所有 dependency；
2\. 检查它们是否都是安全的。
</div>

假设我们有一个项目：

```txt
Application A
├── requests==2.31.0
├── flask==3.0.0
└── numpy==1.26.0
```

这看起来非常 trivial，但这只是 direct dependencies。实际上真实项目可能出现：
- **Transitive Dependencies**：项目没有直接声明的依赖，是否也需要负责？
- **Dependency Resolution**：不同依赖对同一个包提出不同版本要求，最终解析成什么版本？
- **Dependency Conflicts**：版本冲突如何解决？
- **Dependency Provenance**：某个依赖究竟来自哪里？
- **Dependency Identity**：两个同名包是否真的来自同一个可信发布者？
- **Dependency Changes**：一次升级会引入哪些新的安全风险？

而且，依赖关系还会随着环境发生变化，i.e.

```sh
if platform == "Windows":
  install package A
else:
  install package B
```

由此产生了 **Software Component Analysis (SCA)** 这一 tradition。

<div info>

不过如果输入已经是一个准确的、包含完整传递依赖的 **SBOM (Software Bill of Materials)**，每个组件都有准确的名称、生态系统和版本，那么漏洞匹配基本上就是一个数据库 Join。这个过程本身确实没有什么深刻的算法问题。

所以 ***what makes SCA nontrivial?***
</div>

#### SCA 的核心问题

> Given an arbitrary software artifact, reconstruct its software composition and establish reliable identities and relationships for its constituent components.

SCA 关注的是一条完整的软件供应链信息恢复问题，最后一步的漏洞匹配可能非常简单，困难的是前面的步骤。例如：

仅有名字和版本无法确定一个组件的身份，npm 的 `logging`、PyPI 的 `logging`、Maven 的 `org.exmaple:logging` 和某个人维护的 `logging` fork 不是同一个东西，所以供应链领域研发出了 <span key>**Package URL (PURL)**</span> 体系。

如何在不同 package ecosystem、不同仓库、不同来源中，准确判断两个组件是否是同一个组件？这在实际工程当中，甚至可以是一个**困难的开放问题**。

同时漏洞版本匹配方面，也不总是简单的数字比较，如 `1.0 → 1.1 → 1.2 → 2.0`，比如一些版本语义中 1.10 > 1.9，另一些中 1.10 < 1.9；而对于更变态的版本规范如 **Python PEP 440**：

<div stmt center>

1.0.dev1 < 1.0a1 < 1.0b1 < 1.0rc1 < 1.0 < 1.0.post1 
</div>

漏洞的影响范围也不是一个连续区间，可能中间被修复之后，后面的某个分支又引入了相同漏洞。此外，还可以考虑 Git 的非线性历史。

最容易导致误判的一个情况是**下游发行版 Backport**：上游项目在新版本发布的补丁，可以被维护着反向移植到自己维护的老版本软件包中，从而让扫描器产生 false positive。

### PyCG SC Case Study

当然在 PyCG 中，以上全都不是需要关注的问题。PyCG 关注的是：
- 上游仓库存在某个漏洞函数；
- 通过分析 call graph，确认当前仓库是否真的调用了存在漏洞的函数，而如果没有调用，**是否可以认为风险有所降低**。

具体的实验流程为：
- 访问 GitHub Advisory Database，按照漏洞严重程度寻找存在漏洞的 Python 软件包；
- 选择能明确定位漏洞函数的两个包 PyYAML (CVE-2017-18342) 和 Paramiko (CVE-2018-7750)，查询 GitHub 上依赖这两个包的项目。
- 由于部分项目是私有仓库或已经不存在，分别成功下载 570 和 322 个项目，对其中每个项目运行 PyCG 生成 call graph。
- 对 PyYAML，106 / 570 个项目被成功生成了 call graph，而 Paramiko 是 322。剩余项目由于使用 Python 2 而不被支持。

数据：
- 106 个使用 PyYAML 的项目中，只有 **42** 个调用了漏洞函数 `load()`；
- 72 个使用 Paramiko 的项目中，<span key>**没有任何一个项目**</span>调用漏洞方法 `start_server()`，而且甚至有12个项目没有调用 Paramiko 提供的任何函数，只是在 requirements 文件中声明了依赖。

### 批评

<div quote>

这个 Case Study 证明的是 PyCG 可以辅助做某种局部的、函数粒度的依赖影响分析，而不是证明 PyCG 能够有效地支持真实的软件供应链安全分析。
</div>

#### 没有进行间接依赖实验

```txt
Application A
    |
    +-- Package B
           |
           +-- Package C
                   |
                   +-- Vulnerable Package D
                             |
                             +-- vulnerable_func()
```

实际上我们需要回答：
- A 是否依赖 D？
- 这种依赖是否通过 B、C 传递？
- 最终是否能够到达 D 的漏洞函数？

因此，不能简单地把每个 GitHub repository 当成一个孤立的 Python 项目，然后运行一次 PyCG，就认为已经完成 supply chain impact analysis。当然，这是复杂的。

#### 没有针对 Supply Chain Impact Analysis 定义指标

我觉得需要给出一种 <span key>**Vulnerability Exposure Report**</span>，有两个研究目标：**是否发现了 exposure？是否完整找到了所有 exposure 的具体位置？**

这里有两个层次：repo-level 和 call-site-level，形式化为

$$\mathrm{Exposure}(R) \in \{ 0, 1 \}$$

$$\mathrm{Sites}(R) = \{ s_1, \dots, s_n\}$$

后者主要关注 **direct vulnerable call sites**。针对这两个层次，可以分别统计 P/R/F1 分数。

<div info>

分析结果包含更多信息，不代表分析结果更有价值。尤其是当这些信息不能对应独立的修复操作时，额外的报告甚至会降低**信息有效性 (information utility)**。因此 call-site-level 应该只统计直接调用漏洞 API 的源代码位置，而间接调用关系不能被当作额外的漏洞位置。
</div>

#### Case Study: Indirect reach?

一个漏洞虽然藏在多层依赖之后，但我们能否沿着依赖链追踪，最终把它映射回目标仓库实际调用的位置？这其实应该是一个比较重要的问题。

这个是一个 **Dependency Entry**，它对于上游来说是一个 vulnerability 的 sink，构想这样一个例子：

<div stmt>

我们真正关心的下游仓库 A 依赖于中间仓库 B，B 依赖于出现漏洞的仓库 C（当然实际上可能存在更多层次的依赖关系，但这里简化为两级）；
这里特殊性就在于，B 当中**所有直接和间接调用** C 中的 vulnerable function 的函数，其在 A 中的 caller 都应该被标记。这是一个 Cross-repository tracing。
</div>

#### Verdict

我是这么认为的：

**call-site-level**，indirect 做 scoring eval 是困难的，<span key>**小规模做 direct 的 scoring eval 是重要的**</span>；

**repo-level**，<span key>**两个都可以做，而且都比较重要**</span>。它只需要回答：

$$\mathrm{Exposure}(A) = 1?$$

根源在于检查可达性，和检查 call site 完整性的工作量不在一个数量级。Reachability 方面，找到一个 valid witness 即可证明 Positive；Call-site 则要求**完整性**，必须证明所有符合条件的调用位置均已找到。

<div quote>

We investigate vulnerability exposure in software supply chains at two complementary granularities: repository-level exposure detection and call-site-level exposure localization. We distinguish direct and transitive dependency scenarios, and tailor the evaluation methodology to the fundamentally different ground-truth requirements of existential reachability detection and exhaustive call-site identification.
</div>

### 4 GTs

#### A. Repository-level GT

确定 repository 是否存在 vulnerability exposure。

- 对 Positive repository，寻找并人工验证至少一个 witness path。
- 对 Negative repository，使用有明确边界的审查、受控 benchmark 或其他独立验证方式确认不存在有效路径。

#### B. Direct Call-site-level GT

枚举所有直接调用 vulnerable API 的位置。
使用 AST 进行候选位置枚举，独立解析符号，再进行人工确认。

#### C. Indirect Repo-level Case Study

证明存在跨仓库分析的能力。N cases，具体规模待定。

#### D. Indirect Call-site-level Case Study

展示跨 Repository 的漏洞可达性传播和调用位置映射。

使用人工选择的依赖链，逐层验证调用图与跨仓库调用关系，最终展示目标仓库中所有能够进入漏洞依赖链的调用位置。

不强求生态级的完整 P/R/F1。

## 2026-11-17 Smoke Test

三个 concern：
- **T1. 引擎的 call graph 有边但是对应不到 call site 怎么办？**
- **T2. 仓库有多少是可以下载的？** 比如，可能仓库已经找不到了（已经删除 / 私有）；可能拿不到有问题的版本；可能无法解析（比如使用奇怪的 Python 版本）；etc.
  - <span com>DeepSeek 管这个叫语料链路，晕晕……</span>
- **T3. 引擎有没有能力区别同名的依赖，每次都指向正确、无歧义的位置？**

````md
顺带解决了身份问题，而且结论和预期不同

fixture：本地放一个假 six.py（含 local_only），venv 里装着真的 six，app.py 同时调用本地函数和真包才有的 six.with_metaclass。

```
six 节点: 3       → six, six.ensure_text, six.local_only
本地独有函数: 存在
真包函数:     不存在，调用变成 <dynamic>.app.main@6:4[missing_target]
```

引擎既不合并、也不区分，它按 import 顺序选一份，另一份根本不进图，而且不汇报选了哪份。加了 --include-external 也一样。

所以身份从"引擎能力"变成了"语料构造的不变量"：分析根固定为"项目源码树 + 一份钉死的 wheel"，身份就唯一可判定；混入第二份才记 unanswerable。这比原来"引擎对不对"的框架简单得多，而且不依赖引擎行为。已改 PLAN §8 第 4 点。

两份记录在 evalsc/docs/ref/，verify 仍然 PASS。
````

### 规模问题

之前让 AI 自己随便定的 case 只有十几个下游，所以考虑从 top-15000 里跑一遍反向依赖，从中找到合适的。AI 的计划：

```md
1. 从 OSV 的 PyPI 全量 dump 取所有公告（osv-vulnerabilities.storage.googleapis.com/PyPI/all.zip，可离线）
2. 只保留：受影响区间里有可钉版本（< 修复版）+ 有 3.12 可装的 dist + 声明者 ≥ 100
3. 剩下的人工过第三关"符号能落到 文件:行"（OSV 不给符号，这一步只能人看，和 screening.md 当初一样）
4. 取 2 个
```


