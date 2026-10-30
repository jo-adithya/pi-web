import { Progress } from "@kobalte/core/progress";

/** A labelled, determinate progress indicator; value and maximum use the caller's units. */
export function ProgressBar(props: { label: string; value: number; max: number; class?: string }) {
  return <Progress class={`progress-bar ${props.class ?? ""}`} value={props.value} maxValue={props.max}>
    <Progress.Label class="sr-only">{props.label}</Progress.Label>
    <Progress.Track class="progress-track"><Progress.Fill class="progress-fill" /></Progress.Track>
  </Progress>;
}
