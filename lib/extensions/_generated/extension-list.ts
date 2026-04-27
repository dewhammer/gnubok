// AUTO-GENERATED — do not edit. Run `npm run setup:extensions` to regenerate.
import type { Extension } from '../types'
import { enableBankingExtension } from '@/extensions/general/enable-banking'
import { emailExtension } from '@/extensions/general/email'
import { arcimMigrationExtension } from '@/extensions/general/arcim-migration'
import { ticExtension } from '@/extensions/general/tic'
import { mcpServerExtension } from '@/extensions/general/mcp-server'
import { cloudBackupExtension } from '@/extensions/general/cloud-backup'
import { invoiceInboxExtension } from '@/extensions/general/invoice-inbox'
import { aiAgentExtension } from '@/extensions/general/ai-agent'

export const FIRST_PARTY_EXTENSIONS: Extension[] = [
  enableBankingExtension,
  emailExtension,
  arcimMigrationExtension,
  ticExtension,
  mcpServerExtension,
  cloudBackupExtension,
  invoiceInboxExtension,
  aiAgentExtension,
]
