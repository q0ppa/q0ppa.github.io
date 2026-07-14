# Chaff: Engineering an Efficient SAT Solver
<p subt>Moskewicz <em>et al.</em> (DAC 2001), doi:10.1145/378239.379017</p>

## Abstract & Background

SAT 是一个被充分研究的经典问题，EDA（电子设计自动化）中的自动测试生成、逻辑综合，以及 AI 领域的自动定理证明，都依赖于高性能的 SAT 求解器。主流的 complete solvers 都是基于 **Davis-Putnam (DP) 算法**，Chaff 则通过 **careful engineering**，得到了一到两个数量级的性能提升。

<blockquote info>

这里提到的 publicly available SAT solvers 包括：GRASP，POSIT，SATO，rel_sat 和 WalkSAT。WalkSAT 进行的是启发式局部搜索，但本文主要关注完全、系统的 DP-based 搜索方法。

关于本论文的 impl，可以看看 [**MiniSAT**](https://github.com/niklasso/minisat)。
</blockquote>

<div com>

#### CDCL

本文通过工程方法，实现了 CDCL 即 **Conflict-Driven Clause Learning**，不进行机械回溯和决策，而是对冲突进行学习来进行决策，回溯时也直接回溯到导致冲突发生的最近且未翻转的决策，从而高效搜索和剪枝。

</div>

#### DP backtrack search

CDCL 沿用 DP 的经典主流框架 **DP backtrack search**。

```c
while (true) {
    if (!decide()) // if no unassigned vars
        return(satisfiable);
    while (!bcp()) {
        if (!resolveConflict())
            return(not satisfiable);
    }
}

bool resolveConflict() {
    d ≡ most recent decision not tried both ways;
    if (d == NULL) return false;
    flip the value of d;
    mark d as tried both ways;
    undo any invalidated implications;
    return true;
}
```

<span com>实际上感觉就是带 BFS 的 DP。</span>

每次我们 `decide()` 的时候，会让 **DL** 即 decision layer 增加一层，并把一个新的 **decision** 入栈。decision 经由 BCP 会产生一系列 **implications**，它们都和这个 decision 处于**同一层**。如果当前的 decision 有误，就需要回溯到最近的没有翻转过的 decision，并翻转它。

## Method

### Optimized BCP

在绝大部分 SAT 问题的求解过程中，**BCP 占 90% 以上的时间**。优化这个 hotspot 是非常有必要的。

Recall BCP 的过程：

<blockquote box>

每次 BCP 会**消除成立的 clause**（如当前 unit 为 $(x)$ 的话，就是任何包含 unit $x$ 的 clause），从其他 clause 并**去掉不成立的 literal**（$\neg x$）。当一个 clause 为空时，说明**其所有 literal 均为假，CNF 是 UNSAT 的**。
</blockquote>

如果一个 clause 除了一个 literal 之外，所有的 literal 都被赋值为0，就产生了一个 **implication**，或者说 the clause is **implied**。进行 BCP 时，一个很重要的过程是找到 **newly implied clause**，并且由于需要**频繁更新和回溯**，希望这两个过程都尽可能高效。

一个直观做法是维护 counter，但由于我们**唯一关心的过程是从 not implied 变为 implied 的过程**，对于一个 clause of $n$ literals，$n$ 次维护计数器只有1次是有效的。

#### Watched Literals

Chaff 采取的做法是对每个子句监视两个 literal。如果有两个 literal **未被赋值为0**（可以是1或者未赋值），那么子句一定是 not implied；当其中一个 literal 被赋值为0时，尝试再找到一个 watched，**找不到则说明出现了 implication**。

这个方法的优点包括：
- 若子句有两个 watched literals，则**回溯过程零操作**，因为回溯一定是撤销值，不会导致 watched literal 被 unwatch。
- 若 watched literal 在前向搜索的过程中变化了，新的 watched literal **很可能是更稳定的 literal**，让求解器更新 watched 的频率更低。

### VSIDS

#### Background

`decide()` 的启发式算法在当时没有一个足够好的标准，每种策略都是通过感觉和经验设计，以决策次数来比较的。最简单的算法是随机选择，最复杂的使用神奇的函数最大化启发式如 BOHM 和 MOMs。当时最主流的策略之一则是 DLIS heuristic，**选择在 unresolved clause 中出现频率最高的 literal**。

一个比较通用的标准是决策次数，次数越少说明决策越接近正确，也就越好；然而决策所产生（yield）的 BCP 开销并不相同；较多的 BCP 开销很小的决策可能远快于少数产生很长的 BCP 链的决策。此外，如 DLIS 搜索子句统计 literal 的时间开销实际上也是可观的。因此这里认为应该**采用 wall-clock time 作为量化标准**。

#### Algorithm

- 每个 literal 有一个 counter，初始为0；
- 当一个 clause **被添加**时，构成它的所有 literal 的 counter 会增加；
- 每次决策选择计数最高的未赋值 literal，若有多个则随机挑选一个；
- 所有 counter 会被周期性除以一个常数

<div com>

#### 解读

“被添加”意思应该是 **clause 出现了冲突**。对于近期出现冲突的子句，VSIDS 会更加积极地搜索来尝试满足它们，而早期存在冲突的 clause 有很大可能已经被其他方式解决或与当前的搜索的局部相关性很弱，可以降低其权重。

原文关于 conflict clause 没有展开讲，但大致可以猜到这样的实现：每次出现 conflict，**conflict clause 会被收集起来添加进一个 database**。同时，一个常见的操作是也将这些 conflict clause 连接到原始 CNF 上，这被称为 **clause learning**。

一个 naïve 的方法是学习所有冲突的 clause，但是这样非常低效且浪费资源。更晚一些的算法会找到 conflict 的 **1UIP**（UIP 即 **Unique Implication Point**，也就是蕴含图上 conflict 的支配节点 **dom**；1UIP 即第一的 UIP，也就是 **idom**），从而使学习变得轻量而高效。

</div>

### Other Features

#### Clause Deletion

无限学习 clause 会导致内存爆炸。Chaff 使用 **relevance** 作为删除的判断标准：如果一个 clause 中超过 N 个 literal 被一次性撤销而变得无值了，就认为其变得 **irrelevant**，将其 **schedule for lazy deletion**。

这里提到 N 典型的取值为 100~200。

#### Restart

早期的错误决策会把搜索带入一个巨大的无解子空间。Chaff 的重启会清除所有赋值，但保留所有 **relevant conflict clauses**，禁止求解器陷入相同的冲突，且保留 VSIDS 分数。

GRASP 也有重启功能，但不会保留决策信息，而 Chaff 会保留这些信息；另外，如果不停地重启动而每次都放弃进度，算法可能永远无法完全穷尽搜索空间，从而失去完备性，因此考虑随着时间推移逐渐增加重启间隔。