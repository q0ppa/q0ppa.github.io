# Rete: A fast algorithm for the many pattern/many object pattern match problem
<p subt>Charles L. Forgy (2003), doi:10.1016/0004-3702(82)90020-0</p>

## Abstract & Introduction

**Rete Match Algorithm** 是一种计算 a large collection of patterns to a large collection of objects 的高效算法，能够找到匹配每种 pattern 的所有对象。

**匹配是主导规则系统时间成本的环节**，很多系统超过 90% 的时间被用于进行匹配。Rete 极大程度优化了这一过程。

<div com>

### Production System

一个 **产生式系统 (Production System)** 是一种基于 **IF-THEN** 或者说**条件-动作规则**的知识推理框架，它是最早的专家系统的核心架构。

PS 主要由三部分组成：**Rule Base**，**Working Memory** 和 **Inference Engine**。
- **Rule Base 存储大量 IF-THEN 规则**，如 `IF body_temperature > 38℃ AND has_cough THEN suspect_flu`
- **Working Memory 存储当前已知的 facts**，如 `John: [body_temperature: 39℃, has_cough: true]`

系统不断扫描工作存储器中的事实，找出所有“条件满足”的规则，然后执行其中一条规则的动作（比如添加新事实或执行外部操作），循环往复，直到得出最终结论。

#### Conflict?

当推理引擎在工作存储器中匹配所有规则时，往往不止一条规则的条件被满足。此时就产生了**资源竞争**，也就是 **conflict**。这一组均处于待触发状态的规则构成了 **Conflict Set**。

为了继续执行，系统需要使用 **Conflict Resolution Strategy** 来消除冲突，如优先级、特异性、FIFO / LIFO，etc.

</div>

### OPS5

本文所讨论的方法主要基于 **OPS5** interpreters。一个 production system program 使用一系列 **productions**，这是一个无序的 IF-THEN 集合，其中 IF part 也称为 **LHS**，THEN part 称为 **RHS**。

OPS5 interpreter 需要循环下列三步。
- **Match**，对 LHS 求值，找到 working memory 中满足它的 fact；
- **Conflict resolution**，如果没有 production 有 satisfied LHS，暂停工作；
- **Act**，执行 RHS。

#### Syntax

**Element** 实际上就是一个字典，有一个名称和一些键值对，填充了 field name 和对应的具体值。

$$(\mathrm{Name}\ \uparrow attr_1\ \mathrm{value_1}\  \dots)$$

**Pattern** 的模板同 element，但 pattern 的 value 可以是具体值也可以是变量，变量用 $\lang \rang$ 括起。变量在首次被匹配时会被赋值，**同一 production 的其他同一变量必须匹配同一个值**。

$$(\mathrm{Same} \uparrow arg_1\ \lang X\rang\ \uparrow arg_2 \lang X\rang)$$

**Production** 的模板为 $(\mathrm{P\ Name}\ \{\mathrm{(LHS), \dots}\} \longrightarrow (\mathrm{RHS}))$，如

$$(\mathrm{P\ symplify}\\
(\mathrm{Goal}\ \uparrow Type\ \mathrm{Simplify}\ \uparrow Obj\ \lang X\rang)\\
(\mathrm{Expr}\ \uparrow Name\ \lang X\rang\ \uparrow Arg_1\ 0)\\
\longrightarrow (\mathrm{MODIFY}\ 2\ \uparrow Arg_1\ \mathrm{NIL})
$$



## Method

### Rete Concepts

Rete 匹配器的输出不是满足 production 的集合，而是一个 **conflict set**，a collection of **ordered pairs**

$$\lang \mathrm{Collection}, \text{list of matched elems}\rang$$

这个列表是有序的，每一对称为一个**实例化 (instantiation)**。一个 production 可以有多个实例化，例如 LHS 的每个模式匹配多个元素时组合数会很大。Rete 可以处理这个量级的数据，因为 ***it does not iterate over the sets***。

#### Avoid iterating over WM?

朴素的 interpreter 每轮进行逐模式逐元素比较，每轮全量重算，则成本为 $\mathrm{\Theta}(MN)$。如果把匹配结果作为可维护的状态，每个模式维护当前匹配它的元素列表，WM 变化时只做增量更新，那么有这样一些想法：
- 匹配粒度不是 pattern 而是 LHS，匹配粒度是 **partial match**。
- 算法接收元素**变化**而不是元素。在 WM 中一个元素被改变了（$A \to B$），会导致 $-A, +B$ 两次变化。

#### Avoid iterating over Production?

Rete 使用一个树形的 sorting network 来避免遍历每个 production。

元素有**元素内特征**和**元素间特征**，后者通过变量绑定实现。
- 对于每个 pattern，其元素内特征会被编译成一条线性链，每一个节点测试单个特征，不通过则丢弃。这个特征可以是一个常量比较（`attr >= 2`），也可以是一个含变量的表达式。
- 一个 production 分为多个 pattern，每次使用一个扇入为2的节点即 **two-input nodes** 来**合并两个 pattern，并检查元素间特征**。
- 在所有 pattern 被**逐级合并**<span com>（P1 + P2; (P1 + P2) + P3; etc.）</span>后，最终来到一个 terminal 节点，此时说明 production 匹配成功。

#### 2-input nodes

在上面的例子里，如果 Goal: SIMPLIFY 已经被设定完毕，但对应的 Expr 还没出现，我们希望能够暂存 Goal 的结果，一旦 Expr 出现就立刻认为 production 完成。顺着上面提到的网络，可以发现 **Goal 的结果会被阻塞在 two-input node**，因为不存在 Expr 所以无法合并。

这样看来，2-input node 有必要维护两个缓存：**左记忆和右记忆**。只要对应元素还存在于 WM，就不能将其从左记忆和右记忆删除。这样看来，其实 2-input node 是维护了一系列元素的索引。

#### tags

由于元素不只会被新增也会被删除，需要同步从 conflict set 移除实例化，那么单侧记忆之中也不应该存在对应的元素。

对于删除元素的更新，使用 `-` 进行标记，而新增则使用 `+`。根节点和 2-input 遇到 `-` 标记时会分别删除实例化和单侧记忆中的元素。

#### NOT

NOT pattern 表示**整个 WM 中不存在任何节点满足条件**。基础的 2-input node 无法处理这个逻辑，因此需要一种新的 2-input 来处理 NOT。

<blockquote box>

- 假设 production 的条件为 $A\ \mathrm{AND\ NOT}\ B$，那么整个 WM 中不能有任何 $B$ 满足条件。
- WM 中有一系列 candidate $A$。对于 $\mathrm{NOT}\ B$，直接找到所有能匹配 B 的节点 candidate $B$。
- 对于每一个 candidate $A_i$，维护一个 **counter**，即能和这个 $A_i$ 匹配的 candidate $B$ 的数量。若 counter 非零则不通过，为零则放行，得到一系列实例 $(A_i, B_1), \dots, (A_i, B_n)$。
</blockquote>

### Representing Network and Tokens

#### Token & Tag

**token** 即 **WME (Working Memory Element)** 构成的集合。例如计算 $A\ \mathrm{AND}\ B$ 时，能匹配 pattern $A$ 的中间结果 $\{\mathrm{WME_1}, \dots\}$ 就是一个 token。**tag** 描述了 token 的特性。

token 的表示使用栈，当需要构建一个 token 时，其 tag 会被压栈，然后按顺序将匹配到的 WME 也压栈。如果需要扩展一个 token，直接将其压入栈顶即可。

#### WME

WM 中的元素需要易于取值和测试。

为了快速取值，元素应该在一块连续内存上存储，下标在编译期间确定并嵌入节点代码，将属性作为某种 enum 翻译为常量，使得其一次内存引用即可取得任意属性值。

<span com>测试也就是检查属性是否满足某种性质，</span>为了服务于测试需要加入显式的类型位。

#### NETWORK

网络会被**线性化 (linearize)** 成指令序列。
- 根节点 **FORK** 是多后继的，其中一个被直接放在其后，而其他后继会被入栈。
- 2-way node 会 **MERGE** 多条路径，其中前一条指令可以直接获取到最晚完成的路径的结果，更早的结果会通过跳转来取得。

解释器有一个 **Node Stack (NS)**：
- FORK 会压入未来的路径地址，因此路径走到尽头时需要弹栈前往对应的地址。
- 2-input node 必须记录自己两侧记忆的状态并压栈。

<div com>

## Understanding Rete

<blockquote info>

我认为 Rete 充满对当今实践来说不必要的 trivial details（如对汇编的具体翻译方式），所以考虑从更高层概括地梳理一下 Rete。
</blockquote>

### Nodes

- **$\alpha$ 节点**会进行单个元素的测试，检查一个 WME 的特定字段是否满足条件（`arg1 == 0?`）；
- **$\beta$ 节点**只进行绑定校验，检查它们之间的变量绑定是否一致，如果不一致则不通过；
- **terminal** 报告完整的匹配，也就是 production 所有的实例化。

状态保存在 $\beta$ 的左右内存中，避免重复扫描。

### Tokens

Rete token 有两种 tag，`+` 和 `-`。token 无论 tag 如何，$\alpha$ 节点的操作都是一样的，即检查 WME 的单个字段。

到达 $\beta$ 节点时，`+` 会被存储到 token 的单侧记忆，生成新的 `+` token 传递到下游，直到在 terminal 生成新的实例化；而 `-` 会被从单侧记忆删除并撤销它参与的派生 token，并在 terminal 从 conflict set 中移除对应的实例化。

#### 增量更新

WME 出现 $A \to B$ 的改变时，会生成 $-A$，$+B$ 两个 token，并参与每一种模式的增量式检查。

在 $\alpha$ 的检查过程是显然的。当 token 到达 $\beta$ 时，会**影响当前侧的 memory**（见上），同时**对侧的每一个元素都会与当前 token 匹配**。如果匹配成功，就保存 beta 当前的**对侧遍历位置**，并向下传递这个匹配给后续的 beta。

### Node Stack

如果一个节点有多个下游分支，这发生在网络根，或者 $\alpha$ 在**公共子表达式被优化**的情况下。尚未探索的分支地址会被压入 NS 栈。

如果两个分支汇合于 $\beta$，这里的做法是

```
BRANCH 1
BETA
BRANCH 2
MERGE BETA
```

**MERGE** 是一个跳转操作。由此我们可以发现，程序的执行过程为：**BRANCH 1** → **BETA**（存入 left mem，right 为空，无检查）→ **BRANCH 2** → **BETA**（存入 right mem，检查）。在 BETA 处如果计算出了结果，就保存 BETA 当前的遍历位置，将 token 传给它的后继。

总的来说，这就是一个基于栈的 DAG 遍历过程。

</div>