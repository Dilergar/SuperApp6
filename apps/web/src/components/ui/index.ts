// ============================================================
// UI-кит SuperApp6 — единственный источник примитивов интерфейса.
//
// Правило (DESIGN.md §7): страницам ЗАПРЕЩЕНО рисовать свои кнопки, поля,
// модалки и чипы. Не хватает — расширяется кит, а не заводится копия.
// Каталог со всеми состояниями — страница /dev/ui (только в разработке).
//
// Импорт: import { Button, Modal, Chip } from '@/components/ui';
// ============================================================
export { Icon, EmojiIcon, ICONS, type IconName, type IconProps } from './Icon';
export { Button, IconButton, type ButtonProps, type ButtonVariant, type ButtonSize } from './Button';
export { Field, Input, Textarea, SearchField, type InputProps, type TextareaProps } from './Input';
export { Select, type SelectOption, type SelectProps } from './Select';
export { Toggle, Checkbox, type ToggleProps, type CheckboxProps } from './Toggle';
export { Chip, Badge, StatusDot, type ChipProps } from './Chip';
export { Card, CardHeader, PageHeader, StatTile, EmptyState, Divider, BentoGrid, type CardProps } from './Card';
export { TickBar, GradientTickBar, type TickBarProps } from './TickBar';
export { Modal, ConfirmDialog, type ModalProps, type ModalSize } from './Modal';
export { ModalShell, type ModalShellProps } from './ModalShell';
export { Menu, type MenuAction, type MenuProps } from './Menu';
export { Tooltip } from './Tooltip';
export { Tabs, SegmentedControl, type TabItem } from './Tabs';
export { Pagination } from './Pagination';
export { Calendar, DatePicker, type DatePickerProps } from './DatePicker';
export { Dropzone, type DropzoneProps } from './Dropzone';
export { Alert, type AlertProps } from './Alert';
export { Spinner, LoadingBlock, Skeleton, AvatarStack } from './Feedback';
export { toneVars, TONE_BASE, cx, type Tone } from './tones';
export { usePopover } from './usePopover';
