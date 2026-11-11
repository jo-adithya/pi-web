import { createSignal, onSettled, Show } from "solid-js";
import { Checkbox } from "@kobalte/core/checkbox";
import { TextField } from "@kobalte/core/text-field";
import { SelectField } from "./components/SelectField";
import { Icon } from "./components/Icon";
import type { SessionModel } from "./session-model";
import type { ThemePreference } from "./theme";
import type { GroupOptions } from "./review-costs";
import type { ResponseModel } from "./generated/protocol";
import "./settings.css";

/** Server-confirmed preferences shared by all conversations and connected devices. */
export interface GroupingPreferences {
  options: () => GroupOptions;
  setOptions: (next: GroupOptions) => void;
  disabled: () => boolean;
  status: () => string;
}
/** Saved response model shared by all workspaces and devices. */
export interface ResponsePreferences {
  model: () => ResponseModel;
  setModel: (model: ResponseModel) => void;
  disabled: () => boolean;
  status: () => string;
}
interface SettingsPageProps {
  model?: SessionModel;
  grouping?: GroupingPreferences;
  response?: ResponsePreferences;
  theme: ThemePreference;
  setTheme: (value: ThemePreference) => void;
}

/** Edits browser appearance and server-wide AI preferences; opening makes no requests. */
export function SettingsPage(props: SettingsPageProps) {
  let heading!: HTMLHeadingElement;
  onSettled(() => heading.focus());
  return <section class="settings-page" aria-labelledby="settings-title">
    <header class="studio-page-heading"><span class="page-heading-label"><Icon name="settings" />Make yourself at home</span><h1 id="settings-title" tabindex={-1} ref={heading}>Settings</h1><p>A few thoughtful adjustments. A workspace that works for you.</p></header>
    <section class="settings-section" aria-labelledby="appearance-title">
      <div><h2 id="appearance-title">Appearance</h2><p>Saved in this browser for all conversations.</p></div>
      <SelectField class="settings-field" visibleLabel label="Color scheme" value={props.theme}
        options={[{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]}
        change={value => { if (value === "system" || value === "light" || value === "dark") props.setTheme(value); }} />
    </section>
    <section class="settings-section" aria-labelledby="response-settings-title">
      <div><h2 id="response-settings-title">Simple responses</h2><p>Always on. Each completed answer is simplified with this model. Shared across all workspaces and devices. Changes apply to new formatting calls; running calls keep their model.</p></div>
      <Show when={props.response} fallback={<p class="settings-help">Connect to load the simple response model.</p>}><ResponseSettings response={props.response!} model={props.model} /></Show>
    </section>
    <section class="settings-section" aria-labelledby="review-settings-title">
      <div><h2 id="review-settings-title">AI review</h2><p>Saved on this server for all workspaces, conversations, and devices. Changes apply to new runs; active runs keep their starting settings.</p></div>
      <Show when={props.grouping} fallback={<p class="settings-help">Connect to load global AI review settings.</p>}><ReviewSettings grouping={props.grouping!} model={props.model} /></Show>
    </section>
  </section>;
}

/** Selects a configured text model without changing the coding model or making an inference call. */
function ResponseSettings(props: { response: ResponsePreferences; model?: SessionModel }) {
  const value = () => JSON.stringify(props.response.model());
  const available = () => props.model?.state.settings.models ?? [];
  const key = (model: ResponseModel) => JSON.stringify({ provider: model.provider, id: model.id });
  return <div class="settings-review">
    <SelectField class="settings-field" visibleLabel label="Simple response model" disabled={props.response.disabled()} value={value()}
      description="Uses Pi’s existing credentials. Adds a separate model call; private details in the answer are sent to this provider. The coding model stays unchanged."
      options={[
        ...(!available().some(model => key(model) === value()) ? [{ value: value(), label: `${props.response.model().id} · ${props.response.model().provider} · currently unavailable`, disabled: true }] : []),
        ...available().map(model => ({ value: key(model), label: `${model.name} · ${model.provider}` })),
      ]} change={selected => {
        const model = available().find(model => key(model) === selected);
        if (model) props.response.setModel({ provider: model.provider, id: model.id });
      }} />
    <p class="settings-help" role="status">{props.response.status()}</p>
  </div>;
}

/** Saves global preferences without changing chat models or launching AI work. */
function ReviewSettings(props: { grouping: GroupingPreferences; model?: SessionModel }) {
  const grouping = props.grouping;
  const [limitError, setLimitError] = createSignal("");
  const modelValue = () => grouping.options().model ? JSON.stringify(grouping.options().model) : "";
  const available = () => props.model?.state.settings.models ?? [];
  const modelKey = (model: { provider: string; id: string }) => JSON.stringify({ provider: model.provider, id: model.id });
  return <div class="settings-review">
    <fieldset disabled={grouping.disabled()}>
      <legend class="sr-only">AI review preferences</legend>
      <SelectField class="settings-field" visibleLabel label="Grouping model" disabled={grouping.disabled()} value={modelValue()}
        description="A separate model for grouping changed files. Same as chat uses each conversation’s model; chat models stay unchanged."
        options={[
          { value: "", label: `Same as chat${props.model?.state.settings.model ? ` (${props.model.state.settings.model.name})` : ""}` },
          ...(grouping.options().model && !available().some(model => modelKey(model) === modelValue()) ? [{ value: modelValue(), label: `${grouping.options().model?.id} · currently unavailable`, disabled: true }] : []),
          ...available().map(model => ({ value: modelKey(model), label: `${model.name} · ${model.provider}` })),
        ]} change={value => {
          const model = available().find(model => modelKey(model) === value);
          grouping.setOptions({ ...grouping.options(), model: model ? { provider: model.provider, id: model.id } : undefined });
        }} />
      <div class="settings-limits">
        <TextField class="settings-field" value={String(grouping.options().maxCalls)} required disabled={grouping.disabled()} validationState={limitError() ? "invalid" : "valid"}>
          <TextField.Label>Maximum AI calls</TextField.Label>
          <TextField.Input type="number" min="1" max="100" step="1" aria-invalid={limitError() ? "true" : "false"} onChange={event => {
            if (!event.currentTarget.checkValidity()) { setLimitError("Enter a whole number from 1 to 100. The previous limit is still active."); return; }
            setLimitError(""); grouping.setOptions({ ...grouping.options(), maxCalls: event.currentTarget.valueAsNumber });
          }} />
          <TextField.Description class="field-description">{limitError() || "Maximum requests in one grouping run."}</TextField.Description>
        </TextField>
        <SelectField class="settings-field" visibleLabel label="Total request limit" disabled={grouping.disabled()} value={String(grouping.options().maxRequestBytes)}
          options={[[128 * 1024, "128 KiB"], [512 * 1024, "512 KiB"], [2 * 1024 * 1024, "2 MiB"], [16 * 1024 * 1024, "16 MiB"]].map(([value, label]) => ({ value: String(value), label: String(label) }))}
          description="Includes data sent again in later requests." change={value => grouping.setOptions({ ...grouping.options(), maxRequestBytes: Number(value) })} />
      </div>
      <Checkbox class="settings-check" disabled={grouping.disabled()} checked={grouping.options().includeGenerated} onChange={checked => grouping.setOptions({ ...grouping.options(), includeGenerated: checked })}>
        <Checkbox.Input /><Checkbox.Control class="checkbox-control"><Checkbox.Indicator>✓</Checkbox.Indicator></Checkbox.Control>
        <div><Checkbox.Label>Include generated / lockfile contents</Checkbox.Label><Checkbox.Description class="field-description">Off saves context. These files still appear in Changes.</Checkbox.Description></div>
      </Checkbox>
    </fieldset>
    <p class="settings-help" role="status">{grouping.status()}</p>
    <p class="settings-help">Limits reduce work, but are not a dollar cap. Usage and available cost estimates appear beside the result in Changes.</p>
  </div>;
}
