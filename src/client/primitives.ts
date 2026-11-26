import type { ReactElement } from 'react'
import { IconBranchOutlineRegular, IconPlusOutlineRegular, IconCheckOutlineRegular, IconCopyOutlineRegular, IconCloseOutlineRegular, IconSettingsOutlineMedium, IconChevronDownOutlineMedium, IconChevronUpOutlineMedium, IconSearchOutlineRegular, IconShareOutlineRegular, IconDataOutlineRegular, IconDatabaseOutlineRegular, IconClockOutlineRegular, IconGaugeOutlineRegular, IconCompareSplitOutlineRegular, IconBrowseOutlineRegular, IconFlatListOutlineRegular, IconAgentPresetOutlineRegular, IconFolderOpenOutlineRegular, IconWorkspaceTreeOutlineRegular, IconApiOutlineRegular, IconPluginPinwheelOutlineRegular, IconSkillOutlineRegular, IconSparkleRegular, FileTypeIcon } from '../../web/vendor/ui/index.js'
import type { IconProps } from '../../web/vendor/ui/index.js'

export type IconComponent = (props: IconProps) => ReactElement | null

const ns = { IconBranchOutlineRegular, IconPlusOutlineRegular, IconCheckOutlineRegular, IconCopyOutlineRegular, IconCloseOutlineRegular, IconSettingsOutlineMedium, IconChevronDownOutlineMedium, IconChevronUpOutlineMedium, IconSearchOutlineRegular, IconShareOutlineRegular, IconDataOutlineRegular, IconDatabaseOutlineRegular, IconClockOutlineRegular, IconGaugeOutlineRegular, IconCompareSplitOutlineRegular, IconBrowseOutlineRegular, IconFlatListOutlineRegular, IconAgentPresetOutlineRegular, IconFolderOpenOutlineRegular, IconWorkspaceTreeOutlineRegular, IconApiOutlineRegular, IconPluginPinwheelOutlineRegular, IconSkillOutlineRegular, IconSparkleRegular, FileTypeIcon } as unknown as Record<string, unknown>

function exportOf(name: string, source: Record<string, unknown>): unknown {
  try {
    return source[name]
  } catch {
    return undefined
  }
}

export function resolveIcon(name: string, source: Record<string, unknown> = ns): IconComponent {
  const found = exportOf(name, source)
  return typeof found === 'function' ? found as IconComponent : () => null
}

export const IconBranch = resolveIcon('IconBranchOutlineRegular')
export const IconPlus = resolveIcon('IconPlusOutlineRegular')
export const IconCheck = resolveIcon('IconCheckOutlineRegular')
export const IconCopy = resolveIcon('IconCopyOutlineRegular')
export const IconClose = resolveIcon('IconCloseOutlineRegular')
export const IconSettings = resolveIcon('IconSettingsOutlineMedium')
export const IconChevronDown = resolveIcon('IconChevronDownOutlineMedium')
export const IconChevronUp = resolveIcon('IconChevronUpOutlineMedium')
export const IconSearch = resolveIcon('IconSearchOutlineRegular')
export const IconShare = resolveIcon('IconShareOutlineRegular')
export const IconData = resolveIcon('IconDataOutlineRegular')
export const IconDatabase = resolveIcon('IconDatabaseOutlineRegular')
export const IconClock = resolveIcon('IconClockOutlineRegular')
export const IconGauge = resolveIcon('IconGaugeOutlineRegular')
export const IconBrowse = resolveIcon('IconBrowseOutlineRegular')
export const IconFlatList = resolveIcon('IconFlatListOutlineRegular')
export const IconCompareSplit = resolveIcon('IconCompareSplitOutlineRegular')
export const IconAgentPreset = resolveIcon('IconAgentPresetOutlineRegular')
export const IconFolderOpen = resolveIcon('IconFolderOpenOutlineRegular')
export const IconWorkspaceTree = resolveIcon('IconWorkspaceTreeOutlineRegular')
export const IconApi = resolveIcon('IconApiOutlineRegular')
export const IconPlugin = resolveIcon('IconPluginPinwheelOutlineRegular')
export const IconSkill = resolveIcon('IconSkillOutlineRegular')
export const IconSparkle = resolveIcon('IconSparkleRegular')

interface FileGlyphProps {
  path?: string
  kind?: string
  size?: number
  className?: string
}

type FileGlyphComponent = (props: FileGlyphProps) => ReactElement | null

export function resolveFileGlyph(source: Record<string, unknown> = ns): FileGlyphComponent {
  const found = exportOf('FileTypeIcon', source)
  return typeof found === 'function' ? found as FileGlyphComponent : () => null
}

export const FileTypeGlyph = resolveFileGlyph()
