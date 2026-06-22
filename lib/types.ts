export interface AgentConfig {
    name: string;
    description: string;
    tools: string[];
    model: string;
    thinking: string;
    systemPrompt: string;
    filePath: string;
    subagentAgents?: string[];
    connector?: string;  // Single-line prompt template, e.g. "## Findings\n\n{output}"
}

export interface AgentUsage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    turns: number;
}

export interface PipelineStep {
    agent: string;
    task: string;  // May contain {previous} placeholder
    connector?: string;  // Override agent's default connector for this step
}

export interface PipelineStepResult {
    agent: string;
    task: string;
    output: string;
    exitCode: number;
    usage: AgentUsage;
    durationMs: number;
}

export interface PipelineResult {
    steps: PipelineStepResult[];
    currentStep?: number;  // Present during live execution updates
    finalOutput: string;
    stoppedAt?: number;  // 0-indexed step where pipeline stopped (on error)
    error?: string;  // Error message if pipeline failed
    totalUsage: AgentUsage;
    totalDurationMs: number;
}

export interface LoopIterationResult {
    iteration: number;
    output: string;
    exitCode: number;
    usage: AgentUsage;
    durationMs: number;
    judgeVerdict?: { satisfied: boolean; response: string };  // Present when judge is configured
}

export interface LoopResult {
    iterations: LoopIterationResult[];
    currentIteration?: number;  // Present during live execution updates
    finalOutput: string;
    stoppedBecause: "max_iterations" | "judge_satisfied" | "error";
    totalUsage: AgentUsage;
    totalDurationMs: number;
}
