import {
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import {
  DETAIL_OPTIONS,
  DISPLAY_OPTIONS,
  type SectionProps,
  STRICTNESS_OPTIONS,
  TRIGGER_OPTIONS,
} from "./settings-options";
import { SettingsStepper, type StepperField } from "./settings-stepper";

const MAX_INSTRUCTIONS = 2000;

const COUNT_FIELDS: readonly StepperField[] = [
  {
    setting: "contextBudgetChars",
    label: "Memory budget",
    hint: "The most characters of memory a new agent receives.",
  },
  { setting: "maxPinned", label: "Pinned memories", hint: "The most pinned memories a new agent receives." },
  {
    setting: "taskMatches",
    label: "Task matches",
    hint: "Memories that match the first message, or the agent title, branch and folder. They appear under Relevant to this task.",
  },
  {
    setting: "projectMemories",
    label: "Project memories",
    hint: "Recent memories from this project that a new agent receives.",
  },
  {
    setting: "globalMemories",
    label: "Global memories",
    hint: "Recent global memories that a new agent receives.",
  },
  {
    setting: "recentSessions",
    label: "Recent sessions",
    hint: "Summaries of recent sessions in this project that a new agent receives.",
  },
];

export function StartingMemorySection({ values, save, theme }: SectionProps) {
  return (
    <SettingsSection title="Starting memory" info="Changes apply to new agents without a restart.">
      <SettingsCard>
        <SettingsSwitch
          label="Inject memory at start"
          hint="New agents start with pinned memories, task matches and recent work for this project."
          value={values.injectContext}
          onValueChange={(injectContext) => save({ injectContext })}
        />
        <SettingsSwitch
          label="Memory tools"
          hint="Lets agents search and save memories during a chat."
          value={values.injectMcp}
          onValueChange={(injectMcp) => save({ injectMcp })}
        />
      </SettingsCard>
      <SettingsCard>
        {COUNT_FIELDS.map((field) => (
          <SettingsStepper key={field.setting} {...field} values={values} save={save} theme={theme} />
        ))}
        <SettingsSelect
          label="Task match strictness"
          hint="How close a memory must be to the task to count as a match."
          value={values.taskStrictness}
          options={STRICTNESS_OPTIONS}
          onValueChange={(taskStrictness) => save({ taskStrictness })}
        />
        <SettingsSelect
          label="Detail"
          hint="Titles only, or titles with a short summary. Pinned memories always include their text."
          value={values.detailLevel}
          options={DETAIL_OPTIONS}
          onValueChange={(detailLevel) => save({ detailLevel })}
        />
        <SettingsInput
          label="Extra instructions"
          hint="Added to the memory instructions that every new agent receives."
          initialValue={values.extraInstructions}
          onChangeText={(text) => save({ extraInstructions: text.slice(0, MAX_INSTRUCTIONS) })}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

export function SessionReviewSection({ values, save, theme }: SectionProps) {
  const shared = { values, save, theme };
  return (
    <SettingsSection title="Session review">
      <SettingsCard>
        <SettingsSwitch
          label="Record session summaries"
          hint="Keeps a summary of each session so later agents see recent work."
          value={values.autoCapture}
          onValueChange={(autoCapture) => save({ autoCapture })}
        />
        <SettingsSelect
          label="Review the session"
          hint="Asks the agent to save what it learned. A review uses one turn and some of the agent's context."
          value={values.reviewTrigger}
          options={TRIGGER_OPTIONS}
          onValueChange={(reviewTrigger) => save({ reviewTrigger })}
        />
        {values.reviewTrigger === "idle" ? (
          <SettingsStepper
            setting="reviewIdleMinutes"
            label="Idle minutes"
            hint="Minutes without activity before a review starts."
            {...shared}
          />
        ) : null}
        {values.reviewTrigger === "turns" ? (
          <SettingsStepper
            setting="reviewEveryTurns"
            label="Turns between reviews"
            hint="How many turns pass between reviews."
            {...shared}
          />
        ) : null}
        <SettingsStepper
          setting="reviewMaxMemories"
          label="Memories per review"
          hint="The most memories one review can save or update."
          {...shared}
        />
        <SettingsSelect
          label="Review in chat"
          hint="How the review appears in the chat."
          value={values.reviewDisplay}
          options={DISPLAY_OPTIONS}
          onValueChange={(reviewDisplay) => save({ reviewDisplay })}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
