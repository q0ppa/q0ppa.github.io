# CORGI: Efficient Pattern Matching With Quadratic Guarantees
<p subt>Daniel Weitekamp (2025), doi:10.48550/arXiv.2511.13942</p>

## Abstract & Introduction

规则系统在实时场景中必须快速完成复杂匹配。RETE 类算法的核心缺陷在于，当规则含有大量欠约束变量时，作为中间产物的**部分匹配**即 **partial matches** 会组合爆炸，**时间和空间开销呈指数增长**。

CORGI 即 **Collection-Oriented Relational Graph Iteration**，面向集合的关系图迭代。它永远不会把 partial match 或完整的 conflict set 存到内存里。

### Production System

**产生式系统 (Production System)** 是这样一类系统：它维护一个 working memory (WM)，其中的 element 可以被各种规则匹配，而每条规则是一对**条件 + 动作**。当条件被满足的情况下，就执行动作来修改 WM 中的元素。

条件一般由大量子条件组成，算法一般会在工作记忆里找出满足所有子条件的对象组合，一个组合称为一个 **match**。所有 match 的集合叫 **conflict set**。

然而假设工作记忆里有 $N$ 个对象。一条规则有 $K$ 个变量。如果这些变量之间的约束很松，那么满足条件的组合数量可能是 $N^K$。传统算法 RETE 的核心思路是记忆化；由于每条规则在一个周期之内，对 WM 的改动一般是极小的，所以很多中间结果可以复用；然而 partial matches 也会随着规则变量增多而组合式增长。

#### 根本问题

RETE variants 通过哈希索引、多线程、更好的数据结构等方案解决了很多问题，但一个问题是根本性的：即使规则本身约束得很好，**conflict set 本身**也可能大到无法维护。举个例子：

<div bg box>

**The Valentines Problem.**

SuperDooper Corporation employs a large number of remote employees. This February, the Houston office has tasked all remote employees currently assigned a project with a fun cross-office engagement task: mail a Valentine’s letter with candy to N junior employees (i.e., any employee hired after them, as indicated by a higher employee number than theirs) who are living in a different city.
</div>

这个任务需要匹配：
- Department `D` where `D.city = "Houston"`
- Employee `E` where `E.home != D.city`
- Project `P` where `E.project = P.id`
- Junior employee `J` where `E.id < J.id && E.home != J.home`

这个组合数是四次方的。对于更加复杂的条件，conflict set 还会进一步增长，这完全超出了 RETE 的实际能力范畴。

## General Idea

<div info>

这里和论文的 method 并不一致，但是一个等效且更易于理解的模型。
</div>

### 前向遍历

CORGI 的做法是对每一个子条件制作一个关系图。例如对子条件 `E.project = P.id`，可以为其制作一个 $|E| \times |P|$ 大小的**位矩阵 (bit matrix)**，存储每一对 $\lang e, p \rang$ where $e \in E, p \in P$ 是否能够满足此条件。这个过程的时空复杂度都是 $\mathrm O(N^2)$ 的，其中 $N$ 是 WM 的大小或者 WM 中元素的数量。

<svg width="500" height="300" viewBox="0 0 350 210" xmlns="http://www.w3.org/2000/svg" font-family="system-ui, sans-serif">
  <rect width="360" height="380" fill="#fff"/>
  <text x="180" y="16" text-anchor="middle" font-size="13" font-weight="700" fill="#1e293b">关系图结构</text>
  <circle cx="50" cy="90" r="22" fill="#3b82f6"/>
  <text x="50" y="97" text-anchor="middle" font-size="14" font-weight="700" fill="#fff">D</text>
  <circle cx="180" cy="90" r="22" fill="#3b82f6"/>
  <text x="180" y="97" text-anchor="middle" font-size="14" font-weight="700" fill="#fff">E</text>
  <circle cx="310" cy="30" r="22" fill="#3b82f6"/>
  <text x="310" y="37" text-anchor="middle" font-size="14" font-weight="700" fill="#fff">P</text>
  <circle cx="310" cy="150" r="22" fill="#3b82f6"/>
  <text x="310" y="157" text-anchor="middle" font-size="14" font-weight="700" fill="#fff">J</text>
  <line x1="72" y1="90" x2="158" y2="90" stroke="#94a3b8" stroke-width="2"/>
  <text x="115" y="102" text-anchor="middle" font-size="9" fill="#475569">E.home ≠ D.city</text>
  <line x1="200" y1="82" x2="290" y2="42" stroke="#94a3b8" stroke-width="2"/>
  <text x="245" y="65" text-anchor="middle" font-size="9" fill="#475569">E.project = P.id</text>
  <line x1="200" y1="100" x2="290" y2="140" stroke="#94a3b8" stroke-width="2"/>
  <text x="235" y="128" text-anchor="middle" font-size="9" fill="#475569">E.id &lt; J.id & E.home ≠ J.home</text>
  <rect x="5" y="150" width="90" height="22" rx="6" fill="#f59e0b"/>
  <text x="50" y="165" text-anchor="middle" font-size="9" font-weight="600" fill="#fff">D.city="Houston"</text>
  <line x1="50" y1="150" x2="50" y2="112" stroke="#f59e0b" stroke-width="1.5" stroke-dasharray="3,3"/>
  <text x="180" y="180" text-anchor="middle" font-size="10" fill="#64748b">节点 = 变量，边 = 二元关系</text>
  <text x="180" y="198" text-anchor="middle" font-size="10" fill="#64748b">每条边只维护变量对的映射</text>
</svg>

CORGI 要求将变量分配不重复的序号，所以所有节点一定是**严格全序**的。CORGI 定义关系的流动方向为升序流动，所以整张图成为了**有向无环图 (DAG)**：从编号最小的变量开始，可以依次处理每个变量参与的关系，计算并更新映射。

所有的变量会被按顺序处理，先从上游得到 candidate 并取交集，然后根据 $\alpha$ 条件（即数据只来自节点自身的条件，如 `D.city = "Houston"`）进行筛选。接着根据 $\beta$ 条件计算下游，并传递给下游节点。

例如如果定义变量顺序为 $E \to D \to P \to J$，处理 $E$ 时，$E$ 没有上游，所以 candidate = $\Sigma$；此时它计算所有下游的 candidate $D, P$ 和 $J$ 并传递给下游。接着 CORGI 会依次处理 $D, P$ 和 $J$。

<div info>

由此可以发现，应该**把能最大程度减少搜索的变量尽可能提前**，来缩小下游节点的 candidate，从而创建更小的矩阵。一个简单的 heuristic：**关系度 (degree)** 越大，编号越小，使得其更早被处理。
</div>

### 后向匹配

如果 CORGI 想要一个具体的实例，则 CORGI 从终端节点开始迭代。比如对于这个 Valentine Task，希望得到的实例是 $\lang D, E, P, J\rang$。这个图中，$P$，$D$，$J$ 都是终端节点（**没有下游子节点**），而 $E$ 不是。

<div info>

**下游子节点**指的是与当前节点相连，且编号大于当前节点的节点。CORGI 的关系图**必然存在至少一个终端**，即编号最大的节点。
</div>

那么比如上图中，CORGI 可以从 $J$ 开始，沿反边找到合适的 $E$，进而找到对应的 $D, P$。这是一个快速、静态的查表过程，不影响任何内容。

$$J \to E \to (D, P)$$

这是一个 DFS 的匹配过程，状态会被**以 iterator 的形式保存**。

### Why Bit Matrix

位矩阵的好处很多：
- O(1) 查找，按位置访问，无哈希计算；
- 内存紧凑，数据连续导致缓存友好；
- 动态增删高效，删除时只需把行或列标记为空。
