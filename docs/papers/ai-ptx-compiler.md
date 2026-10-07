# AI as a Compiler: Compiling Triton kernels without the Triton compiler
<p subt>Costa <em>et al.</em> (2026), doi:10.48550/arXiv.2609.36800</p>

## Abstract & Introduction

现代 GPU 编译器依赖于多层中间表示和手写的优化 pass。这种架构的问题是：每当硬件架构演进——比如 NVIDIA 从 Ada 到 Hopper 再到 Blackwell——编译器工程师就需要手动扩展 IR、添加新的指令映射、验证新的优化 pass。

一个 Triton kernel 从 Python 源码到 PTX 需要经过五个阶段：
- **TTIR** (Triton IR)：硬件无关的高层 IR，捕获算法的数学语义
- **TTGIR** (Triton-GPU IR)：引入 GPU 特定的概念，如线程块划分、tile 策略
- **MLIR dialects**：通用的多级 IR，执行 tile 调度和内存合并优化
- **LLVM IR**：硬件无关的通用 IR，执行公共子表达式消除等优化
- **PTX/SASS**：厂商特定的汇编语言

能否用 LLM 直接替代整个优化和 lowering 管道？ 给定一个已经编译好的 Triton kernel（编译时参数、启动配置、目标 GPU 都已固定），让一个 LLM agent 直接生成 PTX 代码，完全绕过 Triton 的 TTIR → TTGIR → MLIR → LLVM IR → PTX 链路。

#### Why is this possible?

首先，NVIDIA 的 PTX ISA 文档是公开的，GitHub 上有大量手写 PTX 的 kernel 实现。一个足够大的语言模型在训练中见过这些材料，它有能力生成语法正确、语义合理的 PTX 代码。

然后，LLM 不需要一次写出完美的 PTX；本文的方法是让模型多次采样，然后用验证器筛选出正确的结果；让评估环境 TCENV 进行验证。

<div info>

LLM不需要第一次就产生最优解，它只需要在「在被验证通过的正确程序中产生足够多的高质量候选」这个意义上足够好。
</div>

## Method

### TCENV

**TCENV** 即 **Triton Compiler Environment** 是一个受控的评估环境，运行 **TAIC (Triton AI Compiler)**。TCENV 暴露一个字典，包括 Triton kernel、它的超参数、执行元数据，以及一个 PTX 模板。编译时常量、grid 维度、每块的线程数、目标 GPU 架构都作为固定输入提供给 TAIC。这样一来，TAIC 可以专注于 lowering 这个核心问题，而不需要同时解决配置推断。

每个 Triton 参考实现都遵循官方教程的最佳实践，并且在 TCENV 暴露参考 kernel 之前，会在目标 GPU 上进行 autotune 并使用调优后的配置。此外，论文还做了额外的优化：重写 kernel 以获得更快实现、在评估维度保证不越界时移除边界 mask。Baseline kernel 不使用实验性 Triton 特性或手写内联汇编。

TCENV 提供组装、启动、验证和 profiling 生成 PTX 所需的所有基础设施。它通过 NVIDIA 的标准执行路径运行，意味着生成的 PTX 和 Triton 编译器生成的 PTX 共享同一个执行环境。

### Recursive Optimization Loop

TAIC 首先产生一个初始的 PTX 实现。TCENV 将其组装、sanitize、检查数值正确性并 benchmark。

TAIC 收到反馈后，诊断当前实现的主导瓶颈，然后制定一个优化计划，i.e. 局部的指令级修改，全局的线程映射改变、数据移动重组或同步策略调整。子代理独立地将这个计划实现为多个候选补丁，每个子代理负责实现计划的一个变体，只有通过**成功组装**、**通过安全性和正确性门控**、**改善测量目标**三个条件才能进入下一轮迭代。

最好的实现版本及其反馈被发回到 TAIC，循环重复直到预算耗尽。

## Eval

论文在三种 GPU 上评估了这套系统：L40S (Ada)、H100 (Hopper)、B200 (Blackwell)。使用的编译器 LLM 是 GPT-6 Astra。论文比较了从 GPT-5.4 到 GPT-6 的多款模型，只有 GPT-6 Astra 达到与 Triton 持平的性能。

在十二个常见 kernel 上，AI lowering 的结果高度依赖于算子类型。Sigmoid、ReLU、SiLU、SwiGLU 这些 elementwise 操作，生成的 PTX 在约1%以内接近 Triton。RMSNorm 最多提升4%。

在更复杂的 kernel 上，AI lowering 展现出了显著优势。BitDelta（两个变体）达到了3.34倍和2.51倍的加速，FlashSinkhorn 达到了1.55倍，SageAttention 达到了1.41倍，FlashAttention 达到了1.37倍。内存受限和递归 workload 接近持平，比如 Forgetting Attention 是1.01倍，Lion 是1.00倍，Dion 是0.97倍。

最大的性能收益来自 Triton lowering 管道结构性无法表达的优化。

### 语义理解测试

论文试图验证 TAIC 确实在理解源语义，而不是依赖训练数据中见过的实现：

- 随机生成约150行的 kernel，不实现任何可识别的算法，操作整数以避免浮点差异，涵盖广泛的 Triton 特性。TAIC 对每一个都产生了正确的 PTX。

- 引入误导性线索。一个矩阵乘法但累积改为 `c[i,j] = −a[i,k]·b[k,j]`，一个 FlashAttention 变体但 `qk_scale` 加了1.4426950408889634，一个名为 ReLU 但注释要求 GELU 的 kernel。在所有三种情况下，模型都遵循实际实现而非名称、注释或算法结构。

- 当 Triton 源码要求 IEEE-754 语义时，生成的 PTX 避免使用 Tensor Core 操作。这表明模型捕获了源码中的语义约束。

### Validation

因为 GPU 的执行涉及大量的并发和非确定性（线程之间的竞态、内存序、同步原语的行为），一个 kernel 可能在测试用例上都正确，但在某些罕见的交错执行下出错。

论文使用 Volta 作为形式验证工具。Volta 是一个 PTX 等价性检查器，它对 CTA 中每个线程进行符号执行，检查数据竞争、死锁和输出表达式。它作为黑盒等价性检查器运作，不需要知道优化过程的信息，只从优化程序对应的汇编验证正确性。

一个问题在于，Volta 原版只支持 Hopper 之前的指令，而 AI lowering 生成的 PTX 使用了超过100种 PTX 指令变体，这些指令不出现在 Triton 编译器的原始输出中。将 AI lowering 限制在验证器支持的子集会完全消除其性能优势。扩展 Volta 使其支持这些指令极其困难，且会引入额外的不可靠性风险。

此外，当启用 Volta 进行验证时，GPU Kernel 的性能显著下降，部分 kernel 变得几乎无法使用 (i.e. $1.03 \times \to 0.24 \times$ speedup)，这说明能带来性能收益的特性，恰恰是验证器尚未支持的特性。

## Discussion

#### 与传统编译器对比

传统编译器工程的核心假设是：编译器工程师可以形式化或半形式化地定义每一层 IR 的语义，然后为每个优化 pass 证明它保持语义，或者至少通过大量测试保证正确性。其后端的负担来自多层 IR。每一层 IR 都需要维护语义、变换和 lowering 路径。

AI lowering 把编译问题转化为在 PTX 程序空间中的启发式搜索。它具有良好的适应性和端到端能力，问题在于它是一个概率性、高成本且依赖验证器的范式。

#### 生成-验证不对称性

验证比生成困难，对现代 GPU 代码的验证则尤其困难。LLM 可以自由地使用 tcgen05、TMA、mbarrier 等现代特性，但 Volta 要形式化这些特性的语义需要大量工作。

一个可能的解决方向是运行时验证，如用差分测试代替形式验证。但差分测试的覆盖是有限的，无法证明所有输入上的等价性。论文的立场是，在形式验证尚不可用的地方，随机差分测试是必要的 fallback，但**不能替代形式保证**。

#### 对硬件设计的影响

如果 AI lowering 成为标准实践，可能会改变硬件设计的方式。目前，硬件设计者需要考虑编译器是否能表达新的硬件特性。如果 AI lowering 能直接利用新特性而无需编译器支持，硬件设计者可以更大胆地引入新的指令和架构。

但这也带来了新的风险：硬件特性可能变得 **LLM-only**：只有 LLM 生成的代码能高效使用，人类工程师难以理解和调试。
