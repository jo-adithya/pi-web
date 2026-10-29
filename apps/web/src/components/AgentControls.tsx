import { SelectField } from "./SelectField";
import { Show } from "solid-js";
import type { SessionModel } from "../session-model";
import type { ModelOption } from "../generated/protocol";

const modelKey = (model: ModelOption) => JSON.stringify([model.provider, model.id]);

/** Confirmed per-session model and reasoning controls. Options come from Pi's live capabilities. */
export function AgentControls(props: { model: SessionModel }) {
  const model = props.model;
  const selectedModel = () => model.state.settings.model ? modelKey(model.state.settings.model) : "";
  const missingModel = () => model.state.settings.model && !model.state.settings.models.some(option => modelKey(option) === selectedModel());
  return <div class="agent-controls" aria-label="Agent settings">
    <SelectField class="model-control" label="Model" title={model.state.settings.model?.provider ?? "Model unavailable"}
      disabled={!model.canConfigure() || !model.state.settings.models.length} value={selectedModel()} placeholder="Model unavailable"
      options={[
        ...(missingModel() ? [{ value: selectedModel(), label: model.state.settings.model!.name, disabled: true }] : []),
        ...model.state.settings.models.map(option => ({ value: modelKey(option), label: `${option.name}${option.provider === "openai-codex" ? "" : ` · ${option.provider}`}` })),
      ]} change={value => {
        const selected = model.state.settings.models.find(option => modelKey(option) === value);
        if (selected) model.setModel(selected.provider, selected.id);
      }} />
    <div class="thinking-control"><SelectField label="Thinking level" disabled={!model.canConfigure() || !model.state.settings.thinkingLevels.length}
      value={model.state.settings.thinkingLevel ?? ""} placeholder="Unavailable"
      options={[
        ...(model.state.settings.thinkingLevel !== null && !model.state.settings.thinkingLevels.includes(model.state.settings.thinkingLevel) ? [{ value: model.state.settings.thinkingLevel, label: model.state.settings.thinkingLevel, disabled: true }] : []),
        ...model.state.settings.thinkingLevels.map(level => ({ value: level, label: level })),
      ]} change={value => {
        const selected = model.state.settings.thinkingLevels.find(level => level === value);
        if (selected) model.setThinkingLevel(selected);
      }} /></div>
    <Show when={model.online() && model.state.status.process === "ready" && model.state.settings.codexFast}>
      <span class="fast-status" aria-label="Codex fast status" title="Extension-reported routing preference; not confirmation from the provider.">{model.state.settings.codexFast === "codex fast (requested)" ? "fast" : model.state.settings.codexFast}</span>
    </Show>
    <Show when={model.settingsPending()}><span class="settings-pending">Updating…</span></Show>
  </div>;
}
