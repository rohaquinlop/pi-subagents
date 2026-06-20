export interface AgentConfig {
    name: string;
    description: string;
    tools: string[];
    model: string;
    thinking: string;
    systemPrompt: string;
    filePath: string;
    subagentAgents?: string[];
}
