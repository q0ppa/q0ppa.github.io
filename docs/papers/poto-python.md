# PoTo: A Hybrid Andersen’s Points-to Analysis for Python
<p subt>Rak-amnouykit <em>et al.</em> (ECOOP 2025), doi:10.48550/arXiv.2409.03918</p>

## Abstract & Introduction

虽然在 C、C++、Java、Javascript 等语言中，指针分析已被广泛研究，但对于同样非常流行的 Python，这方面的研究却出人意料地少。在这些语言之中，**Python 的现代应用方式越来越像 Java**，作为一种通用语言来构建大型库和应用，大量使用类和对象。

这里 JavaScript 和 Python 虽同为动态语言，但面临的主要挑战不同，Javascript 面对的事件驱动、DOM 交互和对象属性的动态性不是 Python 面临的主要问题。大致上，PoTo 的本质是**从 Python 中提取出一个类似 Java 的核心子集，然后使用 Java 分析的方法进行分析**。

<div com>

这里具体来说，JS 开发者经常把一个对象当哈希表来使用，在运行时动态地添加、删除或修改属性名。Python 虽然也完全支持运行时动态增删属性，但似乎在主流、大型的 Python 项目中不是惯用范式，而相反它们更倾向于定义明确的类，使得对象的形态在大部分代码中是相对静态的。
</div>

随着 Python 越来越被用于大型复杂程序，对静态分析的需求也日益增长。PoTo 将传统的静态指针分析与在 Python 解释器中对外部库调用进行的具体求值相结合。当静态分析遇到一个调用，PoTo 会尝试在 Python 解释器里执行这个调用，把得到的具体信息反馈回静态分析中。这极大地解决了外部库分析困难的问题。

### Andersen

本文使用 Flow-Insensitive，Context-Insensitive 的 Andersen 算法，它是基于包含约束的分析，最终得到一张 **Points-to Graph**，其节点包括变量和堆对象（包括函数）。Python 的 pts graph 有两种边，分别是指向边 $x \to o$ 和对象字段指向边 $o_1 \overset f \to o_2$，后者表示 `o1.f = o2` 这一关系。

### Challenges

Python 静态分析面临一些较大的挑战，如**语法和模块系统复杂**，**动态语言特性**和**海量外部库**。

Python 的语法糖和灵活的动态导入机制使得将源码翻译为简单的中间表示很困难。例如 `a[index_expr]` 下标访问，内部是通过调用 `a.__getitem__()` 实现的，理解为元素访问在静态分析上是不健全的，但把它当作一个虚拟方法调用来处理又相当复杂。

此外，Python 的类型、函数、类乃至对象字段都可以在运行时动态改变。Python 生态丰富，但很多库的源码不可见，或其接口缺乏类型标注，甚至部分是用 C 语言实现的，对 Python 来说是黑盒。这让传统的全程序静态分析无从下手。

### Solutions

#### Principled Translation

为了进行 Andersen 分析，首先需要将复杂的 Python 源码转换为一种简单的中间表示，PoTo 选择了三地址码。**对 Python 特性的一个核心子集，PoTo 会按照其语义精确翻译**。对另一部分过于复杂或动态的特性，PoTo 会使用一种默认解释来**近似**。这个解释可能是过度近似的，也可能是不健全的。

#### Hybridization

对外部调用如 `np.array(my_list)`，可以在分析过程中真的调用 Python 解释器去执行，确认它返回了一个什么类型的对象。**具体求值得到的具体对象**会像通过静态分析得到的“抽象对象”一样，在 PtG 中被传播和使用。

### Eval

#### 具体类型推断

在 PoTo 生成的指针图上查询变量 `x` 的指向集，并认为 `x` 的类型是其中所有类型的并集。
- 对比基于规则的 baseline **Pytype**，性能基本相当且可扩展性更好。
- 对比基于深度学习的 **DLInfer**，性能大大优于 DLInfer。

#### 调用图构建

如果出现一条调用指令 `y()`，且 `y` 的指向集里有一个函数对象，那么就在调用点和这个函数之间连上一条调用图的边。
- 对比 **PyCG**，PoToCG 构建的调用图在完整性和精确性上都优于 PyCG，并且扩展性更好。

## Method

### Overview

PoTo 主要分为三个阶段：
- **Principled Translation**，把 Python AST 翻译为三地址码，即
  - `x = object` new assignment
  - `x = y` copy propagation
  - `x.f = y` field write
  - `x = y.f` field read
  - `x = y(z)` closure call
- **Analysis**，构建出指针图；
  - 从 `main` 开始生成三地址码并求解，每次发现新的函数调用时这个函数就会变得可达。分析器会立即暂停当前的求解，为这个新发现的函数生成三地址码，将新生成的约束加入约束系统并继续求解。
  - 也就是一种**可达性/发现式分析**。
- **Client Analysis**，如上面提到的类型推断和调用图构建。

#### Phase 1

PoTo 在生成三地址码时，会对每一个表达式都先尝试进行具体求值。这里的执行环境是其所在的导入环境。如果表达式能成功求出一个具体的 Python 对象，PoTo 会将其作为常量保留。例如，`re.compile(r"...")` 会直接作为一个 regex 对象被保留下来。

如果表达式求值失败，那么 PoTo 就会退回到传统的递归翻译方式，生成对应的三地址码。

因为是指针分析是流不敏感的，所以在翻译时完全忽略控制流，整个函数体被拉平成一串顺序执行的三地址码。`_ret` 后缀的变量被用来统一表示函数的返回值。

#### Phase 2

在 PoTo 的指针图中，所有的节点对象分为两大类：
- **抽象对象**，主要包括三类。
  - **meta-class**，类定义本身，如 `class MyClass`；
  - **meta-func**，函数定义或者说 **closure object**；
  - **data**，类的实例。
- **具体对象**，Python 具体运行时会产生的实例。

分析器会维护一个 **abstract reference environment**，大致可以理解为当前正在分析的 package 的符号表。

这样一来，对于 `x = y.f` 或者 `x = y.foo()` 的字段访问或成员函数调用，分析其可以检查 `y` 是否是一个具体变量，是则具体求值，否则走传统的静态分析流程查找 `foo` 的定义。

**对比 Pytype**：Pytype 这样的纯静态工具因为无法穿透外部库，只能给出一个最宽泛的 `Any` 类型，这几乎不提供任何信息。

### Minimal Python Syntax

#### Expression

$\begin{aligned}
e ::= &c \mid x \mid e.x \mid e[e] \mid e(e, ..., e) \\
& \mid [e, ..., e] \mid \{e: e, ..., e:e\} \mid (e, ..., e) \\
& \mid [e\ \mathtt{for}\ x, ..., x\ \mathtt{in}\ e\ \mathtt{if}\ e] \\
& \mid \{e:e\ \mathtt{for}\ x, ..., x\ \mathtt{in}\ e\ \mathtt{if}\ e\} \\
& \mid e\ op\ e \mid e\ cop\ e \\
& \mid Other(e, ..., e)
\end{aligned}$

<div com center>

const | Name | Attribute | Subscript | Call  
| List | Dictionary | Tuple  
| ListComp  
| DictComp  
| BinOp | Compare
</div>

#### Statement

$\begin{aligned}
s ::=& \mathtt{pass} \mid x=e \mid e.x=e \mid e[e]=e \\
&\mid s ; s \mid \mathtt{for}\ e\ \mathtt{in}\ e:s \\
&\mid \mathtt{def}\ f(x, ..., x): s;\ \mathtt{return}\ e \\
&\mid \mathtt{class}\ C(e, ..., e):s \\
& \mid Other(s, ..., s)
\end{aligned}$

<div com center>

Pass | Assign  
| Suite | For  
| FunctionDef | Return  
| ClassDef
</div>

#### Import & Module

$\begin{aligned}
i ::=& \mathtt{import}\ p\ (\mathtt{as}\ x)? \\
&\mid \mathtt{from}\ p\ \mathtt{import}\ x\ (\mathtt{as}\ x)? \\
&\mid i;i
\end{aligned}$

$m ::= i ; s$

### 三地址码

翻译过程有三个环境，除了**局部作用域** $\Gamma$ 和**全局作用域** $\Gamma_0$，为了具体求值还需要**外部环境** $\Gamma_{ext}$。PoTo 将 `import` 分为内部 import 和外部 import，所有外部导入的模块构成 $\Gamma_{ext}$。当 PoTo 需要具体求一个外部库的调用时，在 $\Gamma_{ext}$ 中完成。

#### 解释函数

$$\mathscr{G}(s, \Gamma) \to (\Gamma', S)$$

**语句解释**接收语句 $s$ 和当前环境，更新当前环境（因为语句可能引入新的变量）和生成的序列 $S$。

`x = y.f.g` 被通过 AST 分解为 `t4 = t1.f, t3 = t4.g, t2 = t3`。

$$\mathscr{G}(e, \Gamma) \to (V, S)$$

**表达式解释**输入一个表达式和局部环境，输出代表其结果的分析变量集合 $V$ 和生成的三地址码序列 $S$。`y.f.g` 就返回临时变量 `t3` 作为 $V$ 的成员。

**对语句的解释是纯抽象的，而对表达式的解释是混合的**。

#### 函数环境

函数环境 $\Phi$ 是一个 map，其键为 AST 节点，值为翻译结果。一旦一个函数被翻译过，就可以直接从 $\Phi$ 中获取。

实质上也就是缓存。

### Algorithm

```py
# Initialize Γ₀
Γ₀ = []
Φ = {}
for (module M : s) in package under analysis
    for (class C(...) ...) in s
        Γ₀ ← [(M,C,t)] + Γ₀     # t is fresh
    for (def f(...) ...) in s
        Γ₀ ← [(M,f,t)] + Γ₀     # t is fresh
# Imports from p import x' as x are implicit assignments for x = ...
    for (M,x) in s
        Γ₀ ← [(M,x,t)] + Γ₀     # t is fresh
```

遍历整个包的所有模块，为所有顶层的类定义、函数定义和赋值分配一个全新的分析变量 `t`，并把它们的映射关系存入全局环境 $\Gamma_0$。

它假设**所有模块级的名字在包的任何角落都可见**，简化了 Python 模块间复杂引用关系的处理。这一步仅仅是**登记名字和分配变量**，等到可达的时候才会进行求解。

```py
# Next, compute class hierarchy H and MRO:
H ← C3(Γ₀)  # H maps ((class C(...) ...), f) to (def f(...) ...)
```

使用 C3 线性化算法来计算 Python 的方法解析顺序，$H$ 可以**根据类和函数名找到实际被调用的函数定义，用于处理面向对象多态**。

C3 是 Python 官方采用的方法解析顺序算法。使用 $H$ 虽然不精确（FI + CI），但效率高。

另外这一步为每个类定义创建了 meta-class 对象。

```py
# Interpret main and add to worklist:
Φ[(def main(..):s)] ← ℐ(s,∅)
W ← { ⟨def main(..):s⟩ }     # Entry point

# Interpret module initializers and add to worklist:
for (module M ...) in package under analysis
    Φ[(def M.module_init(...):s)] ← ℐ(s,∅)
    W ← { ⟨def M.module_init(...):s⟩ }     # Entry points
```

从 `main` 和所有模块的 initializer 开始，对这些 entry point 调用 $\mathscr{G}$ 生成三地址码并存入 $\Phi$，然后放入工作列表。

```py
# Solve constraints in reachable functions:
while W ≠ ∅
    (def f(...) ...) ← remove function from W
    for c in Φ[(def f(...):...)][1]
        W ← W + c.solve()
```

每次从工作列表取出一个函数，遍历其指令并求解约束，`c.solve()` 会返回一个受影响的函数集合。

对于普通赋值 `t1 = t2`，如果 `t1` 的指向集变了，其所在的函数需要重新求解。对于字段存储 `t1.f = t2`，则不同。<span com>在 PoTo 中，`t1` 是一个局部变量，而 `t1.f` 中 `t1` 是一个指针，后者可能指向很多个不同的堆对象，理论上可以影响程序中任何读取同名字段的语句。</span>PoTo 会采取保守的做法，将所有函数加入工作列表。

### 翻译过程


#### 语句解释

局部变量会被分配唯一一个分析变量 `t`。对于先后给同一个变量赋不同值的代码 `x = 1; x = 2`，`x` 的分析变量 `t1` 的指向集会同时包含二者。

处理 `for` 循环时，循环被解构成一个赋值 `x = e` 并分析循环体 `s`，得到来自 `e` 的所有可能元素并全部使用。循环的迭代次数和终止条件在这种分析中是完全被忽略的。

函数会被认为是一个 meta-func 对象的赋值，而类定义在语句翻译阶段无效，因为所有模块级类定义在类层次分析阶段被统一处理了。**这保证了每个类的全局信息只被计算一次，而不会在每个函数里反复处理**。

函数闭包会被放在空环境中分析，认为这造成的精度下降在实践中是有限的。

对未解释的语句如 `if` 和 `with`，会直接简单地进入每个 substatement。

#### 表达式解释

对于简单变量首先在局部和全局作用域中查找，找不到再具体求值。例如对于内置函数 `len`，前两步都会失败，此时触发具体求值得到 `len` 这个内置函数对象。

<blockquote info>

这里每次遇到 `len` 的调用点，PoTo 都会创建新的实例。这会造成一些冗余，不过优化这一点非常简单。
</blockquote>

对于复杂表达式如 `a.b()`，PoTo 优先尝试在 $\Gamma_{ext}$ 具体求值，例如 `np.array(arg)`。这里因为 `arg` 是抽象变量所以会失败，此时会再次尝试子表达式，成功得到 `numpy.array` 这个具体的函数对象，最后退回抽象解释流程生成三地址码：函数对象 `t2 → numpy.array` 调用抽象参数 `t3 → arg`。

其他：
- 下标访问中 `[]` 被视为一个 field；
- 容器字面量拆解为创建空容器 + 逐个赋值；
- 未解释的表达式处理方法同样是递归下降。

#### `import` 导入

`import` 尤其是 `import as` 被建模为一种**全局赋值**，由此，**imported module 中的分析结果可以传播到 importer 中**。

如果导入模块，则模块内的名字会被转换后直接在全局环境 $\Gamma_0$ 查找。由于 $\Gamma_0$ 在分析开始时已经扫描了并登记了所有模块，模块层级访问可以直接命中。

<div com>

例如 `from A import B as C`，那么出现了全局赋值 `C = B`。如果 `B` 是一个模块，而当前代码中出现了 `C.func()` 调用，分析器会发现 `C = B` 并在 $\Gamma_0$ 搜索 `A.B.func`。
</div>

### 约束求解

前面提到，分析中会出现四种对象：**data**, **meta-func**, **meta-class**, **const**。最后一种是 non-abstract concrete value。

分析规则主要有下面五种：
- `x = object` new assignment
- `x = y` copy propagation
- `x.f = y` field write
- `x = y.f` field read
- `x = y(z)` closure call

前三条规则比较简单，这里主要讲后两个最复杂的规则。

#### Indirect Read

```py
solve for t₁ = t₂.f in ⟨def f′(...):...⟩ with Γ_ext:

for o ∈ Pt(t₂)
    case o of
        data, ⟨class C(...):...⟩ →
            ⟨def f(self,p):...⟩ ← H[(⟨class C(...):...⟩, f)]
            Pt(t₁) ← Pt(t₁) + {⟨meta-func,⟨def f(o,p):...⟩⟩}
        (meta-cls, ⟨class C(...):...⟩ →
            ⟨def f(self,p):...⟩ ← H[(⟨class C(...):...⟩, f)]
            Pt(t₁) ← Pt(t₁) + {⟨meta-func,⟨def f(self,p):...⟩⟩}
        const, ...) → Pt(t₁) ← Pt(t₁) + {eval(o,f,Γ_ext)}
    Pt(t₁) ← Pt(t₁) + Pt(o,f)    # when f is an object field, add its points-to set

return {⟨def f′(...):...⟩} if Pt(t₁) changed else {}
```

对 `t1 = t2.f`，

若 `t2` 是一个类 `C` 的**抽象对象**，分析器首先查询 $H$ 来找到 `C` 或者其父类定义的 field 或 method `f`，找到后创建一个闭包，其 `self` 绑定到 `t2` 指向的对象上，并将这个闭包加入 `t1` 的指向集。

若 `t2` 是一个 const，则 PoTo 直接 `eval(o, f, Γ_ext)` 得到结果并作为新的具体对象加入 `t1` 的指向集。

如果 `f` 单纯是一个 field，就直接传播。

#### Function Call

调用处理：
- **data** 可调用说明实现了 `__call__` 方法，在 $H$ 里查找之；
- **meta-class** 是构造函数调用，查找 `__init__` 方法并创建新的 data 作为接收者（`self`）；
- **meta-func** 有两种情况，普通函数和闭包。前者带有 `self` 参数，后者没有。

决定要调用的函数后，如果它尚未被翻译成三地址码，就会立即进行翻译。完成后，实参的指向集流给形参，返回值变量的指向集流给调用点的左侧变量。

特别地，如果调用的是一个具体对象，并且所有实参也恰好都是具体对象，那么分析器就会真的执行这个调用，并将得到的返回值作为新的具体对象。

## Evaluation

### Entry

PoTo 需要入口函数来开始分析。实验巧妙地利用了这些包自带的测试套件，因为好的测试会覆盖库中大量的公共 API。这提供了大量、多样且真实的入口点。

对于部分测试覆盖不够的包，作者手动编写了额外的入口函数来调用未触及的公开函数，以确保分析的覆盖率是评价分析能力本身。

### w/ Pytype

PoTo 和 Pytype 高度一致。Pytype 在一些细节处理上更完善，而 PoTo 的运行速度远快于 Pytype。

### w/ PyCG

PoToCG 是一个可达性分析，追求 precision；而 PyCG 是全量分析，追求 recall。具体的比较方法为先比较覆盖率，然后比较被 PoToCG 覆盖的函数中二者的质量。

作者审视了 `pygal` 等应用，发现其类层次结构中，基类包含了几乎所有功能，子类主要是增加一些配置用的数据字段。在这种情况下，作者猜想上下文/对象不敏感的 PoTo 可能不会损失太多精度，甚至可能更快，因为它不会为了区分不同上下文而进行大量重复计算。

> We consider PoTo a necessary baseline. Improved precision, possibly via context-sensitive, is a promising direction for future work in Python program analysis.

### Threats

PoTo 的分析起点严重依赖测试用例。测试质量差会导致分析覆盖率低。作者通过手动补充入口函数来部分缓解此问题。

另外，PoTo 从设计上就是 unsound 的，不可能作为一个 sound 的 baseline。