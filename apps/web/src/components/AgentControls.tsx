import { For, Show } from "solid-js";
import type { SessionModel } from "../session-model";
import type { ModelOption } from "../generated/protocol";

const modelKey = (model: ModelOption) => JSON.stringify([model.provider, model.id]);

/** Confirmed per-session model and reasoning controls. Options come from Pi's live capabilities. */
export function AgentControls(props: { model: SessionModel }) {
  const model = props.model;
  const selectedModel = () => model.state.settings.model ? modelKey(model.state.settings.model) : "";
  const missingModel = () => model.state.settings.model && !model.state.settings.models.some(option => modelKey(option) === selectedModel());
  return <div class="agent-controls" aria-label="Agent settings">
    <label class="model-control"><span class="sr-only">Model</span>
      <select aria-label="Model" title={model.state.settings.model?.provider ?? "Model unavailable"}
        disabled={!model.canConfigure() || !model.state.settings.models.length} value={selectedModel()}
        onChange={event => {
          const selected = model.state.settings.models.find(option => modelKey(option) === event.currentTarget.value);
          if (selected) model.setModel(selected.provider, selected.id);
          event.currentTarget.value = selectedModel();
        }}>
        <Show when={!model.state.settings.model}><option value="">Model unavailable</option></Show>
        <Show when={missingModel()}><option value={selectedModel()}>{model.state.settings.model?.name}</option></Show>
        <For each={model.state.settings.models}>{option => <option value={modelKey(option)}>{option.name} · {option.provider}</option>}</For>
      </select>
    </label>
    <label class="thinking-control"><span>Thinking</span>
      <select aria-label="Thinking level" disabled={!model.canConfigure() || !model.state.settings.thinkingLevels.length}
        value={model.state.settings.thinkingLevel ?? ""} onChange={event => {
          const selected = model.state.settings.thinkingLevels.find(level => level === event.currentTarget.value);
          if (selected) model.setThinkingLevel(selected);
          event.currentTarget.value = model.state.settings.thinkingLevel ?? "";
        }}>
        <Show when={model.state.settings.thinkingLevel === null}><option value="">Unavailable</option></Show>
        <Show when={model.state.settings.thinkingLevel !== null && !model.state.settings.thinkingLevels.includes(model.state.settings.thinkingLevel!)}>
          <option value={model.state.settings.thinkingLevel!}>{model.state.settings.thinkingLevel}</option>
        </Show>
        <For each={model.state.settings.thinkingLevels}>{level => <option value={level}>{level}</option>}</For>
      </select>
    </label>
    <Show when={model.online() && model.state.status.process === "ready" && model.state.settings.codexFast}>
      <span class="fast-status" aria-label="Codex fast status" title="Extension-reported routing preference; not confirmation from the provider.">{model.state.settings.codexFast}</span>
    </Show>
    <Show when={model.settingsPending()}><span class="settings-pending">Updating…</span></Show>
  </div>;
}
