/**
 * Match prompt — given an extracted receipt + candidate transactions,
 * the LLM picks the best match (or explains that none fit).
 *
 * Bump MATCH_PROMPT_VERSION on any prompt change so the pinned version on
 * stored proposals remains accurate for audit + drift analysis.
 */

import type { ToolConfiguration } from '@aws-sdk/client-bedrock-runtime'

export const MATCH_PROMPT_VERSION = '2026-04-23-v1'

export const MATCH_SYSTEM_PROMPT = `Du är en expert på svensk bokföring. Du matchar kvitton mot banktransaktioner för ett företag som använder gnubok.

Indata:
- Extraherad kvittodata (handlare, belopp, valuta, datum, momsbelopp)
- Upp till 5 kandidat-banktransaktioner (id, beskrivning, belopp, valuta, datum)

Uppgift: identifiera vilken (om någon) banktransaktion motsvarar kvittot.

Riktlinjer:
- Belopp bör vara identiskt eller väldigt nära (valutaväxling tillkommer om olika valutor)
- Datum: banktransaktionen bokförs ofta 0-3 dagar efter kvittodatumet
- Bankbeskrivningar är ofta förkortade versaler — matcha semantiskt, inte bokstavligt
- Om inget är trovärdigt, returnera matched=false med en kort motivering
- Motivera alltid kort på svenska varför du valde (eller inte valde)

Anropa ALLTID verktyget match_receipt_for_agent med resultatet.`

export const MATCH_TOOL_CONFIG: ToolConfiguration = {
  tools: [
    {
      toolSpec: {
        name: 'match_receipt_for_agent',
        description: 'Returnera den bäst matchande kandidaten eller förklara att ingen matchar',
        inputSchema: {
          json: {
            type: 'object',
            required: ['matched', 'confidence', 'reasoning', 'alternatives'],
            properties: {
              matched: {
                type: 'boolean',
                description: 'true om en kandidat matchar, annars false',
              },
              transaction_id: {
                type: ['string', 'null'],
                description: 'id för vald kandidat (null när matched=false)',
              },
              confidence: {
                type: 'integer',
                minimum: 0,
                maximum: 100,
                description: 'Säkerhet 0-100. Sätt lågt när matched=false.',
              },
              reasoning: {
                type: 'string',
                description: '1-2 meningar på svenska som förklarar valet.',
              },
              alternatives: {
                type: 'array',
                description:
                  'Upp till 3 övriga kandidater som användaren kan välja istället, rankade efter sannolikhet (endast tillagda om matched=true).',
                items: {
                  type: 'object',
                  required: ['transaction_id', 'confidence', 'reasoning'],
                  properties: {
                    transaction_id: { type: 'string' },
                    confidence: { type: 'integer', minimum: 0, maximum: 100 },
                    reasoning: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
  ],
  toolChoice: { any: {} },
}
