import { afterAll } from 'vitest'
import type { Site } from './site'
import { DATA_KEY } from './machines'
import { ToolCallParsers } from '../../../../backend/src/models/services/ToolCallParsers'
import { chatTemplatesOverHttp } from '../../../../backend/src/models/services/ChatTemplates'
import { savedHuggingFaceTokenOf } from '../../../../backend/src/infrastructure/services/hugging-face-token'
import { startHuggingFaceStandIn, type HuggingFaceStandIn, type StandInModel } from '../../../../backend/src/models/testing/hugging-face-stand-in'

export interface ToolCalling {
  parsers: ToolCallParsers
  huggingFace: HuggingFaceStandIn
}

export async function toolCallParsersOn({ db }: Site, models: Record<string, StandInModel>): Promise<ToolCalling> {
  const huggingFace = await startHuggingFaceStandIn(models)
  afterAll(() => huggingFace.close())
  const parsers = new ToolCallParsers({ store: db.models, templates: chatTemplatesOverHttp(huggingFace.url), savedToken: savedHuggingFaceTokenOf(db.accounts, DATA_KEY) })
  return { parsers, huggingFace }
}
