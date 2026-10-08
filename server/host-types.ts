import type { PluginHookContext, PluginLifecycleEvents } from "@getpaseo/plugin/server";

export type PaseoApi = PluginHookContext["paseo"];
export type PaseoAgent = NonNullable<ReturnType<ReturnType<PaseoApi["agents"]["ref"]>["current"]>>;
export type AgentTimelineItem = PluginLifecycleEvents["agent.turn_ended"]["timeline"][number];
