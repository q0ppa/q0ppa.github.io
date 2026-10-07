# A Machine Program for Theorem-Proving
<p subt>Davis <em>et al.</em> (1962), doi:10.1145/368273.368557</p>

## DPLL

### SAT

**SAT** 问题：给定一个**命题公式 *propositional formula***，一般以 CNF 形式给出，是否存在一个取值可以满足此公式？

SAT 问题是一个 NP-Complete 的问题。然而由于我们要证明的命题一般满足工程或者数学上的一些结构，通过一些启发式的算法，其中相当一部分在工程上的效率会远优于 SAT 的最坏情况。

### Logics

- **literal** 是一个可以判定真假的陈述 $x$ 或其否定 $\neg x$。SAT 求解的 context 下，一般认为 polarity 不同的同一变量（即 $x$ 和 $\neg x$）是**不同的 literal**。
- **CNF clause** 是由一系列 literal 通过 $\lor$ 连接得到的，clause 成立当且仅当**任一 literal 成立**。
- **CNF** 是由一系列 clause 通过 $\land$ 连接得到的，CNF 成立当且仅当**所有 clause 成立**。

若一个 clause 只有一个 literal，那么它是一个 **unit**。**一旦 unit 为假，CNF 即不成立**。因此：
- 我们证明 CNF 成立时，如果 CNF 包含 unit $x$，则 $x$ **必然为真**。因此可以从所有 clause 中去掉 literal $\neg x$，这个过程被称为 **Boolean Constraint Propagation**。BCP 是 **cascading** 的，每次 BCP 都可能产生新的 unit。

### DPLL Algorithm

**DPLL** 即 ***Davis-Putnam-Logemann-Loveland algorithm***。其基本工作方式为：

```c
DPLL(F, assignment):
    F := UNIT_PROPAGATE(F, assignment)
    if F contains empty clause: return UNSAT
    if F has no clauses: return SAT
    l := CHOOSE_LITERAL(F)
    if DPLL(F ∪ {l}, assignment) == SAT: return SAT
    return DPLL(F ∪ {¬l}, assignment)
```

每次 BCP 会**消除成立的 clause**（如当前 unit 为 $(x)$ 的话，就是任何包含 unit $x$ 的 clause），从其他 clause 并**去掉不成立的 literal**（$\neg x$）。当一个 clause 为空时，说明**其所有 literal 均为假，CNF 是 UNSAT 的**。

如果无法进行 BCP，即试探性地对未赋值的 literal 进行取值来制造 unit。注意原论文中具体的实现有所不同，给出的是一个逻辑上等价的相似但不相同的方案。

## Method

### Original Algorithm

论文的理论来源是 Davis 和 Putnam 的论文 *A computing procedure for quantification theory*，认为在某些方面优于 Grimore 的算法<span com>（*A proof method for quantification theory*）</span>。

算法包含两个部分：**QFL-Generator** 和 **Processor**。

#### General Idea

比如我们知道一个群论公理 $e \cdot x = x$，使用生成元和任意元素做群乘法，得到的是这个元素本身。这个公理可以被表达为 `P(⋅, e, x, x)`。如果我们只关注一种运算，可以省略运算符，表达为 `P(e, x, x)`。

同理，对于结合律 $(x \cdot y) \cdot z = w \Rightarrow x \cdot (y \cdot z) = w$，首先可以将推出关系 $p \Rightarrow q$ 转换为 $\neg p \lor q$，而 $(x \cdot y) \cdot z$ 可以通过 $u := x \cdot y$ 来中介。通过 De Morgan's Law，可以得到最终的形式 `~P(x, y, u) ∨ ~P(u, z, w) ∨ ~P(y, z, v) ∨ P(x, v, w)`。

将每个公理转化为这样的 clause $C_i$ 之后，如果 $\bigwedge C_i \land \neg P$ 有矛盾，即可证明命题 $P$。

#### Matrix

在上面的式子中，公理是蕴含了全称量词的，如 $e \cdot x = x$ 中，变量 $x$ 实际上适用的对象是 $\forall x$，结合律同理是 $\forall x, y, z, u, v, w$。而对于命题 $P(x)$，一般关心的是是否 $\exists x$ 使得 $P(x)$ 不成立。

对于全称量词 $\forall x$，我们可以填入任何我们想要的值（$x$ 是一个**自由变量**），QFL 会直接丢弃量词，而此变量将会在后续被 QFL 使用一系列常量赋值；

对于存在量词 $\exists x$，**算法希望能找到一个具体的反例** $s$。因此，QFL 会将其设定为一个未知的定值 $s$，这个值不会变动。

去除量词之后，由剩下的 `P`、`~`、`&` 和 `∨` 构成的就是 **Matrix**，是一个命题逻辑**模板**。

### QFL-Generator

QFL 即 **Quantifier-Free Logic**，无量词逻辑。

QFL-Generator 会穷尽式地尝试所有可能的常量**元组**，从而得到一系列 QFL。

<div com>

**这个过程展开来讲就是**：
- 之前提到过，Matrix 消除了全称量词和存在量词。
- 对于每一个全称量词修饰的变量 $x_i$，我们穷尽式地尝试所有常量。对于一系列变量，就穷尽式地尝试所有可能的元组。
- Herbrand 定理已经证明**一阶逻辑的不可满足性是可半判定的**。
- 这样一来，如果原命题确实是永真的且可以通过转换为一阶逻辑命题来证明（即公理集合 $\land \neg P$ 是 UNSAT 的），那么在资源无限的情况下，**一定能找到导致矛盾的元组**。

</div>

常量有三类：
- **初始常量**，公理中自带的常量，如群论公理中的单位元 $e$；
- **Skolem 常量**，为了消除 $\exists$ 量词引入的常量 $s_i$；
- **函数项**，如公理中定义了求左逆运算 $I(x)$，那么所有常量的逆如 $I(e), I(s), \dots$ 在第一次被发现时会被加入到常量列表。函数项是在每次代入的过程中被**动态发现**的。

<blockquote info>

我们可以引入领域知识来消除掉冗余函数项，如 $I(I(x)) = x$ 的情况下，常量 $I(I(x))$ 应当被消除。不过这篇论文没有涉及这一点。
</blockquote>

QFL-Generator 会用一个**自然数编号**（其**被发现的顺序**）来代替常量。

#### However...

<div com>

一个 intuitive 是：**对于绝大部分有意义的数学定理，其证明所需的关键 QFL，只对应整个无穷常量搜索空间中一个或比例极其稀少的具有高度特定结构的元组**。
</div>

QFL-Generator 的搜索思路是通过元组的**范数**来决定搜索顺序，范数 $N$ 的定义为所有元素之和，即**总编号之和**。

这样一来，编号取决于出现顺序也就是输入数据的顺序，可以发现**系统对于输入格式是极其依赖的**。即便对同一个极其初等的命题，其证明效率也很容易出现数量级的差距。

#### 小结

同一个问题的任何微小扰动，都会导致所需资源呈组合爆炸式增长。如果要解决这一问题，**需要抛弃盲目枚举，找到一种方法，能够识别并排除掉与证明无关的“不相关”的实例化**。

### Processor

有 unit clause 的情况下，检测不一致性的处理流程见上。

#### Rule for Eliminating Atomic Formulas

**当没有 unit clause 的时候，DPLL 使用这个方法来制造 unit clause**。

这个规则将公式 $F$ 重写为 $(A \lor p) \And (B \lor \neg p) \And R$ 的形式：
- 从所有含 literal $p$ 的 clause 中提取公因子 $p$，剩余的部分为 $A$；对 $\neg p$ 同理提取 $B$，剩下的无关部分即为 $R$。
- 那么，$F \Leftrightarrow (A \lor B) \And R$，消除了 $p$

由于 $A$ 和 $B$ 都是 CNF，如果用 $\lor$ 连接，为了转换为 CNF 会产生巨量的字句。因此实践上应该逐一 check $A \And R$ 和 $B \And R$ 的成立性。

<div com>

#### Proof.

$(a_1 \land a_2) \lor (b_1 \land b_2) \Leftrightarrow (a_1 \lor b_1) \land (a_1 \lor b_2) \land (a_2 \lor b_1) \land (a_2 \lor b_2)$

若要将 DNF $A \lor B$ 转换为 CNF，可以用这个直观的思路：
- 对 $A$ 中的 clause $a_i$，若 $a_i$ 不成立，则 $A$ 不成立。
- 当 $A \lor B$ 为真，$\neg A \to B$，需要所有 $b_i$ 均成立。
- CNF clause 是 $\bigvee x_i$，所以 $a_i \lor b_j$ 是一个合法的 CNF clause。
- 最终得到的是 $A$ 对 $B$ 的分配乘法，共 $\|A\| \cdot \|B\|$ 项。

</div>