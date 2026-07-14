# A GPU Implementation of Inclusion-based Points-to Analysis
<p subt>Méndez-Lojo <em>et al.</em> (PPoPP 2012), doi:10.1145/2145816.2145831</p>

## Abstract

GPU 作为 SIMT 架构，天然适用于操作密集的数组和矩阵，而对于**高度非规则 (highly irregular)** 的算法，主要是操作基于指针的数据结构的算法，其数据访问模式依赖于数据本身，是动态且不可预测的。这正是本文要挑战的领域。当前 GPU 图算法研究主要集中在一类特定的、更简单的子集上：不修改图结构的图分析算法，例如广度优先搜索和强连通分量算法。

**Andersen 算法**相比之下是极具挑战性的，它不仅属于非规则算法，而且是一个 **morph 算法**，即运行时会对底层图结构进行大量修改，同时每个操作本身的计算量很小。

本文中对 Andersen 算法进行 GPU 实现，在一个14核 GPU 上，相比单核 CPU 实现了平均 $7 \times$ 的加速，甚至超越了运行在16核 CPU 上的并行版本（约 $6 \times$）。

### Prior Work

<blockquote bg box>

Harish et al. [14] pioneered this field with their CUDA implementations of algorithms such as breadth-first search and single source shortest paths. BFS has recently received much attention in the GPU community [19, 24, 26]. Barnat et al. [5] implemented a GPU algorithm for finding strongly-connected components in directed graphs and showed that it achieves significant speedup with respect to Tarjan's sequential algorithm. Other irregular algorithms that have been successfully parallelized using GPUs are n-body simulations and some dataflow analyses [9, 30].
</blockquote>

<blockquote bg box>

[...] The closest work to this paper is the GPU implementation of a 0-CFA analysis by Prabhu et al [30]. [...] Our work improves on their solution in several ways: [...]
</blockquote>

## Background

### Inclusion-based PTA

在 PTA 领域一直存在着精度和速度的权衡，像 GCC 和 LLVM 这样的工业级编译器最终选择了上下文非敏感、流非敏感的分析以减少面对大型程序时的计算开销。

**Andersen** 是最热门的 PTA 算法。虽然 Andersen 理论最坏复杂度是 $\mathrm O(n^3)$，但这在实践中很少发生，因为有大量启发式优化手段；它也是上下文非敏感、流非敏感的分析方法的基石。

#### Procedure

Andersen 分为三步：
- **Initialization**，程序中的指针相关语句被抽象出来，对 C/C++ 程序总共有五种：
  | | | |
  |-|-|-|
  | `x = &y` | **Points** | $x \overset p \to y$ |
  | `x = y` | **Copy** | $y \overset c \to x$ |
  | `x = *y` | **Load** | $y \overset l \to x$ |
  | `*x = y` | **Store** | $x \overset s \to y$ |
  | `x = y + o` | **AddPtr** | $y \overset{a, o} \to x$ |
- **Constraint graph creation**，指针变量作为图节点，语句作为边。最终形成一张有向的多图。
- **Solving constraints**，不断应用四条重写规则来重写图直到抵达不动点。
  - **Copy** &emsp; $y \overset p \to z \land y \overset c \to x \Rightarrow x \overset p \to z$
  - **Load** &emsp; $y \overset p \to z \land y \overset l \to x \Rightarrow z \overset c \to x$
  - **Store** &emsp; $x \overset p \to z \land x \overset s \to y \Rightarrow y \overset c \to z$
  - **AddPtr** &emsp; $y \overset p \to z \land y \overset {a,o} \to x \Rightarrow x \overset p \to z + o$

<blockquote info>

`x = y + o` 实质上是 `x = &y[o]` **指针算数**，**不是 field-sensitive**！
</blockquote>

#### Parallelize?

Graph rewrite rule 是可以被并发应用的，因为 Andersen 方法中只**添加**了边，而**没有删除**边；它是一个单调加的算法。这里唯一需要解决的问题实际上是重复添加同一条边，但可能可以通过设计来规避此问题。

### GPU

这一段主要介绍实验使用的 NVIDIA GPU 相关的背景，但相关概念对类似架构也是适用的。

#### SM

实验使用的 GPU 是 **Fermi architecture**，由多个**流式多处理器 (SM，Streaming Multiprocessors)** 组成，Fermi 架构最多可以有16个 SM。每个 SM 内部包含32个紧密耦合的**处理单元 (PE，Processing Element)**，也叫 CUDA core。

#### Warp

同一个 SM 内部的所有 PE 可以执行**独立的线程**，但是它们在同一时刻要么执行同一条指令，要么等待。一系列像这样被绑定在一起、步调一致执行的线程被称为一个**线程束 (Warp)**。

Warp 存在一个严重的问题，即**线程分化 (Thread Divergence)**：当一个线程束遇到 `if-else` 语句时，如果部分线程条件为真，另一部分部分为假，由于所有线程必须执行同一指令，硬件会串行执行不同分支。等所有线程执行完，再**汇合 (re-converge)** 到同一条指令。

#### 多线程并行

一个 SM 可以同时驻留最多48个线程束。在任何给定周期，SM 上**只有一个线程束被真正执行**，但当这个线程束因为访存等高延迟操作而等待时，SM可以在下一个周期**立即切换**到另一个已就绪的线程束去执行。

GPU 可以如此通过线程束间的任意交错来隐藏外部延迟，实现高吞吐量。

#### 内存访问

理想上来说，若一个线程束同时访问的全局内存地址恰好落在**同一个对齐的内存段**（通常为128字节）内，硬件会把这32次请求合并为一次内存操作，访存效率最高。最坏情况则是32个线程访问的地址完全随机分散，则硬件必须发起32次独立的内存操作。

同一个 SM 内所有 PE 共享一个线程池，称为 **Thread Block**；它们也共享同步硬件和 L1 cache，以及一块 **Shared Memory**。Shared Memory 的速度非常快，和 L1 cache 相当；它被划分为多个 **Bank**，其访问存在 **Bank Conflict**：如果多个线程**访问同一个 Bank 的不同地址**，就会产生冲突，导致访问被序列化，降低性能。

#### 全局通信

SM 之间基本是独立工作的，跨 SM 通信的唯一方法是通过全局内存。一个SM把数据写入，另一个SM去读取。因此，在 SM 之间实现同步只能通过在全局内存上的原子操作来完成。这是一种开销高昂的操作，需要合理设计来**减少跨 SM 的同步**。

#### CUDA

CUDA 程序是**主机 (CPU host) + 设备 (GPU device)** 的异构协同工作模式，CPU 负责主干和串行逻辑等，而 GPU 运行的是**核函数 (Kernel)**。一个CPU调用一个核函数时，GPU上会同时启动成千上万个线程来执行它，从而利用上述所有硬件特性。

## Method

### Representation

目前设计上有两个需要考虑的方面：
- **分析图的规模巨大且动态变化**；
  - ※ Linux kernel 的 PTA 包含 14.98 亿条边。
- **内存布局必须经过设计**，最小化显存事务，最大化合并访问，减少分支发散。

#### 否定的方案

**邻接矩阵 (Adjacency Matrix)** 以将图重写规则转化为矩阵乘法，非常适合 GPU，然而使用 Hardekopf 的 PTA 方法发现，gcc、vim 和 linux 三个 bench 的边密度极其低。

下图中计算了 P 边和 C 边在分析开始和结束时的密度，直接使用 $\frac{E}{n^2}$ 来计算。

| **Input** | **$P_i$** | **$P_f$** | **$C_i$** | **$C_f$** |
|:-:|:-:|:-:|:-:|:-:|
| gcc | $5 \times 10^{-7}$ | $6 \times 10 ^{-4}$ | $6 \times 10^{-6}$ | $4 \times 10^{-5}$ |
| vim | $2 \times 10^{-7}$ | $8 \times 10^{-4}$ | $10 \times 10^{-7}$ | $2 \times 10^{-5}$ | 
| linux | $1 \times 10^{-7}$ | $2 \times 10^{-3}$ | $2 \times 10^{-7}$ | $2 \times 10^{-4}$ |

不难发现，邻接矩阵基本浪费了3-4个数量级的空间。

此外，**CSR (Compressed Sparse Row)** 虽然适合稀疏图，但作为静态结构对于会动态加边的 Andersen 是不可行的。

#### Sparse BV

最终采取了 Sparse BV 方案：一个 BV 长度为128字节，其中头部有4字节 **base**，尾部有4字节 **next** 指针，中间为120字节的 **bits**。以4字节为一个 word 的话，一个 BV 恰有32个字，可以供一个 SM 消费，每个 PE 处理一个字。

此处 BV 的 base 即首元素，bits 包含960个二进制位，每一位代表一条边的存在性。

得益于程序变量的**空间局部性**（尤其是 Andersen 分析会使得一个变量的 pts 趋向于聚集），相比于使用窄 BV，根据实验数据，128-byte Sparse BV 的内存开销只增加了2.3倍。这种基于宽稀疏位向量的设计不仅适用于指针分析，也会适用于其他在 GPU 上实现的、共享类似局部性特征的形态算法。

### 并行

多个活动节点、多条规则可能同时向同一个目标节点添加边，导致数据竞争，因此需要同步。一个想法是：

#### 边翻转

将部分类型的边翻转存储，从“因为存在边 $y \overset c \to x$，所以 $x$ 获得新的边”变为“因为存在**反边** $x \overset c \leftarrow y$，所以 $x$ 获得新的边”，即可只修改活动节点自己的出边集合。

只要保证每个活动节点同时只被一个 warp 处理，则无需同步。

#### 改写规则集

- **Copy**<sup>-1</sup> &emsp; $x \overset {c^{-1}} \to y \overset p \to z \Rightarrow x \overset p \to z$

- **Load**<sup>-1</sup> &emsp; $x \overset {l^{-1}} \to y \overset p \to z \Rightarrow x \overset {c^{-1}} \to z$

- **Store**<sup>-1</sup> &emsp; $x \overset {p^{-1}} \to y \overset s \to z \Rightarrow x \overset {c^{-1}} \to z$

- **AddPtr**<sup>-1</sup> &emsp; $x \overset {a^{-1},o} \to y \overset p \to z \Rightarrow x \overset p \to z + o$

```py
do
  rule_kernel(c^-1, p, p)
  rule_kernel(l^-1, p, c^-1)
  rule_kernel(p^-1, s, c^-1)
  rule_kernel(a^-1, p, p)
  transfer changed
while changed

rule_kernel(R, S, T):
  for each x in variables
    if R != a^-1
      for each x -R-> y:
        union S-neighbors of y to T-neighbors of x
    else
      for each x -a^-1, o-> y:
        N <- add o to each S-neighbor of y
        union N to T-neighbors of x
  if T-neighbors of x changed
    changed <- true
```

#### 粒度选择

一个 Block 处理一个节点，会因为节点工作量小而导致大量线程闲置，而一个线程处理一个节点，会因节点间工作量不同（有的要加很多边，有的很少）而导致 warp 内严重的线程分支。

因此，最终选择一个 warp 的32个线程协同处理一个节点，保持 Warp 内控制流一致，并且 Warp 之间通过简单原子操作分配节点。

### Optimizations

#### Minimize memory consumption

存储反边需要翻倍的内存开销。其中，P 边的数量一般是最多的，而且只在 Store<sup>-1</sup> 规则中使用到了 $P^{-1}$。

统计发现对于大多数输入程序，**store 边的数量非常少**，基本不会超过最终边数的 5%<span com>（※ **store 边永远不会被添加**）</span>，因此本文采用了这样的解决方案：
- 处理 store 边时，进行一次扫描对于所有 $(x, y)$ 对，s.t. $y \overset p \to x$ 且 $y$ 有 **store 出边**，收集这些变量对。
- 将首元素相同的对放入同一个 warp（规则添加的边是 $x \overset {c^{-1}} \to z$，只修改 $z$）进行处理。

#### Avoid redundant rule application

需要引入一个 $\Delta P$ 集合，即在**本轮和上一轮**迭代中新添加的边。为此，需要一个额外的核函数来将 $\Delta P$ 中较老的一轮迭代合并到 $P$ 中。<span com>这里论文没展开，但推测是要么需要双缓冲，要么需要缓存本轮更新的。</span>

在每个迭代周期的开始，$\Delta P$ 需要被传回 CPU，同时 GPU 需要启动下一轮的内核。通过 CUDA 的流技术，这两个操作被并行执行。

#### Detect pointer-equivalent variables

**pointer-equivalent variables** 即 $\Delta P$ 相同的变量。对于这些变量中的 $x$ 和 $y$，如果之后有任何规则会影响到 $x$，那么它也一定会以同样的方式影响到 $y$。也就是说，一个 pointer-equivalence class 的所有成员**可以应用同样的 update**。

维护一个 **Hash Map**，key 为 $\Delta P$ 集合，value 为变量本身，为每个键计算一个哈希值，并将键值对按照哈希排序。这样，具有相同 $\Delta P$ 的变量会去到相邻位置。对排序后的键应用**差分操作**。如果一个键与其前一个键不同，就说明它是一个新等价类的开始，在对应位置进行差分标记。最后**对标记数组求前缀和**，则所有同属一个等价类的变量会得到一个唯一的、连续的**簇 ID**。


#### Collapse cycles

如果存在 $a \overset c \leftrightarrow b$ 的拷贝边循环，那么二者可以直接折叠。在分析开始前就找出循环。虽然对串行程序速度提升巨大，但预处理本身很容易成为并行程序的瓶颈。

这里采用了一种折中的方案：系统维护一个 **representative** 表，如果一个变量不是 representative，就忽略它和它所有的边。这样可以**避免复杂的边和节点删除操作**。

## Experiment & Eval

### 评估

#### 资源

**GPU**：1.15 GHz NVIDIA Tesla C2070，6 GB 显存
- <span com>考虑到这篇论文是2012年的，现在这个配置已经完全是 consumer-level 了。</span>

**CPU**：4× 4-core 2.7 GHz AMD Opteron，共16核，24 GB 内存

总共有四种方案：**CPU-s** 串行，**CPU-1** 单线程跑并行代码，**CPU-16** 以及 **GPU**。很神奇的是运行在 Java 虚拟机上的 CPU-1 和 C++ 编写且 `-O3` 的 CPU-s 性能基本持平，甚至略快。

#### 异常值

**vim**：GPU 和 CPU-1 持平，远差于 CPU-16 的 $7.2 \times$ speedup，load<sup>-1</sup> 规则的耗时是 dominant 的。Ben Hardekopf 的 CPU 实现使用了正则的 **BDD (Binary Decision Diagram)** 表示，具有记忆化能力，可以 $\mathrm O(1)$ 查表加速中间计算。

**python**：CPU-16 的耗时和 CPU-1 几乎一致，addPtr 规则拖慢了 CPU 并行。

### 下载地址

https://code.google.com/archive/p/andersengpu/source/default/source
