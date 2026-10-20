// The ask_control tool's card: the control's question and its rows, the answer ticked once it is
// given (here or in another pane), and an Answer button while it waits. The sheet the user answers
// in is controls/sheet.tsx; this card is what stays in the transcript.

import type { JSX } from '@stencil-hq/tern'

import type { ToolCall } from '../../../model.js'
import { type FastControl, type Intent, rowsOf } from '../../../vendor/ripple/index.js'
import { namedStep } from '../steps.js'
import type { Card, ToolView } from '../types.js'

import { genericCard } from './generic.js'

/** The ask_control tool's view. */
export const controlView: ToolView<'ask_control'> = {
  action: 'other',
  card: (call, d) => (d.control ? controlCard(call, d.control, call.controlAnswer) : genericCard(call, NO_FIELDS, { name: 'ask', title: 'Ask' })),
  hubIcon: 'sliders',
  step: namedStep
}

/** A refused control reads as the generic card: its error, nothing of the args. */
const NO_FIELDS = { prompt: undefined, query: undefined, question: undefined, said: undefined, url: undefined }

/** Whether row `id` is (one of) the answer. */
const picked = (answer: Intent | undefined, id: string) =>
  answer !== undefined && (Array.isArray(answer.value) ? answer.value.includes(id) : answer.value === id)

function controlCard(call: ToolCall, control: FastControl, answer: Intent | undefined): Card {
  const body: JSX.Element[] =
    control.kind === 'slider'
      ? [
          <text
            key="range"
            spans={[
              { s: 'muted', t: `${control.min}–${control.max}${control.unit ? ` ${control.unit}` : ''}` },
              ...(answer ? [{ s: 'success', t: `  ✓ ${answer.label ?? String(answer.value)}` }] : [])
            ]}
            wrap="none"
          />
        ]
      : rowsOf(control).map((r, i) => (
          <row key={`o${i}`} role={picked(answer, r.id) ? 'omp.tool.answer' : 'omp.tool.answer.off'}>
            <text key="c" spans={[picked(answer, r.id) ? { s: 'success', t: '✓' } : { s: 'dim', t: String(i + 1) }]} />
            <text key="t" spans={[{ t: r.label }]} />
          </row>
        ))

  const waiting = !answer && call.outcome.kind === 'done'

  if (waiting) {
    body.push(
      <row align="center" gap="sm" key="foot">
        <text grow={1} key="hint" spans={[{ s: 'muted', t: 'Waiting for your answer.' }]} wrap="word" />
        <row actions={{ click: `control-open=${call.id}` }} align="center" key="go" role="hermes.control.open">
          <text key="t" text="Answer" />
        </row>
      </row>
    )
  }

  return {
    body,
    name: 'ask',
    target: control.prompt,
    targetKind: 'text',
    title: 'Ask'
  }
}
