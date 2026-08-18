// ============================================================
// UI-кит SuperApp6 — единственный источник примитивов интерфейса.
//
// Правило (DESIGN.md §7): страницам ЗАПРЕЩЕНО рисовать свои кнопки, поля,
// модалки и чипы. Не хватает — расширяется кит, а не заводится копия.
// Каталог со всеми состояниями — страница /dev/ui (только в разработке).
//
// Импорт: import { Button, Modal, Chip } from '@/components/ui';
// ============================================================
export { Icon, ICONS, type IconName, type IconProps } from './Icon';
export { Glyph, EmojiIcon, type GlyphProps, type EmojiIconProps } from './Glyph';
export { GlyphPicker, GlyphField, GlyphPickerButton, type GlyphPickerProps, type GlyphFieldProps } from './GlyphPicker';
export {
  parseGlyph, hexToChar, charToHex, fluentUrl, GLYPH_PREFIX,
  type ParsedGlyph,
} from './glyph-data';
export { Button, IconButton, CloseChip, type ButtonProps, type ButtonVariant, type ButtonSize } from './Button';
export { Field, Input, Textarea, SearchField, type InputProps, type TextareaProps } from './Input';
export { Select, type SelectOption, type SelectProps } from './Select';
export { Toggle, Checkbox, type ToggleProps, type CheckboxProps } from './Toggle';
export { Chip, Badge, StatusDot, type ChipProps } from './Chip';
export { Card, CardHeader, PageHeader, StatTile, EmptyState, Divider, BentoGrid, type CardProps } from './Card';
export { TickBar, GradientTickBar, type TickBarProps } from './TickBar';
export { Modal, ConfirmDialog, type ModalProps, type ModalSize } from './Modal';
export { useConfirm, type ConfirmOptions } from './useConfirm';
export { ModalShell, type ModalShellProps } from './ModalShell';
export { Menu, type MenuAction, type MenuProps } from './Menu';
export { Tooltip } from './Tooltip';
export { Tabs, SegmentedControl, type TabItem } from './Tabs';
export { Pagination } from './Pagination';
export { Calendar, DatePicker, type DatePickerProps } from './DatePicker';
export { Dropzone, type DropzoneProps } from './Dropzone';
export {
  TableHeader,
  TableRow,
  TableCell,
  type TableColumn,
  type TableHeaderProps,
  type TableRowProps,
  type TableCellProps,
} from './Table';
export { Alert, type AlertProps } from './Alert';
export { Spinner, LoadingBlock, Skeleton, AvatarStack } from './Feedback';
export { toneVars, TONE_BASE, cx, type Tone } from './tones';
export { usePopover } from './usePopover';
