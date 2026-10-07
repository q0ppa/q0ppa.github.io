# Harness as a Language: A Minimalist Agent Framework With Maximal Expressivity
<p subt>Li <em>et al.</em> (2026), doi:10.48550/arXiv.2609.26891
</p>

## Intuitive

<div info>

只要让 LLM 能像程序员一样操作自己的上下文和历史，并且能递归地调用自己，那么长期记忆和自我改进这些能力就可以从简单的提示中自然涌现出来，不需要专门去搭建复杂的记忆系统或自我改进系统。
</div>

现在大多数 LLM agent 都是围绕 **agent loop** 构建的，这是一个**调用工具 → 观察结果 → 决定下一步**的闭环控制。ReAct 让模型自由选择动作，CodeAct 让模型用代码来编排工具调用，RLM 进一步让模型把输入当作 Python 对象来递归操作。但有一类能力始终需要**专门的外部系统 (specialized harness)** 来实现，具体来说比如：
- **长期记忆**：需要 MemGPT/Letta 那样的分层记忆架构来检索过去的信息
- **持续自我改进**：需要 ACE 那样的“playbook”机制，让一个 meta-agent 在任务序列中不断优化 solver-agent 的 prompt 和工具。

如果 agent loop 本身足够有表达力，这些能力能不能仅靠 prompting 就涌现出来，不需要任何外部系统、工具或 harness 组件？作者构建了 JAZ 框架来验证这个假设。JAZ 只有一个 LLM-based 原语：`invoke`。

## Method

### `invoke`

`invoke` 是一个函数调用，可以接受任意命名参数。这些参数**不区分 prompt、tools 和 data**，而是一视同仁地作为字符串输入。

```py
invoke(
    task="Analyze bio data and produce plots.",
    df=df,
    web_search=web_search,
)
```

**每次调用 invoke，LLM 都会负责生成函数体**。与之相对地，在已有的 agent loop 范式中，函数实现一般是静态代码。这个生成过程分三步：
- 用输入构造 prompt `P`，`P` 是输入的紧凑字符串表示；
- LLM 返回代码 `C = π(LM(P))`，`π` 是解析器；
- 执行这个函数。

<div info>

这里的第二步看起来可能比较费解，但实际上大致是这么个过程：JAZ 选择 Python 作为宿主语言，解析器选用恒等函数 `π(x)=x`，所以 LLM 需要根据序列化后的参数 `P` 生成一段代码 `LM(P)`，这段代码**被在 Python REPL 中执行**。

函数体可以调用工具，操作 `df`，访问 `_history_`，递归调用 `invoke` (subagent)，可以 `return` 结束当前 invoke。

```py
print(web_search(task))

plots = []
for plot_type in ["PCA", "t-SNE"]:
    plot = invoke(
        task=f"Produce a {plot_type} plot.",
        df=df,
        how_to_analyze=_history_[0].repl_output,
    )
    plots.append(plot)

return plots
```
</div>

#### 基本性质

<div bg box>

invoke is the simplest loop that satisfies two defining properties: (1) the LLM can write arbitrary executable code that can include recursive invoke; (2) everything visible to the LLM — all inputs to invoke as well as its interaction history with the code environment — are variables in the code environment.
</div>

`invoke` 有两条基本性质：
- 模型返回的代码里可以继续调用 `invoke`，所以 subagent 是默认的，不需要额外设计多 agent 系统。
- 模型看到的所有东西，包括 input 和 history，全都是代码环境里的变量，所以模型可以用代码去引用它们、搜索它们、修改它们、把它们按引用传给下一个 `invoke`。

一个和先前范式的区别是，之前的实现也会把工具和数据塞进 REPL，但用户 prompt 和 REPL 历史通常只是作为消息列表展示给模型，模型不能以编程方式操作它们。JAZ 把它们变成了真正的变量。

### 递归 invoke

理论上，一个持续运行的 agent loop 可以表达成**尾递归**的 `invoke`：模型写完代码后不直接返回，而是尾递归调用 `invoke`，这样每个 sub-invoke 的上下文里都有完整历史，行为上等价于一个持续循环。

然而，Python 对尾递归不友好，会产生栈溢出，而且 LLM 缓存优化需要连续查询之间有精确的前缀关系。所以 JAZ **让 harness 自动完成这个尾递归调用，并做尾调用优化**，结果就是一个实际的 code-mode agent loop。

### JAZ

如果每个 `invoke` 都要显式传入所有工具，递归 sub-invokes 会很麻烦。

JAZ 提供 `scope` 原语，让变量自动传递给作用域内所有 `invoke` 调用，包括递归的 sub-invokes。典型用法：

```py
with scope(web_search=web_search):
    invoke(task="Use subagents to find 100 agent framework papers.")
```

#### Hooks

<div info>

`invoke` 原语本身非常小：模型写代码，代码在 REPL 里执行，递归调用 `invoke`。但实际使用 agent 时，用户需要记录 agent 的轨迹，进行资源控制和验证等。JAZ 把它们做成 hook，让用户按需启用。
</div>

JAZ 的 hook 系统允许在 agent 生命周期的特定事件点注入 hook，hook 不能任意修改 agent 状态，只能发出静态可组合的 effect。四类内置 hook 包括：

```py
#== Observability ==
  PrintLogger, FileLogger, TrajectoryDirectoryRecorder, TrajectoryRecorder, LangfuseTracing, JaegerTracing
#== Resumability ==
  TrajectoryRecorder, TrajectoryReplay
#== Resource control ==
  BudgetPool, IterationLimit, RecursionLimit, BudgetForcing, ContextWindowWarning
#== Validation ==
  ReturnType, ValidateReturn, ValidateRePLCode
```

JAZ 收集所有 effect，统一组合后再应用。这样设计是为了避免多个 hook 之间因为执行顺序不同而看到不一致的事件字段。

#### Configuration

JAZ 的配置有一个签名

```py
Config(llm: BaseLLM, repl: BaseREPL, protocol: BaseProtocol)
```

配置用哪个语言模型、哪个 REPL，以及从模型的原始响应中解析出代码和格式化 REPL 输出到 human-readable format 的 protocol。默认协议：

- 模型输出的全部内容都被当作代码。所以模型必须只输出代码，自然语言必须写成注释。
- REPL 输出太长时截断，不做额外格式化。

<div info>

不同层级的 agent 可能需要不同的模型或 REPL 配置，通过 scoped 设置默认值，再用 local 覆盖顶层，就能实现这种分层配置。尤其是在 CSI 中，如果所有 `invoke` 都用同一个模型，要么难以控制成本，要么会能力不足。
</div>

## Eval

### Case Study 1: Long-Horizon with Long-Range Recall

StuLife 包含 1284 个有序任务，模拟大学生一学期的活动。典型 episode 需要 7000–8000 次环境交互，code-mode agent 需要 3000–5000 次 LLM 调用。939 个任务被评分，其中 207 个需要 far recall（相隔超过 50 个任务的信息召回）。

当上下文窗口快满时，JAZ agent 被提示把剩余工作委托给一个 subagent，同时通过引用无损传递完整对话历史。

#### Takeaways

- 当 agent 在上下文中看到的一切都是 REPL 变量时，它可以按引用把内容传给 subagent，这比手动复制内容可靠。

- 领域专用 harness 编码了使其在许多情况下表现良好的假设，但在打破这些假设的环境中会变得僵化；对原始接口的完整编程访问可以恢复灵活性。

### Case Study 2: Continual Self-Improvement

<div info>

CSI 的种常见形式是 meta-agent / solver-agent 分离：meta-agent 优化 solver-agent 的各个方面（prompt、可执行技能、源代码）。

</div>

JAZ 的顶层 invoke 作为 meta-agent，控制传给 sub-invoke（solver）的所有输入。典型优化迭代的伪代码：

```py
instructions = "..."
def tool(...):
    answer, trajectory = invoke(
        task=get_next_task(),
        instructions=instructions,
        tool=tool,
    )
    eval_report = complete_task(answer)
    print(eval_report)
    print(trajectory)
```

引导顶层 agent 进行 CSI 的 prompt 描述了高层工作流。
- 用 subagent 分批解决任务，每任务一个 subagent call。
- 从小批量（~5 个任务）开始，分析结果，交替进行 prompt/tool 优化和验证。
- 不要解决任何任务——所有任务解决工作都由 subagent 完成。
- 只读失败任务的 trace 来诊断根因。
- 每个 prompt 编辑必须提炼出对许多任务通用的模式，不能针对单个任务的失败形态。
- 工具必须 100% 可靠，否则移除。

## Discussion

### Bitter Lesson

Rich Sutton 的 Bitter Lesson 指出：AI 研究中反复出现的模式是，**利用计算的一般性方法最终胜过编码了人类领域知识的方法**。在 agent 设计的语境下，这意味着：与其手工设计 memory system、self-improvement workflow、multi-agent orchestration，不如让一个足够强的模型在最小 harness 中自己学会这些行为。

这篇论文的实验支持了这个立场：JAZ invoke 没有 memory system，没有 meta-harness，只有 prompting，却超过了专门为这些能力设计的系统。

但有一个重要的 caveat：这个结论建立在 GPT-5.4 nano 这个特定模型的能力上。论文没有回答一个关键问题：如果模型更弱，invoke 的表达力是否仍然足够？ 换句话说，JAZ 的优越性是否部分来自于模型已经“足够聪明”到能理解并执行 tail-recursive delegation 和 meta-agent workflow？Bitter Lesson 的预测是，随着模型变强，这种优势会扩大，而不是缩小。但这个预测尚未被直接验证。

### `invoke` 的表达力

从计算理论角度，CodeAct 已经提供了图灵完备的表达力（模型可以写任意 Python 代码）。`invoke` 增加的不是计算能力，而是对 agent 自身上下文的编程访问。具体来说：

- RLM 让模型把输入 prompt 当作 Python 对象来操作（可以切片、搜索、递归调用）。但 RLM 的输入 prompt 通常是固定的文本块。

- JAZ invoke 让模型把所有输入和 REPL history 都当作 REPL 变量。这意味着模型可以对自己当前看到的上下文进行编程操作。

在 StuLife 任务 #1282 中，CodeAct + subagents 的失败是因为它无法按引用传递 user prompt，导致指令在多次 delegation 中丢失。JAZ 之所以成功，是因为 agent 可以访问 `_history_` 和 `prev_history` 变量，并对其进行搜索。

### `invoke` 的安全性问题

JAZ 的默认 REPL 限制 `import` 到 `re`、`collections`、`ast`、`datetime`、`textwrap`、`pprint`，禁止文件读写。但 `invoke `的递归性引入了一个新的攻击面：一个 sub-invoke 生成的代码可以调用 `invoke`，而这个 sub-invoke 的上下文可能包含敏感数据。在 scope 的动态作用域下，一个 scoped 的工具可能被所有递归 sub-invokes 自动访问，不管 sub-invoke 是否被信任。

