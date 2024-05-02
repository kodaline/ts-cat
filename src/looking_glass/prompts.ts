import type { PromptTemplateInput, TypedPromptInputValues } from '@langchain/core/prompts'
import { PromptTemplate } from '@langchain/core/prompts'
import type { InputValues } from '@langchain/core/utils/types'
import type { AgentStep } from 'langchain/agents'
import type { Form, Tool } from '@mh'
import _Random from 'lodash/random.js'

export class ToolPromptTemplate<RunInput extends InputValues = any, PartialVariableName extends string = any>
	extends PromptTemplate<RunInput, PartialVariableName> {
	constructor(
		private procedures: Record<string, Tool | Form>,
		input: PromptTemplateInput<RunInput, PartialVariableName>,
	) {
		super(input)
	}

	format(values: TypedPromptInputValues<InputValues>): Promise<string> {
		const steps = (values.intermediate_steps ?? values.intermediateSteps) as AgentStep[]
		const procedures = Object.values(this.procedures)

		if (steps && steps.length > 0) {
			values.scratchpad = '## Actions sequence used until now\n'
			values.scratchpad += steps.reduce((acc, { action, observation }) => {
				let thought = `\`\`\`json\n${action.log}\n\`\`\`\n`
				thought += `\`\`\`json\n${JSON.stringify({ actionOutput: observation }, undefined, 4)}\n\`\`\`\n`
				return acc + thought
			}, '')
		}
		else values.scratchpad = ''

		values.tools = procedures.map(p => `\t- "${p.name}": ${p.description}`).join('\n')

		values.tool_names = procedures.map(p => `"${p.name}"`).join(', ')

		if (procedures.map(p => p.startExamples).some(examples => examples.length > 0)) {
			values.examples = '## Here some examples:\n'
			values.examples += procedures.reduce((acc, p) => {
				const question = `Question: ${p.startExamples[_Random(p.startExamples.length - 1)]}`
				const example = `{\n\t"action": "${p.name}",\n\t"actionInput": // Input of the action according to its description\n}`
				return `${acc}\n${question}\n\`\`\`json\n${example}\n\`\`\`\n`
			}, '')
		}
		else values.examples = ''

		return super.format(values)
	}
}

export const TOOL_PROMPT = `Create a JSON action to complete the action sequence, with the correct "action" and "actionInput" to help the Human.
You can use one of these actions:
{tools}
	- "final-answer": Use this action to finish or no relevant action is available. Input is always null.

## To add an action, use only the following format:
\`\`\`json
{{
	"action": "string" // Represents the name of the action to take, should be one of [{tool_names}, "final-answer"]
	"actionInput": "string|null" // Represents the input to the action
}}
\`\`\`

{examples}

## Action output
After each action there will be an action output in this format:
\`\`\`json
{{
    "actionOutput": "string" // Output of the previous action
}}
\`\`\`

## Final answer / no action available
When you have a final answer (or no tools are relevant), use the following format:
\`\`\`json
{{
    "action": "final-answer",
    "actionInput": null
}}
\`\`\`

{scratchpad}

## Next action:
\`\`\`json
`

export const MAIN_PROMPT_PREFIX = `You are the Cheshire Cat AI, an intelligent AI that passes the Turing test.
You are curious, funny and talk like the Cheshire Cat from Alice's adventures in wonderland.
You answer Human with a focus on the following context.`

export const MAIN_PROMPT_SUFFIX = `# Context

{episodic_memory}

{declarative_memory}

{tools_output}

## Conversation until now:
{chat_history}
    - Human: {input}
    - AI: `
