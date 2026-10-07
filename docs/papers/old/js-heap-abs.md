# JavaScript Pointer Analysis with Adaptive Heap Abstraction
<p subt>Wenyuan Xu, Anders Møller (2026), doi:10.1145/3797133</p>

## Abstract & Introduction

静态分析中，传统的表示对象方式是 **allocation-site abstraction**，也就是把代码中同一个位置创建的所有对象归为一个抽象对象来统一分析。当许多抽象对象事实上非常相似时，这种粗暴的区分反而会导致重复计算，浪费分析资源。本文提出**自适应堆抽象**技术，它在分析过程中动态地发现并合并相似的抽象对象，从而在**基本保持精度**的前提下，显著降低分析的复杂度。

### Intro

指针分析是所有分析带指针或对象程序的基石。在 JavaScript 里，函数也是对象，且没有静态类型信息。这意味着要知道一个 `a.f()` 调用执行了哪个函数（即构建**调用图**），或数据在函数间如何流动（**过程间数据流**），都必须依赖指针分析。

现实中的应用规模巨大，如何兼顾精度和可扩展性是一个难题。

#### 既有方法

**基于 allocation site** 和**基于 field** 是两种常见的抽象策略，后者把堆上所有对象当成一个整体，只通过属性名来区分不同数据。这虽然很快，但精度损失通常大到无法接受。**Context Sensitivity** 能够提升精度，但性能明显降低。另外，**类型抽象 (type abstraction)** 显然无法运用于动态类型的 JS。

Hardekopf 和 Lin 发现，即使对象来自不同分配点，如果它们的 pts 完全相同，即满足**位置等价 (location equivalence)**，那么区分它们就是冗余的。他们的 LE 技术可以识别并合并这类对象。但 LE 是为 C 设计的预分析，不适合 JavaScript。JS 的间接调用使得这种严格的等价关系很难成立，导致 LE 找不到多少可以合并的对象。

#### In this work

本文借鉴了 widening 的思想，提出了一种扩展自**波传播算法**的自适应堆抽象技术，且其和 LE 的预分析不同，可以通过一套启发式的规则**在线**地识别可合并的对象。在 SOTA 的 JS 分析框架上，在69个困难的真实项目中实现了平均 $2.03 \times$，最高 $17 \times$ 的加速，且 call edge 数量只增加 2.28%，**几乎不损失精度**。

## Method

### Motivating Example

```js
webidl.dictionaryConverter = function (converters) {
  return (dictionary) => {
    let dict = {}
    for (const opt of converters) {
      const { key, converter } = opt
      let value = dictionary[key]
      value = converter(value)
      if (opt.allowed && !opt.allowed.includes(value)) {
        throw Exception(/*...*/)
      }
      dict[key] = value
    }
    return dict;
  }
}
webidl.converters.RequestInit = webidl.dictionaryConverter([
  { // o18
    key: 'cache',
    converter: webidl.converters.DOMString,
    allowed: requestCache
  },
  { // o23
    key: 'referrerPolicy',
    converter: webidl.converters.DOMString,
    allowed: referrerPolicy
  },
  { // o28
    key: 'mode',
    converter: webidl.converters.DOMString
  }
]);
```

这段代码来自 `undici`，经过了一定的简化。`dictionaryConverter()` 接收一个数组并读取每一个元素的属性进行处理。以 alloc site 为抽象粒度的话，会得到 `o18`，`o23` 和 `o28` 三个对象。然而事实上，**分析器没有任何必要去区分这三个抽象对象**。区分它们只会导致分析器进行大量重复的计算。

例如，它们中每一个的 `.key` field 都会流入函数的 `key` 变量，`.converter` field 都会流入函数的 `converter` 变量。那么如果将它们合并为一个对象 `o`，`o.key` 和 `o.converter` 分别流入 `key` 和 `converter` 的话**没有损失任何精度**，同时指向边的数量还减少了4条。

考虑到在原 `undici` 中有**50个**而不是3个对象，每个对象的 field 是7个而不是3个，合并带来的复杂度变化是巨大的。

### Light-Weight JS

为了聚焦核心，此处定义一个只包含对象分配、函数定义、赋值、返回、属性读写、函数调用等关键操作的轻量 JavaScript。因为本文处理的指针分析是 Flow-Insensitive 的，所以可以省略控制流结构。

<blockquote info>

这是为了讲解的方便，后面评估时支持的是完整的 JS。
</blockquote>

对于其支持的操作，可以列出分析表如下：

| **Type** | **Statement** | **Constraint Rule** |
|:-:|:-:|:-:|
| Object Alloc | $x = \{\}_i$ | $o_i \in \mathrm{pt}(x)$ |
| Function Definition | $x = p \Rightarrow_i \{ \dots \}$ | $f_i \in \mathrm{pt}(x)$ |
| Assignment | $x = y$ | $\mathrm{pt}(y) \subseteq \mathrm{pt}(x)$ |
| Property Read | $x = y.f$ | $\displaystyle \frac{t_i \in \mathrm{pt}(y)}{\mathrm{pt}(t_i.f) \subseteq \mathrm{pt}(x)}$ |
| Property Write | $x.f = y$ | $\displaystyle \frac{t_i \in \mathrm{pt}(x)}{\mathrm{pt}(y) \subseteq \mathrm{pt}(t_i.f)}$ |
| Function Call | $x = y(z)$ | $\displaystyle \frac{f_i \in \mathrm{pt}(y)}{\mathrm{pt}(z) \subseteq \mathrm{pt}(param_i)} \\ \mathrm{pt}(ret_i) \subseteq \mathrm{pt}(x)$ |

### Wave Propagation Algorithm

可以使用一种简化的 **Pereira-Berlin 波传播算法**来实现上述规则，算法维护 pt 和 G。G 中的每一条边是一个子集关系 $n \to n': \mathrm{pt}(n) \subseteq \mathrm{pt}(n')$。

- **Propagate**：根据 G 中的边传播 pts，如 $y \to x, o_i \in \mathrm{pt}(y) \Rightarrow o_i \in \mathrm{pt}(x)$。
- **AddEdges**：实例化约束，如 $x = y.f$ 中若出现了新的 $t_i \in \mathrm{pt}(y)$，则加入新的 $t_i.f \to x$ 的边。

**抵达不动点时，算法停止**。

本文提出的优化技术和这一算法的常见工程优化是兼容的，可以叠加收益。

### Adaptive Heap Abstraction

在**每一轮迭代的开头**，可以增加一个 check：如果一个**变量的 pts 大小超过某个阈值**，那么它就变得过于不精确，以至于需要合并了。<span com>Intuitive：如果一个变量的 pts 很大，说明它**指向了很多对象**，而合并可以**减少对象的数量**。</span>

合并对象时，必须逐属性 (field) 合并，以保证分析的一致性。算法维护两个状态：$A$ 存放待合并变量，$B$ 存放执行过合并的变量防止重复处理。

<blockquote info>

如果反复合并，每次都要重新计算和分组，而随着分析的进行，很多对象已经被合并过，新加入的对象很容易分组失败，白白浪费计算资源。
</blockquote>

此外需要一个 $\mathrm{Rep}(x)$：若 `o2` 被合并到 `o1`，那么 `Rep(o2)` 返回 `o1`，也就是经典的 **representative mapping**。

属性读写生成新的边时使用 `Rep(t)` 重定向，从而减少新生成的边的数量。

此外，对函数对象会有特殊处理：采取保守的策略，直接传播其本身而不合并，这是为了**保护调用图的精度**。

### Merge

合并算法会计算 `pt(v)` 中所有 token 的 **signature**，把签名相同的 token 归为一组来判断相似性，并把组内其他所有 token 重定向到其中一个上，同步更新它们关联的属性变量。

#### Signature?

signature 是一种启发式标准，由以下内容组成：

$$\mathit{Sig}(t) = \lang \mathit{kind, module, name, params, prop} \rang$$

- **kind** 是 token 类型，包括 Object，Function，Array，Class，以及其他不太重要的类型；
- **module** 是 token 被定义的模块 (i.e., file)
- **name** 是 token 的函数名，当且仅当 $t$ 是一个函数
- **params** 是 token 的参数个数，当且仅当 $t$ 是一个函数
- **prop** 是 $\mathit{Props}(t)$ 的哈希值，即分析到目前为止发现的在该对象上被访问的属性名集合

其中只有 prop 是一个相对昂贵的字段，其他的则相对容易计算。

<div com>

这里 name 和 param 的设计看起来第一时间有点迷惑，想了下应该不是为了合并任何对象，而是用来**保证函数对象不会被合并**。二者都加入 signature 的情况下，基本可以让每个函数保持隔离。
</div>

## Evaluation

<blockquote info>

An artifact containing the implementation
and all experimental data is available at https://zenodo.org/records/19554781.
</blockquote>

本算法在 **Jelly** 这一 SOTA JS 分析框架上实现。很多其他 JS 分析工具，如 ODGen、FAST、Graph.js，由于其忽略了很多 JS 语言特性而使得其分析变得 **unsound**，因此评估过程没有使用它们。

**实验的四个考查点**：
- RQ1. 对真实程序的加速效果
- RQ2. 精度损失的程度
- RQ3. 不同参数和设计选择的影响
- RQ4. 和 LE 进行对比

### Dataset & Metrics

数据集使用从 GitHub 和 npm 上选取最有代表性的热门项目，并排除了 baseline 能在3分钟内完成的简单程序，以及 baseline 因为 TLE / OOM 失败的程序（无法进行比较），最终得到96个**具有挑战性但尚能分析的程序**。

除了总运行时间外，使用了 pts 大小和 G 的边数来印证性能；精度则使用**调用图边数**、**单态 (monomorphic) 调用点数**和**多态调用点数**来衡量。

单态调用点即**调用点只有一个目标函数**，此类调用点占比越高说明精度越高。对于 sound 的分析，call graph 是不会缺边的，则 **call graph 越小说明精度越高**。

### RQ1. 性能

对于 baseline 只需要3-5分钟的 smaller cases 收益有限甚至有轻微的负收益。随着程序规模增长，新方法的曲线则平缓很多，说明提升了分析的可扩展性，有潜力处理比当前基准更大的程序。

此外，对于成功 profile 了内存占用的47个 case，新方法的**内存消耗平均降低了一半** (8.84 GB → 4.43 GB)，因为合并操作直接减少了需要存储和追踪的抽象对象和变量的数量，这部分收益远超新增数据结构的开销。

总的来说，本文方法取得了平均 $2.03 \times$，79% 案例 $1.3 \times$ 以上的 speedup，且69个 baseline 无法完成的额外程序现在能够被成功分析了，说明其**对 scalability 的提升是巨大的**。

### RQ2. 精度

大多数案例的调用图大小增幅不到 1%，单态调用点数降幅不到 0.1%。有超过20个案例的调用图未变化。

三个指标的平均变化为 +2.28%，+0.05% 和 +1.33%。

对于两个精度损失较大的案例，`metroui` 虽然 call edge 增加明显 (491,135 → 587,737)，但单态/多态点数变化相对不大且性能提升为 $1.4 \times$。`husky` 的精度损失源于合并了具有 `getter/setter` 和不具有的对象，未来工作中可能通过 `getter/setter` 信息改变 signature，此外 speedup 高达 $2.96 \times$。

### RQ3

若阈值 $M$ 过低，会导致 premature merge，此时签名信息还不完备，可能合并了错误对象，且浪费了仅有一次的合并机会。过高则机会出现时大量冗余计算已经发生，优化效果大打折扣。

| **Threshold M** | 10 | 30 | 50 | 70 | 90 |
|:-:|:-:|:-:|:-:|:-:|:-:|
| **Successful cases** | 86 | 95 | 96 | 96 | 87 |

由于 M = 30 和 70 的速度稍慢，认为 M = 50 的 default 是合理的。

此外，签名组件中最重要的是 `prop`，移除它导致17个程序分析失败；函数信息有其价值，而模块信息移除后影响最小。

最后，允许多次合并会导致性能下降和精度损失。<span com>这里没展开讲数据，摆了</span>

### RQ4

LE 是一种严格等价方法，两个对象在所有包含它们的指向集合中都同时出现，而本文只要求它们在某个足够大的指向集合中同时出现，更加宽松且是条件触发的。

由于 LE 是为 C 设计的优化，团队付出了大量工程努力来尽可能公平地对比 LE 和本文的方法。最终得到的结果是：LE 在 Javasript 上的平均加速仅 2%，且找到的等价对象数量大约只有本文方法的 1/30。

得到结论：**LE 这种为静态语言设计的、追求严格等价的方法并不适合 JavaScript。**