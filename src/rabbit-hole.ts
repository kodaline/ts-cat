import { basename, extname, resolve } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { PDFLoader } from '@langchain/community/document_loaders/fs/pdf'
import { CSVLoader } from '@langchain/community/document_loaders/fs/csv'
import { DocxLoader } from '@langchain/community/document_loaders/fs/docx'
import { PPTXLoader } from '@langchain/community/document_loaders/fs/pptx'
import { TextLoader } from 'langchain/document_loaders/fs/text'
import { JSONLoader } from 'langchain/document_loaders/fs/json'
import type { BaseDocumentLoader } from 'langchain/document_loaders/base'
import { CheerioWebBaseLoader } from '@langchain/community/document_loaders/web/cheerio'
import { getEncoding } from 'js-tiktoken'
import type { TextSplitter } from 'langchain/text_splitter'
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter'
import { Document } from '@langchain/core/documents'
import { destr } from 'destr'
import type { StrayCat } from '@lg/stray-cat.ts'
import { cheshireCat } from '@lg/cheshire-cat.ts'
import { madHatter } from '@mh/mad-hatter.ts'
import { log } from '@logger'
import type { MemoryJson } from '@dto/vector-memory.ts'
import { db } from './database.ts'
import { sleep } from './utils.ts'

export type WebParser = [RegExp, new (content: string) => BaseDocumentLoader]

export type FileParsers = Record<`${string}/${string}`, new (content: string | Blob) => BaseDocumentLoader>

export class RabbitHole {
	private static instance: RabbitHole
	private splitter: TextSplitter
	private webHandlers: WebParser[] = [
		[/^.*$/g, CheerioWebBaseLoader],
	]

	private fileHandlers: FileParsers = {
		'text/csv': CSVLoader,
		'text/plain': TextLoader,
		'text/markdown': TextLoader,
		'application/pdf': PDFLoader,
		'application/json': JSONLoader,
		'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': CSVLoader,
		'application/vnd.openxmlformats-officedocument.wordprocessingml.document': DocxLoader,
		'application/vnd.openxmlformats-officedocument.presentationml.presentation': PPTXLoader,
	}

	private constructor() {
		this.fileHandlers = madHatter.executeHook('fileParsers', this.fileHandlers)
		this.webHandlers = madHatter.executeHook('webParsers', this.webHandlers)
		this.splitter = madHatter.executeHook('textSplitter', new RecursiveCharacterTextSplitter({
			separators: ['\\n\\n', '\n\n', '.\\n', '.\n', '\\n', '\n', ' ', ''],
			keepSeparator: true,
			lengthFunction: text => getEncoding('cl100k_base').encode(text).length,
		}))
	}

	/**
	 * Get the Rabbit Hole instance
	 * @returns The Rabbit Hole class as a singleton
	 */
	static getInstance() {
		if (!RabbitHole.instance) {
			log.silent('Initializing the Rabbit Hole...')
			RabbitHole.instance = new RabbitHole()
		}
		return RabbitHole.instance
	}

	/**
	 * Get the file parsers
	 */
	get fileParsers() {
		return { ...this.fileHandlers }
	}

	/**
	 * Get the web parsers
	 */
	get webParsers() {
		return [...this.webHandlers]
	}

	/**
	 * Upload memories to the declarative memory from a JSON file.
	 * When doing this, please, make sure the embedder used to export the memories is the same as the one used when uploading.
	 * The method also performs a check on the dimensionality of the embeddings (i.e. length of each vector).
	 * @param json the json object containing the memories to be ingested.
	 */
	async ingestMemory(json: File | MemoryJson) {
		log.info('Ingesting memory...')
		let content: MemoryJson

		if (json instanceof File) {
			if (json.type !== 'application/json') {
				log.error('The file is not a JSON file. Skipping ingestion...')
				throw new Error('The file is not a valid JSON file.')
			}
			content = destr(await json.text())
		}
		else content = json

		if (!content.embedder || content.embedder !== db.data.selectedEmbedder) {
			log.error('The embedder used to export the memories is different from the one currently used.')
			return
		}

		const declarativeMemories = content.collections.declarative
		const vectors = declarativeMemories.map(m => m.vector)

		log.info(`Preparing to load ${vectors.length} vector memories...`)

		if (vectors.some(v => v.length !== cheshireCat.embedderSize)) {
			log.error('The dimensionality of the embeddings is not consistent with the current embedder.')
			return
		}

		await cheshireCat.currentMemory.collections.declarative.addPoints(declarativeMemories)
	}

	/**
	 * Ingests textual content into the memory.
	 * @param stray The StrayCat instance.
	 * @param content The textual content to ingest.
	 * @param source The source of the content (default: 'unknown').
	 */
	async ingestContent(stray: StrayCat, content: string | string[], source = 'unknown') {
		log.info('Ingesting textual content...')
		content = Array.isArray(content) ? content : [content]
		let docs = content.map(c => new Document({ pageContent: c }))
		docs = await this.splitDocs(stray, docs)
		await this.storeDocuments(stray, docs, source)
	}

	/**
	 * Ingests a file and processes its content.
	 * @param stray The StrayCat instance.
	 * @param file The file to ingest.
	 * @param chunkSize The size of each chunk for splitting the content.
	 * @param chunkOverlap The overlap between chunks.
	 * @throws An error if the file type is not supported.
	 */
	async ingestFile(stray: StrayCat, file: File, chunkSize?: number, chunkOverlap?: number) {
		const mime = file.type as keyof typeof this.fileHandlers
		if (!Object.keys(this.fileHandlers).includes(mime))
			throw new Error(`The file type "${file.type}" is not supported. Skipping ingestion...`)

		log.info('Ingesting file...')
		const loader = new this.fileHandlers[mime]!(file)
		stray.send({ type: 'notification', content: 'Parsing the content. Big content could require some minutes...' })
		const content = await loader.load()
		stray.send({ type: 'notification', content: 'Parsing completed. Starting now the reading process...' })
		const docs = await this.splitDocs(stray, content, chunkSize, chunkOverlap)
		await this.storeDocuments(stray, docs, file.name)
	}

	/**
	 * Ingests a path or URL and processes the content.
	 * If the input is a URL, it uses a web handler to load the content.
	 * If the input is a file system path, it reads the file and processes the content.
	 * @param stray The StrayCat instance.
	 * @param path The path or URL to ingest.
	 * @param chunkSize The size of each chunk for splitting the content.
	 * @param chunkOverlap The overlap between chunks.
	 * @throws If the URL doesn't match any web handler or the path doesn't exist.
	 */
	async ingestPathOrURL(stray: StrayCat, path: string, chunkSize?: number, chunkOverlap?: number) {
		try {
			const url = new URL(path)
			log.info('Ingesting URL...')
			const webHandler = this.webHandlers.find(([regex]) => regex.test(url.href))
			if (!webHandler) throw new Error(`No matching regex found for "${path}". Skipping URL ingestion...`)
			const loader = new webHandler[1](url.href)
			stray.send({ type: 'notification', content: 'Parsing the content. Big content could require some minutes...' })
			const content = await loader.load()
			stray.send({ type: 'notification', content: 'Parsing completed. Starting now the reading process...' })
			const docs = await this.splitDocs(stray, content, chunkSize, chunkOverlap)
			await this.storeDocuments(stray, docs, url.href)
		}
		catch (error) {
			if (error instanceof TypeError) log.info('The string is not a valid URL, trying with a file-system path...')
			else if (error instanceof Error) log.error(error.message)
			if (!existsSync(path)) throw new Error('The path does not exist. Skipping ingestion...')
			const data = readFileSync(resolve(path))
			const file = new File([data], basename(path), { type: extname(path) })
			await this.ingestFile(stray, file, chunkSize, chunkOverlap)
		}
	}

	/**
	 * Stores the given documents in memory.
	 * The method also executes the beforeStoreDocuments and beforeInsertInMemory hooks.
	 * It sends a websocket notification of the progress and when the reading process is completed
	 * @param stray The StrayCat instance.
	 * @param docs An array of documents to store.
	 * @param source The source of the documents.
	 */
	async storeDocuments(stray: StrayCat, docs: Document[], source: string) {
		log.info(`Preparing to store ${docs.length} documents`)
		docs = madHatter.executeHook('beforeStoreDocuments', docs, stray)
		for (let [i, doc] of docs.entries()) {
			const index = i + 1
			const percRead = Math.round((index / docs.length) * 100)
			const readMsg = `Read ${percRead}% of ${source}`
			stray.send({ type: 'notification', content: readMsg })
			log.info(readMsg)
			doc.metadata.source = source
			doc.metadata.when = Date.now()
			doc = madHatter.executeHook('beforeInsertInMemory', doc, stray)
			if (doc.pageContent) {
				const docEmbedding = await cheshireCat.currentEmbedder.embedDocuments([doc.pageContent])
				if (docEmbedding.length === 0) {
					log.warn(`Skipped memory insertion of empty document (${index}/${docs.length})`)
					continue
				}
				await cheshireCat.currentMemory.collections.declarative.addPoint(
					doc.pageContent,
					docEmbedding[0]!,
					doc.metadata,
				)
			}
			else log.warn(`Skipped memory insertion of empty document (${index}/${docs.length})`)
			doc = madHatter.executeHook('afterInsertInMemory', doc, stray)
			await sleep(500)
		}
		docs = madHatter.executeHook('afterStoreDocuments', docs, stray)
		stray.send({ type: 'notification', content: `Finished reading ${source}. I made ${docs.length} thoughts about it.` })
		log.info(`Done uploading ${source}`)
	}

	/**
	 * Splits an array of texts into smaller chunks and creates documents.
	 * The method also executes the beforeSplitTexts and afterSplitTexts hooks.
	 * @param stray The StrayCat instance.
	 * @param docs The array of documents to be split.
	 * @param chunkSize The size of each chunk for splitting the content (default: 256).
	 * @param chunkOverlap The overlap between chunks (default: 64).
	 * @returns An array of documents.
	 */
	async splitDocs(stray: StrayCat, docs: Document[], chunkSize?: number, chunkOverlap?: number) {
		docs = madHatter.executeHook('beforeSplitDocs', docs, stray)
		this.splitter.chunkSize = chunkSize ??= db.data.chunkSize
		this.splitter.chunkOverlap = chunkOverlap ??= db.data.chunkOverlap
		log.info('Splitting documents with chunk size', chunkSize, 'and overlap', chunkOverlap)
		docs = (await this.splitter.splitDocuments(docs)).filter(d => d.pageContent.length > 10)
		docs = madHatter.executeHook('afterSplitDocs', docs, stray)
		return docs
	}
}

/**
 * Manages content ingestion. I'm late... I'm late!
 */
export const rabbitHole = await RabbitHole.getInstance()
