import { createSignal, onSettled, Show } from "solid-js";
import { Checkbox } from "@kobalte/core/checkbox";
import { TextField } from "@kobalte/core/text-field";
import { SelectField } from "./components/SelectField";
import type { SessionModel } from "./session-model";
import type { ThemePreference } from "./theme";
import "./settings.css";

interface SettingsPageProps {
  model?: SessionModel;
  conversation: string;
  theme: ThemePreference;
  setTheme: (value: ThemePreference) => void;
}

/** Edits browser appearance and the selected conversation's in-memory review preferences; opening makes no requests. */
export function SettingsPage(props: SettingsPageProps) {
  let heading!: HTMLHeadingElement;
  onSettled(() => heading.focus());
  return <section class="settings-page" aria-labelledby="settings-title">
    <header><h1 id="settings-title" tabindex={-1} ref={heading}>Settings</h1><p>Make Pi Web work the way you review.</p></header>
    <section class="settings-section" aria-labelledby="appearance-title">
      <div><h2 id="appearance-title">Appearance</h2><p>Saved in this browser for all conversations.</p></div>
      <SelectField class="settings-field" visibleLabel label="Color scheme" value={props.theme}
        options={[{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]}
        change={value => { if (value === "system" || value === "light" || value === "dark") props.setTheme(value); }} />
    </section>
    <section class="settings-section" aria-labelledby="review-settings-title">
      <div><h2 id="review-settings-title">AI review</h2><p><Show when={props.model} fallback="Select a conversation to configure AI review.">For <strong>{props.conversation}</strong>. These choices last until this page is reloaded.</Show></p></div>
      <Show when={props.model} keyed>{model => <ReviewSettings model={model} />}</Show>
    </section>
  </section>;
}

/** Updates idle grouping preferences without changing chat's model or launching a paid run. */
function ReviewSettings(props: { model: SessionModel }) {
  const grouping = props.model.review.grouping;
  const [limitError, setLimitError] = createSignal("");
  const modelValue = () => grouping.options().model ? JSON.stringify(grouping.options().model) : "";
  const available = () => props.model.state.settings.models;
  const modelKey = (model: { provider: string; id: string }) => JSON.stringify({ provider: model.provider, id: model.id });
  return <div class="settings-review">
    <fieldset disabled={grouping.busy()}>
      <legend class="sr-only">AI review preferences</legend>
      <SelectField class="settings-field" visibleLabel label="Grouping model" disabled={grouping.busy()} value={modelValue()}
        description="A separate model for grouping changed files. Your chat model stays unchanged."
        options={[
          { value: "", label: `Same as chat${props.model.state.settings.model ? ` (${props.model.state.settings.model!.name})` : ""}` },
          ...(grouping.options().model && !available().some(model => modelKey(model) === modelValue()) ? [{ value: modelValue(), label: `${grouping.options().model?.id} · currently unavailable`, disabled: true }] : []),
          ...available().map(model => ({ value: modelKey(model), label: `${model.name} · ${model.provider}` })),
        ]} change={value => {
          const model = available().find(model => modelKey(model) === value);
          grouping.setOptions({ ...grouping.options(), model: model ? { provider: model.provider, id: model.id } : undefined });
        }} />
      <div class="settings-limits">
        <TextField class="settings-field" defaultValue={String(grouping.options().maxCalls)} required disabled={grouping.busy()} validationState={limitError() ? "invalid" : "valid"}>
          <TextField.Label>Maximum AI calls</TextField.Label>
          <TextField.Input type="number" min="1" max="100" step="1" aria-invalid={limitError() ? "true" : "false"} onChange={event => {
            if (!event.currentTarget.checkValidity()) { setLimitError("Enter a whole number from 1 to 100. The previous limit is still active."); return; }
            setLimitError(""); grouping.setOptions({ ...grouping.options(), maxCalls: event.currentTarget.valueAsNumber });
          }} />
          <TextField.Description class="field-description">{limitError() || "Maximum requests in one grouping run."}</TextField.Description>
        </TextField>
        <SelectField class="settings-field" visibleLabel label="Total request limit" disabled={grouping.busy()} value={String(grouping.options().maxRequestBytes)}
          options={[[128 * 1024, "128 KiB"], [512 * 1024, "512 KiB"], [2 * 1024 * 1024, "2 MiB"], [16 * 1024 * 1024, "16 MiB"]].map(([value, label]) => ({ value: String(value), label: String(label) }))}
          description="Includes data sent again in later requests." change={value => grouping.setOptions({ ...grouping.options(), maxRequestBytes: Number(value) })} />
      </div>
      <Checkbox class="settings-check" disabled={grouping.busy()} checked={grouping.options().includeGenerated} onChange={checked => grouping.setOptions({ ...grouping.options(), includeGenerated: checked })}>
        <Checkbox.Input /><Checkbox.Control class="checkbox-control"><Checkbox.Indicator>✓</Checkbox.Indicator></Checkbox.Control>
        <div><Checkbox.Label>Include generated / lockfile contents</Checkbox.Label><Checkbox.Description class="field-description">Off saves context. These files still appear in Changes.</Checkbox.Description></div>
      </Checkbox>
    </fieldset>
    <p class="settings-help" role="status">{grouping.busy() ? "Grouping is running. Wait or cancel it in Changes before editing these settings." : "Changes apply immediately. AI runs only when you ask it to group files in Changes."}</p>
    <p class="settings-help">Limits reduce work, but are not a dollar cap. Usage and available cost estimates appear beside the result in Changes.</p>
  </div>;
}
