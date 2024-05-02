import { z } from 'zod'
import { AgentActionOutputParser } from 'langchain/agents'
import type { AgentAction, AgentFinish } from 'langchain/schema'
import { madHatter } from '@mh'
import { log } from '@logger'
import { parseJson } from '@utils'
import { OutputParserException } from '@langchain/core/output_parsers'

const agentOutputSchema = z.object({
	action: z.string(),
	actionInput: z.string().nullish().transform((v) => {
		if (typeof v === 'string') {
			const str = v.trim().replace(/^['"]|['"]$/g, '').replace(/(None|undefined)/g, 'null')
			return str === 'null' ? null : str
		}
		return null
	}),
})

type AgentOutput = z.infer<typeof agentOutputSchema>

export class ProceduresOutputParser extends AgentActionOutputParser {
	lc_namespace = ['looking_glass', 'procedures-output-parser']

	async parse(output: string): Promise<AgentFinish | AgentAction> {
		let parsedOutput: AgentOutput

		try {
			parsedOutput = await parseJson(output, agentOutputSchema)
		}
		catch (error) {
			log.error(`Could not parse LLM output: ${output}`)
			throw new OutputParserException(`Could not parse LLM output: ${output}`)
		}

		const parsedLog = JSON.stringify(parsedOutput, null, 4)

		const { action, actionInput } = parsedOutput

		if (action === 'final-answer') {
			return {
				log: parsedLog,
				returnValues: {
					output: null,
				},
			}
		}

		const form = madHatter.forms.find(f => f.name === action)

		if (form) {
			return {
				log: parsedLog,
				returnValues: {
					output: null,
					form: action,
				},
			}
		}

		return {
			log: parsedLog,
			tool: action,
			toolInput: actionInput ?? {},
		}
	}

	getFormatInstructions() {
		return `{
            "action": "string",
			"actionInput": "string" // or null if not needed
        }`
	}
}
